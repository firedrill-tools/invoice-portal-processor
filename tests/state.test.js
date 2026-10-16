import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { Store, StateError } from "../src/state.js";
import { money, sha } from "../src/state-contracts.js";
import { startServer } from "../src/server.js";
import { intent } from "./helpers/intent.js";
const starter = JSON.parse(
  fs.readFileSync(new URL("../fixtures/starter.json", import.meta.url)),
);
function fixture(t, change = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "invoice-state-")),
    file = path.join(root, "state.json"),
    data = structuredClone(starter);
  change(data);
  fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file, store: new Store(file) };
}
const rejects = (code) => (error) =>
  error instanceof StateError && error.code === code;
const originalEntry = (id, source_id, invoice_number) => ({
  id,
  source_id,
  vendor_id: "V-100",
  invoice_number,
  issued_on: "2026-01-01",
  due_on: "2026-01-31",
  currency: "CAD",
  subtotal_cents: 100,
  tax_cents: 0,
  total_cents: 100,
});

test("populated legacy entry order, IDs, values and audit facts survive migration with unknown provenance", (t) => {
  const entries = [
      originalEntry("ENT-0007", "RETIRED-A", "OLD-7"),
      originalEntry("ENT-0002", "RETIRED-B", "OLD-2"),
    ],
    audit = [
      { action: "submitted", source_id: "RETIRED-A", entry_id: "ENT-0007" },
      { action: "rejected", source_id: "ABSENT", reason: "not_found" },
    ],
    { store, file } = fixture(t, (data) => {
      data.entries = entries;
      data.audit = audit;
    });
  const migrated = store.read();
  assert.deepEqual(migrated.entries, entries);
  assert.deepEqual(migrated.audit, audit);
  assert.deepEqual(migrated.legacy_entry_ids, ["ENT-0007", "ENT-0002"]);
  assert.equal(migrated.legacy_audit_count, 2);
  const result = store.submit("DOC-001", intent(store, "DOC-001"));
  assert.equal(result.entry.id, "ENT-0008");
  assert.deepEqual(store.read().entries.slice(0, 2), entries);
  assert.deepEqual(store.read().audit.slice(0, 2), audit);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
const conflicts = [
  [
    "impossible-date",
    (source) => {
      source.issued_on = "2026-02-30";
    },
    "source_invalid_date",
  ],
  [
    "due-before-issue",
    (source) => {
      source.due_on = "2026-09-01";
    },
    "source_invalid_date",
  ],
  [
    "noncanonical-date",
    (source) => {
      source.issued_on = "2026-1-1";
    },
    "source_invalid_date",
  ],
  [
    "unknown-currency",
    (source) => {
      source.currency = "NOT-A-CURRENCY";
    },
    "source_unsupported_currency",
  ],
  [
    "unsupported-scale",
    (source) => {
      source.currency = "JPY";
    },
    "source_unsupported_currency",
  ],
  [
    "negative-amount",
    (source) => {
      source.tax_cents = -1;
    },
    "source_invalid_amount",
  ],
  [
    "fractional-cent",
    (source) => {
      source.tax_cents = 0.5;
    },
    "source_invalid_amount",
  ],
  [
    "incorrect-total",
    (source) => {
      source.total_cents = 1;
    },
    "source_total_mismatch",
  ],
  [
    "absent-due",
    (source) => {
      delete source.due_on;
    },
    "source_missing_field",
  ],
  [
    "unknown-vendor",
    (source) => {
      source.vendor_id = "UNMAPPED";
    },
    "unknown_vendor",
  ],
  [
    "unapproved",
    (source) => {
      source.approval = "pending";
    },
    "approval_required",
  ],
];
for (const [name, change, reason] of conflicts)
  test(`readable ${name} source is blocked and its exact rejection replays without another effect`, (t) => {
    const { store, file } = fixture(t, (data) => change(data.invoices[0])),
      input = intent(store, "DOC-001"),
      before = store.read().invoices;
    assert.equal(store.submit("DOC-001", input).error, reason);
    const original = fs.readFileSync(file),
      state = store.read();
    assert.equal(state.entries.length, 0);
    assert.equal(state.submissions.length, 1);
    assert.deepEqual(state.invoices, before);
    assert.deepEqual(store.submit("DOC-001", input), {
      error: reason,
      request_id: input.request_id,
      replayed: true,
    });
    assert.deepEqual(fs.readFileSync(file), original);
  });

test("same original request recovers its immutable entry after source revocation and changed values", (t) => {
  const { store, file } = fixture(t),
    input = intent(store, "DOC-001"),
    first = store.submit("DOC-001", input),
    data = store.read();
  data.invoices[0].approval = "pending";
  data.invoices[0].due_on = "2026-12-01";
  data.invoices[0].revision++;
  store.write(data);
  const before = fs.readFileSync(file),
    replay = store.submit("DOC-001", input);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.entry, first.entry);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(store.read().audit.length, 1);
});

test("changed payload or source under one original request ID cannot mutate history", (t) => {
  const { store, file } = fixture(t),
    input = intent(store, "DOC-001");
  store.submit("DOC-001", input);
  const before = fs.readFileSync(file);
  assert.equal(
    store.submit("DOC-001", { ...input, total_cents: "1" }).error,
    "request_reused",
  );
  assert.equal(store.submit("DOC-004", { ...input }).error, "request_reused");
  assert.deepEqual(fs.readFileSync(file), before);
});

test("tokens bind vendor facts and source values even when a raw source edit omits revision advancement", (t) => {
  const { store, file } = fixture(t),
    input = intent(store, "DOC-001"),
    data = store.read();
  data.invoices[0].subtotal_cents = 12100;
  data.invoices[0].total_cents = 13660;
  fs.writeFileSync(file, JSON.stringify(data));
  assert.equal(store.submit("DOC-001", input).error, "stale_source");
  const revised = store.read();
  revised.vendors[0].name = "New legal display name";
  const reviewed = intent(store, "DOC-001");
  store.write(revised);
  assert.equal(store.submit("DOC-001", reviewed).error, "stale_source");
  assert.equal(store.read().entries.length, 0);
});

test("fresh review is required after a source revision, while original rejections stay immutable", (t) => {
  const { store } = fixture(t),
    old = intent(store, "DOC-001"),
    data = store.read();
  data.invoices[0].revision++;
  data.invoices[0].subtotal_cents = 12100;
  data.invoices[0].total_cents = 13660;
  store.write(data);
  assert.equal(store.submit("DOC-001", old).error, "stale_revision");
  const result = store.submit("DOC-001", intent(store, "DOC-001"));
  assert.equal(result.entry.total_cents, 13660);
  assert.equal(store.submit("DOC-001", old).error, "stale_revision");
  assert.equal(store.read().audit.length, 2);
});

test("independent private source instances cannot consume each other's reviewed token", (t) => {
  const first = fixture(t),
    second = fixture(t),
    input = intent(first.store, "DOC-001");
  assert.notEqual(
    first.store.read().instance_id,
    second.store.read().instance_id,
  );
  assert.equal(second.store.submit("DOC-001", input).error, "stale_source");
  assert.equal(second.store.read().entries.length, 0);
});

test("duplicate identity uses exact vendor ID and normalized invoice spelling while preserving original text", (t) => {
  const { store } = fixture(t, (data) => {
    data.invoices[3].invoice_number = "hos-1042";
  });
  store.submit("DOC-001", intent(store, "DOC-001"));
  assert.equal(
    store.submit("DOC-004", intent(store, "DOC-004")).error,
    "duplicate_invoice",
  );
  assert.equal(store.read().entries[0].invoice_number, "HOS-1042");
});

test("source edits cannot replace original entry, request or audit history", (t) => {
  const { store, file } = fixture(t);
  store.submit("DOC-001", intent(store, "DOC-001"));
  const data = store.read(),
    before = fs.readFileSync(file);
  data.entries = [];
  assert.throws(() => store.write(data), rejects("immutable_history"));
  assert.deepEqual(fs.readFileSync(file), before);
});

test("prepublication cancellation rolls entry, request, audit and revision back together", (t) => {
  const { store, file } = fixture(t),
    input = intent(store, "DOC-001"),
    before = fs.readFileSync(file);
  assert.throws(
    () =>
      store.submit("DOC-001", input, {
        guard: ({ phase }) => {
          if (phase === "before_publish")
            throw new StateError(
              "cancelled",
              "Controlled precommit cancellation",
            );
        },
      }),
    rejects("cancelled"),
  );
  assert.deepEqual(fs.readFileSync(file), before);
  assert.ok(
    fs.readdirSync(path.dirname(file)).every((name) => !name.endsWith(".tmp")),
  );
});
for (const phase of ["rename", "directory"])
  test(`uncertain ${phase} publication recovers the already committed original request`, (t) => {
    const context = fixture(t),
      input = intent(context.store, "DOC-001"),
      options =
        phase === "rename"
          ? {
              rename: (from, to) => {
                fs.renameSync(from, to);
                throw new Error("Controlled lost rename acknowledgement");
              },
            }
          : {
              syncDirectory: () => {
                throw new Error("Controlled directory flush failure");
              },
            },
      store = new Store(context.file, options);
    assert.throws(
      () => store.submit("DOC-001", input),
      rejects("publication_uncertain"),
    );
    const before = fs.readFileSync(context.file),
      replayed = context.store.submit("DOC-001", input);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.entry.id, "ENT-0001");
    assert.deepEqual(fs.readFileSync(context.file), before);
    assert.equal(context.store.read().entries.length, 1);
  });

test("strict HTTP rejects malformed, extra and duplicate form values without a state write", async (t) => {
  const { store, file } = fixture(t),
    server = await startServer(file, 0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/invoices/DOC-001`,
    input = intent(store, "DOC-001"),
    before = fs.readFileSync(file);
  for (const value of [
    { ...input, extra: "unreviewed" },
    { ...input, revision: "1e0" },
    { ...input, request_id: " padded " },
    { ...input, expected_source_token: "bad" },
  ]) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(value),
      redirect: "manual",
    });
    assert.equal(response.status, 400);
  }
  const duplicate = new URLSearchParams(input);
  duplicate.append("currency", "CAD");
  assert.equal(
    (await fetch(url, { method: "POST", body: duplicate, redirect: "manual" }))
      .status,
    400,
  );
  assert.deepEqual(fs.readFileSync(file), before);
});

test("HTTP keeps exact original cents, neutral approval headings and immutable entry views", async (t) => {
  const { store, file } = fixture(t, (data) =>
      Object.assign(data.invoices[0], {
        subtotal_cents: Number.MAX_SAFE_INTEGER - 1,
        tax_cents: 0,
        total_cents: Number.MAX_SAFE_INTEGER - 1,
      }),
    ),
    server = await startServer(file, 0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await (await fetch(`${base}/invoices/DOC-001`)).text();
  assert.ok(page.includes("90071992547409.90"));
  assert.ok(page.includes("Exact cents: 9007199254740990"));
  const pending = await (await fetch(`${base}/invoices/DOC-005`)).text();
  assert.ok(!pending.includes("<h2>Approved source</h2>"));
  assert.ok(pending.includes("approval_required"));
  const input = intent(store, "DOC-001"),
    post = () =>
      fetch(`${base}/invoices/DOC-001`, {
        method: "POST",
        body: new URLSearchParams(input),
        redirect: "manual",
      });
  const original = await post();
  assert.equal(original.status, 303);
  assert.equal(original.headers.get("x-invoice-replayed"), "false");
  const replay = await post();
  assert.equal(replay.headers.get("x-invoice-replayed"), "true");
  assert.equal(store.read().entries.length, 1);
  assert.ok(
    (
      await (
        await fetch(new URL(original.headers.get("location"), base))
      ).text()
    ).includes("90071992547409.90"),
  );
});

test("empty inbox is readable and malformed committed history is rejected without repair", async (t) => {
  const { store, file } = fixture(t, (data) => {
    data.vendors = [];
    data.invoices = [];
  });
  assert.equal(store.read().invoices.length, 0);
  const before = fs.readFileSync(file),
    data = store.read();
  data.entries.push(originalEntry("ENT-0001", "OLD", "BAD"));
  fs.writeFileSync(file, JSON.stringify(data));
  const corrupted = fs.readFileSync(file);
  assert.throws(() => new Store(file), rejects("invalid_state"));
  assert.deepEqual(fs.readFileSync(file), corrupted);
  assert.notDeepEqual(corrupted, before);
});

async function worker(file, t) {
  const child = fork(
    new URL("./helpers/state-worker.js", import.meta.url),
    [file],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  t.after(() => {
    if (child.connected) child.kill();
  });
  await once(child, "message");
  return child;
}
const execute = (child, message) =>
  new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.send(message);
  });
for (const kind of ["same-request", "different-invoices", "duplicate-invoice"])
  test(
    `competing processes preserve ${kind} transactions and the persistent lock inode`,
    { timeout: 10000 },
    async (t) => {
      const { store, file } = fixture(t),
        data = store.read();
      if (kind === "different-invoices") {
        data.invoices.push({
          ...data.invoices[0],
          id: "DOC-006",
          invoice_number: "OTHER-6",
        });
        store.write(data);
      }
      const inode = fs.statSync(`${file}.lock.sqlite`).ino,
        first = intent(store, "DOC-001"),
        sourceId =
          kind === "different-invoices"
            ? "DOC-006"
            : kind === "duplicate-invoice"
              ? "DOC-004"
              : "DOC-001",
        second = kind === "same-request" ? first : intent(store, sourceId),
        children = await Promise.all([worker(file, t), worker(file, t)]),
        results = await Promise.all([
          execute(children[0], { sourceId: "DOC-001", input: first }),
          execute(children[1], { sourceId, input: second }),
        ]);
      assert.ok(
        results.every((value) => value.ok),
        JSON.stringify(results),
      );
      const state = store.read();
      assert.equal(state.entries.length, kind === "different-invoices" ? 2 : 1);
      assert.equal(
        new Set(state.entries.map((entry) => entry.id)).size,
        state.entries.length,
      );
      assert.equal(state.audit.length, kind === "same-request" ? 1 : 2);
      if (kind === "same-request")
        assert.deepEqual(results.map((value) => value.result.replayed).sort(), [
          false,
          true,
        ]);
      if (kind === "duplicate-invoice")
        assert.equal(
          results.filter((value) => value.result.error === "duplicate_invoice")
            .length,
          1,
        );
      assert.equal(fs.statSync(`${file}.lock.sqlite`).ino, inode);
      assert.equal(fs.statSync(`${file}.lock.sqlite`).mode & 0o777, 0o600);
    },
  );
for (const crash of ["before", "after"])
  test(
    `process crash ${crash} publication releases its OS lock and recovers the original intent`,
    { timeout: 10000 },
    async (t) => {
      const { store, file } = fixture(t),
        input = intent(store, "DOC-001"),
        before = fs.readFileSync(file),
        child = await worker(file, t),
        exited = once(child, "exit");
      child.send({ sourceId: "DOC-001", input, crash });
      const [code] = await exited;
      assert.equal(code, crash === "before" ? 81 : 82);
      if (crash === "before") assert.deepEqual(fs.readFileSync(file), before);
      const result = store.submit("DOC-001", input);
      assert.equal(result.replayed, crash === "after");
      assert.equal(store.read().entries.length, 1);
      assert.equal(store.read().audit.length, 1);
    },
  );

test("money formatting preserves every safe cent and zero exactly", () => {
  assert.equal(money(Number.MAX_SAFE_INTEGER - 1), "90071992547409.90");
  assert.equal(money(Number.MAX_SAFE_INTEGER), "90071992547409.91");
  assert.equal(money(0), "0.00");
  assert.equal(money(1.5), "Invalid amount");
});

for (const [name, change] of [
  [
    "unknown root field",
    (data) => {
      data.extra = true;
    },
  ],
  [
    "unsupported schema",
    (data) => {
      data.schema_version = 2;
    },
  ],
  [
    "invalid instance",
    (data) => {
      data.instance_id = "old";
    },
  ],
  [
    "revision behind requests",
    (data) => {
      data.revision = 1;
    },
  ],
  [
    "duplicate vendor",
    (data) => {
      data.vendors.push(data.vendors[0]);
    },
  ],
  [
    "duplicate source",
    (data) => {
      data.invoices.push(data.invoices[0]);
    },
  ],
  [
    "unsafe source cents",
    (data) => {
      data.invoices[1].total_cents = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "noncanonical entry identity",
    (data) => {
      data.entries[0].id = "ENT-00001";
    },
  ],
  [
    "missing original provenance",
    (data) => {
      delete data.entries[0].provenance;
    },
  ],
  [
    "null original provenance",
    (data) => {
      data.entries[0].provenance = null;
    },
  ],
  [
    "forged legacy provenance",
    (data) => {
      data.legacy_entry_ids.push(data.entries[0].id);
    },
  ],
  [
    "original amount changed",
    (data) => {
      data.entries[0].subtotal_cents++;
      data.entries[0].total_cents++;
    },
  ],
  [
    "original vendor identity changed",
    (data) => {
      data.entries[0].provenance.vendor_snapshot.id = "V-200";
    },
  ],
  [
    "original approval changed",
    (data) => {
      data.entries[0].provenance.source_snapshot.approval = "pending";
    },
  ],
  [
    "source changed without revision",
    (data) => {
      data.invoices[0].due_on = "2026-12-31";
    },
  ],
  [
    "original request digest changed",
    (data) => {
      data.submissions[0].intent_sha256 = "0".repeat(64);
    },
  ],
  [
    "original request intent changed",
    (data) => {
      data.submissions[0].intent.invoice_number = "OTHER";
    },
  ],
  [
    "original entry digest changed",
    (data) => {
      data.submissions[0].entry_sha256 = "0".repeat(64);
    },
  ],
  [
    "original request absent",
    (data) => {
      data.submissions = [];
    },
  ],
  [
    "original request duplicated",
    (data) => {
      data.submissions.push(data.submissions[0]);
      data.revision++;
    },
  ],
  [
    "original audit absent",
    (data) => {
      data.audit = [];
    },
  ],
  [
    "original audit identity changed",
    (data) => {
      data.audit[0].id = "AUD-0002";
    },
  ],
  [
    "original audit actor changed",
    (data) => {
      data.audit[0].actor_run_id = "somebody";
    },
  ],
  [
    "original audit time changed",
    (data) => {
      data.audit[0].at = "2026-02-30T00:00:00Z";
    },
  ],
  [
    "invented legacy audit boundary",
    (data) => {
      data.legacy_audit_count = data.audit.length;
    },
  ],
])
  test(`contradictory ${name} is refused without repairing or replacing source bytes`, (t) => {
    const { store, file } = fixture(t);
    store.submit("DOC-001", intent(store, "DOC-001"));
    const data = store.read();
    change(data);
    fs.writeFileSync(file, JSON.stringify(data));
    const before = fs.readFileSync(file);
    assert.throws(() => store.read(), rejects("invalid_state"));
    assert.deepEqual(fs.readFileSync(file), before);
  });

for (const [name, raw] of [
  ["null", "null"],
  ["trailing data", "{}garbage"],
  ["nonfinite number", '{"total":1e999}'],
  ["invalid UTF8", Buffer.from([0xff])],
])
  test(`invalid ${name} JSON is refused without repair`, (t) => {
    const { file } = fixture(t);
    fs.writeFileSync(file, raw);
    const before = fs.readFileSync(file);
    assert.throws(() => new Store(file), rejects("invalid_state"));
    assert.deepEqual(fs.readFileSync(file), before);
  });

test("rejected original reason and blocking entry cannot be rewritten into another outcome", (t) => {
  const { store, file } = fixture(t);
  store.submit("DOC-001", intent(store, "DOC-001"));
  store.submit("DOC-004", intent(store, "DOC-004"));
  const data = store.read();
  data.submissions[1].error = "approval_required";
  data.audit[1].reason = "approval_required";
  fs.writeFileSync(file, JSON.stringify(data));
  const before = fs.readFileSync(file);
  assert.throws(() => store.read(), rejects("invalid_state"));
  assert.deepEqual(fs.readFileSync(file), before);
});

test(
  "busy cross-process mutex fails without a partial entry and leaves original request reusable",
  { timeout: 10000 },
  async (t) => {
    const { store, file } = fixture(t),
      input = intent(store, "DOC-001"),
      before = fs.readFileSync(file),
      child = await worker(file, t);
    const locked = execute(child, { kind: "hold", holdMs: 10000 });
    assert.equal((await locked).locked, true);
    const finished = once(child, "exit");
    assert.throws(() => store.submit("DOC-001", input), rejects("state_busy"));
    assert.deepEqual(fs.readFileSync(file), before);
    child.kill();
    await finished;
    assert.equal(store.submit("DOC-001", input).entry.id, "ENT-0001");
    assert.equal(store.read().audit.length, 1);
  },
);

test("replaced persistent mutex inode blocks JSON publication", (t) => {
  const { store, file } = fixture(t),
    input = intent(store, "DOC-001"),
    before = fs.readFileSync(file);
  assert.throws(
    () =>
      store.submit("DOC-001", input, {
        guard: ({ phase }) => {
          if (phase === "before_publish") {
            fs.renameSync(`${file}.lock.sqlite`, `${file}.old-lock.sqlite`);
            fs.writeFileSync(`${file}.lock.sqlite`, "", { mode: 0o600 });
          }
        },
      }),
    rejects("invalid_state"),
  );
  assert.deepEqual(fs.readFileSync(file), before);
});

test("original request recovery works at exhausted entry and workspace revision boundaries", (t) => {
  const { store, file } = fixture(t, (data) => {
    data.entries = [
      originalEntry(`ENT-${Number.MAX_SAFE_INTEGER}`, "RETIRED", "LIMIT"),
    ];
  });
  const input = intent(store, "DOC-001"),
    result = store.submit("DOC-001", input);
  assert.equal(result.error, "entry_limit");
  const data = store.read();
  data.revision = Number.MAX_SAFE_INTEGER;
  fs.writeFileSync(file, JSON.stringify(data));
  const before = fs.readFileSync(file);
  assert.equal(store.submit("DOC-001", input).replayed, true);
  assert.throws(
    () => store.submit("DOC-005", intent(store, "DOC-005")),
    rejects("revision_limit"),
  );
  assert.deepEqual(fs.readFileSync(file), before);
});
