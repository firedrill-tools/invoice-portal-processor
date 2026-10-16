import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Store } from "../src/state.js";
import { startServer } from "../src/server.js";
import { runProcessor } from "../src/operator.js";
import Anthropic from "@anthropic-ai/sdk";
import { validateMessage } from "../src/contracts.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = path.join(root, "fixtures/starter.json");
const valid = {
  revision: "1",
  vendor_id: "V-100",
  invoice_number: "HOS-1042",
  issued_on: "2026-10-01",
  due_on: "2026-10-31",
  currency: "CAD",
  subtotal_cents: "12000",
  tax_cents: "1560",
  total_cents: "13560",
};
const setup = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "invoice-portal-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "workspace.json");
  fs.copyFileSync(fixture, file);
  return { dir, file, store: new Store(file) };
};

test("store accepts exact approved invoice once and rejects duplicate delivery", (t) => {
  const { store } = setup(t);
  const first = store.submit("DOC-001", valid);
  assert.equal(first.entry.id, "ENT-0001");
  assert.equal(store.submit("DOC-001", valid).error, "already_submitted");
  assert.equal(store.submit("DOC-004", valid).error, "duplicate_invoice");
  assert.equal(store.read().entries.length, 1);
  assert.deepEqual(
    store.read().audit.map((item) => item.action),
    ["submitted", "rejected", "rejected"],
  );
});

test("store rejects missing fields, mismatched source totals, pending approval, and tampering", (t) => {
  const { store } = setup(t);
  assert.equal(
    store.submit("DOC-002", {
      ...valid,
      vendor_id: "V-200",
      invoice_number: "NLS-218",
    }).error,
    "source_missing_field",
  );
  assert.equal(
    store.submit("DOC-003", { ...valid, invoice_number: "HOS-1043" }).error,
    "source_total_mismatch",
  );
  assert.equal(
    store.submit("DOC-005", {
      ...valid,
      vendor_id: "V-200",
      invoice_number: "NLS-219",
    }).error,
    "approval_required",
  );
  assert.equal(
    store.submit("DOC-001", { ...valid, total_cents: "13561" }).error,
    "amount_mismatch",
  );
  assert.equal(
    store.submit("DOC-001", { ...valid, due_on: "2026-11-30" }).error,
    "field_mismatch",
  );
  assert.equal(
    store.submit("DOC-001", { ...valid, revision: "0" }).error,
    "stale_revision",
  );
  assert.equal(store.read().entries.length, 0);
});

test("scripted Claude tool-use drives a real browser and saves confirmation captures", async (t) => {
  const { dir, file, store } = setup(t);
  const server = await startServer(file, 0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const actions = [
    ["browser_click", { role: "link", name: "Review DOC-001 →" }],
    ["browser_fill", { label: "Vendor ID", value: "V-100" }],
    ["browser_fill", { label: "Invoice number", value: "HOS-1042" }],
    ["browser_fill", { label: "Issue date", value: "2026-10-01" }],
    ["browser_fill", { label: "Due date", value: "2026-10-31" }],
    ["browser_fill", { label: "Currency", value: "CAD" }],
    ["browser_fill", { label: "Subtotal cents", value: "12000" }],
    ["browser_fill", { label: "Tax cents", value: "1560" }],
    ["browser_fill", { label: "Total cents", value: "13560" }],
    ["browser_click", { role: "button", name: "Submit invoice" }],
  ];
  let round = 0;
  const client = {
    messages: {
      create: async ({ messages, tools }) => {
        assert.equal(tools.length, 3);
        if (round > 0) {
          const latest = messages.at(-1).content[0];
          assert.equal(latest.type, "tool_result");
          assert.equal(latest.is_error, false);
        }
        const action = actions[round++];
        return {
          type: "message",
          role: "assistant",
          stop_reason: action ? "tool_use" : "end_turn",
          id: `msg-${round}`,
          model: "scripted-offline",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: action
            ? [
                {
                  type: "tool_use",
                  id: `tool-${round}`,
                  name: action[0],
                  input: action[1],
                },
              ]
            : [{ type: "text", text: "Portal entry ENT-0001 confirmed." }],
        };
      },
    },
  };
  try {
    const { outputDir, result } = await runProcessor("Enter DOC-001", {
      baseUrl,
      outputRoot: dir,
      client,
    });
    assert.equal(store.read().entries.length, 1);
    assert.equal(store.read().entries[0].total_cents, 13560);
    assert.match(result.final_url, /saved=1/);
    assert.match(result.trace.at(-1).text, /ENT-0001/);
    assert.equal(result.trace.length, 11);
    assert.equal(
      fs.readdirSync(outputDir).filter((name) => name.endsWith(".png")).length,
      11,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(outputDir, "trace.json"))).response,
      "Portal entry ENT-0001 confirmed.",
    );
    const duplicate = await fetch(`${baseUrl}/invoices/DOC-004`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(valid),
    });
    assert.equal(duplicate.status, 409);
    assert.equal(store.read().entries.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("saved query cannot claim a pending or unsubmitted source was entered", async (t) => {
  const { file, store } = setup(t),
    server = await startServer(file, 0),
    url = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const id of ["DOC-001", "DOC-005"]) {
      const page = await (await fetch(`${url}/invoices/${id}?saved=1`)).text();
      assert.ok(
        !page.includes("Invoice submitted. Portal entry confirmed below."),
      );
    }
    store.submit("DOC-001", valid);
    const page = await (await fetch(`${url}/invoices/DOC-001?saved=1`)).text();
    assert.ok(page.includes("Portal entry ENT-0001"));
    assert.ok(
      page.includes("Invoice submitted. Portal entry confirmed below."),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("noncontiguous original entry identities cannot collide with a new entry", (t) => {
  const { store } = setup(t),
    data = store.read();
  const prior = {
    id: "ENT-0002",
    source_id: "legacy-human-source",
    vendor_id: "V-200",
    invoice_number: "LEGACY-001",
    issued_on: "2026-01-01",
    due_on: "2026-01-31",
    currency: "CAD",
    subtotal_cents: 100,
    tax_cents: 0,
    total_cents: 100,
  };
  data.entries.push(prior);
  store.write(data);
  assert.equal(store.submit("DOC-001", valid).entry.id, "ENT-0003");
  assert.deepEqual(store.read().entries[0], prior);
});

for (const mode of [
  "max_tokens",
  "missing-stop",
  "refusal",
  "empty-final",
  "mismatched-stop",
  "unknown-tool",
  "extra-arguments",
  "replayed-call",
])
  test(`native ${mode} cannot dispatch browser actions or release success`, () => {
    const response = {
        type: "message",
        role: "assistant",
        id: "msg_controlled",
        model: "synthetic-offline",
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "call_one",
            name: "browser_inspect",
            input: {},
          },
        ],
      },
      seenResponses = new Set(),
      seenCalls = new Set();
    if (mode === "max_tokens") response.stop_reason = "max_tokens";
    if (mode === "missing-stop") delete response.stop_reason;
    if (mode === "refusal") response.stop_reason = "refusal";
    if (mode === "empty-final") {
      response.stop_reason = "end_turn";
      response.content = [{ type: "text", text: "   " }];
    }
    if (mode === "mismatched-stop") response.stop_reason = "end_turn";
    if (mode === "unknown-tool") response.content[0].name = "checkout";
    if (mode === "extra-arguments")
      response.content[0].input = { submit: true };
    if (mode === "replayed-call") seenCalls.add("call_one");
    assert.throws(() => validateMessage(response, seenResponses, seenCalls));
    assert.equal(seenResponses.size, 0);
  });

test("actual native SDK max_tokens submit is blocked before the real browser commits", async (t) => {
  const { dir, file, store } = setup(t),
    server = await startServer(file, 0),
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  const actions = [
    ["browser_click", { role: "link", name: "Review DOC-001 →" }],
    ...[
      ["Vendor ID", "V-100"],
      ["Invoice number", "HOS-1042"],
      ["Issue date", "2026-10-01"],
      ["Due date", "2026-10-31"],
      ["Currency", "CAD"],
      ["Subtotal cents", "12000"],
      ["Tax cents", "1560"],
      ["Total cents", "13560"],
    ].map(([label, value]) => ["browser_fill", { label, value }]),
    ["browser_click", { role: "button", name: "Submit invoice" }],
  ];
  let requests = 0;
  const client = new Anthropic({
    apiKey: "synthetic-not-a-provider-key",
    maxRetries: 0,
    fetch: async () => {
      const action = actions[requests++];
      return new Response(
        JSON.stringify({
          id: `msg_test_${requests}`,
          type: "message",
          role: "assistant",
          model: "synthetic-offline",
          stop_reason: requests === 10 ? "max_tokens" : "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [
            {
              type: "tool_use",
              id: `call_${requests}`,
              name: action[0],
              input: action[1],
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  try {
    await assert.rejects(
      runProcessor("Enter DOC-001", {
        baseUrl,
        client,
        model: "synthetic-offline",
        outputRoot: dir,
      }),
      /did not complete/,
    );
    assert.equal(requests, 10);
    assert.equal(store.read().entries.length, 0);
    assert.equal(store.read().audit.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
