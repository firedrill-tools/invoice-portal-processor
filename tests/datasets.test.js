import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  loadCases,
  listCases,
  initializeCase,
  showCase,
  caseCommand,
} from "../src/datasets.js";
import { Store } from "../src/state.js";
import { sha, validateInvoice } from "../src/state-contracts.js";
import { intent } from "./helpers/intent.js";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "invoice-data-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const bundle = () => loadCases(path.join(root, "data"));
const keyless = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("ANTHROPIC_") &&
        !key.startsWith("INVOICE_") &&
        !["NODE_PATH", "NODE_OPTIONS"].includes(key),
    ),
  );

test("twelve byte-bound cases span four profiles with coherent imported history and no seeded model/request output", () => {
  const data = bundle();
  assert.equal(data.cases.size, 12);
  assert.deepEqual(
    new Set(data.manifest.cases.map((item) => item.profile)),
    new Set(["starter", "busy", "ambiguous", "boundary"]),
  );
  for (const { state, metadata } of data.cases.values()) {
    assert.equal(state.submissions.length, 0);
    assert.equal(state.audit.length, 0);
    assert.ok(!Object.hasOwn(state, "task") && !Object.hasOwn(state, "focus"));
    assert.ok(
      state.entries.every((entry) => entry.provenance.kind === "human_import"),
    );
    assert.equal(sha(data.cases.get(metadata.id).bytes), metadata.sha256);
  }
  const busy = data.cases.get("busy").state;
  assert.equal(busy.vendors.length, 8);
  assert.equal(busy.invoices.length, 36);
  assert.equal(busy.entries.length, 12);
  assert.equal(busy.entries.at(-1).id, "ENT-0079");
  assert.equal(busy.invoices.at(-1).id, "DOC-001");
  assert.ok(
    busy.vendors.some((vendor) =>
      vendor.name.includes("'skip approval checks'"),
    ),
  );
});

test("generator reproduces all manifest and case bytes into an independent output directory", (t) => {
  const output = path.join(fixture(t), "generated");
  execFileSync(
    process.execPath,
    [path.join(root, "scripts/generate-data.js"), output],
    { cwd: os.tmpdir(), stdio: "pipe" },
  );
  assert.deepEqual(
    fs.readFileSync(path.join(output, "manifest.json")),
    fs.readFileSync(path.join(root, "data/manifest.json")),
  );
  for (const item of listCases(output).cases)
    assert.deepEqual(
      fs.readFileSync(path.join(output, "cases", item.file)),
      fs.readFileSync(path.join(root, "data/cases", item.file)),
    );
});

test("every case initializes exclusively with private modes, fresh instances, metadata outside source and unchanged template bytes", (t) => {
  const directory = fixture(t),
    data = bundle();
  for (const item of data.manifest.cases) {
    const initialized = initializeCase(item.id, path.join(directory, item.id));
    const shown = showCase(initialized.directory);
    assert.equal(fs.statSync(initialized.directory).mode & 0o777, 0o700);
    for (const name of ["workspace.json", "case.json"])
      assert.equal(
        fs.statSync(path.join(initialized.directory, name)).mode & 0o777,
        0o600,
      );
    assert.equal(shown.metadata.source_sha256, item.sha256);
    assert.equal(shown.changed_since_initialization, false);
    assert.notEqual(
      shown.state.instance_id,
      data.cases.get(item.id).state.instance_id,
    );
    assert.ok(!JSON.stringify(shown.state).includes(item.task));
    assert.ok(!JSON.stringify(shown.state).includes(item.focus));
    assert.deepEqual(
      fs.readFileSync(path.join(root, "data/cases", item.file)),
      data.cases.get(item.id).bytes,
    );
  }
});

test("independent case copies cannot reuse a reviewed source token and preserve unrelated human records", (t) => {
  const directory = fixture(t),
    one = initializeCase("busy", path.join(directory, "one")),
    two = initializeCase("busy", path.join(directory, "two"));
  const left = new Store(one.workspace_file),
    right = new Store(two.workspace_file),
    before = right.read(),
    input = intent(left, "DOC-001");
  assert.notEqual(left.read().instance_id, before.instance_id);
  assert.equal(right.submit("DOC-001", input).error, "stale_source");
  const own = right.submit("DOC-001", intent(right, "DOC-001"));
  assert.equal(own.entry.id, "ENT-0080");
  assert.deepEqual(right.read().entries.slice(0, 12), before.entries);
  assert.equal(left.read().entries.length, 12);
  assert.equal(showCase(two.directory).changed_since_initialization, true);
});

for (const [id, source, reason] of [
  ["missing-field", "DOC-002", "source_missing_field"],
  ["mismatched-total", "DOC-003", "source_total_mismatch"],
  ["pending-approval", "DOC-005", "approval_required"],
  ["invalid-date", "DOC-001", "source_invalid_date"],
  ["unsupported-currency", "DOC-001", "source_unsupported_currency"],
  ["canonical-duplicate", "DOC-001", "duplicate_invoice"],
  ["already-recorded", "DOC-001", "approval_required"],
])
  test(`private ${id} case retains original facts while server authority blocks ${reason}`, (t) => {
    const setup = initializeCase(id, path.join(fixture(t), "case")),
      store = new Store(setup.workspace_file),
      before = store.read();
    assert.equal(store.submit(source, intent(store, source)).error, reason);
    assert.deepEqual(store.read().entries, before.entries);
    assert.equal(store.read().submissions.length, 1);
  });

test("ambiguous vendor case needs exact source identity and empty inbox preserves retired human history", () => {
  const data = bundle(),
    ambiguous = data.cases.get("ambiguous-vendor").state;
  const candidates = ambiguous.invoices.filter(
    (row) => row.invoice_number === "HOS-1042",
  );
  assert.equal(candidates.length, 2);
  assert.equal(new Set(candidates.map((row) => row.vendor_id)).size, 2);
  assert.deepEqual(
    candidates.map((source) => validateInvoice(source, ambiguous)),
    [null, null],
  );
  const empty = data.cases.get("empty-inbox").state;
  assert.equal(empty.invoices.length, 0);
  assert.equal(empty.entries.length, 1);
  assert.equal(empty.entries[0].source_id, "RETIRED-HOS");
});

test("existing initialized destination and persistent mutex are never replaced", (t) => {
  const setup = initializeCase("busy", path.join(fixture(t), "owned")),
    store = new Store(setup.workspace_file),
    before = fs.readFileSync(setup.workspace_file),
    inode = fs.statSync(`${setup.workspace_file}.lock.sqlite`).ino;
  assert.throws(() => initializeCase("starter", setup.directory), {
    code: "EEXIST",
  });
  assert.deepEqual(fs.readFileSync(setup.workspace_file), before);
  assert.equal(fs.statSync(`${setup.workspace_file}.lock.sqlite`).ino, inode);
  assert.equal(store.read().entries.length, 12);
});

for (const kind of [
  "hash",
  "identity",
  "history",
  "traversal",
  "duplicate",
  "symlink",
])
  test(`invalid dataset ${kind} fails list/init before creating a private destination`, (t) => {
    const directory = fixture(t),
      dataRoot = path.join(directory, "data");
    fs.cpSync(path.join(root, "data"), dataRoot, { recursive: true });
    const file = path.join(dataRoot, "cases/starter.json"),
      manifestFile = path.join(dataRoot, "manifest.json"),
      manifest = JSON.parse(fs.readFileSync(manifestFile)),
      data = JSON.parse(fs.readFileSync(file));
    if (kind === "hash") fs.appendFileSync(file, " ");
    if (kind === "identity" || kind === "history") {
      if (kind === "identity") data.profile = "busy";
      else data.state.entries.push({ id: "ENT-9999" });
      fs.writeFileSync(file, JSON.stringify(data));
      manifest.cases[0].sha256 = sha(fs.readFileSync(file));
    }
    if (kind === "traversal") manifest.cases[0].file = "../starter.json";
    if (kind === "duplicate") manifest.cases.push(manifest.cases[0]);
    if (kind === "symlink") {
      fs.renameSync(file, `${file}.original`);
      fs.symlinkSync(`${file}.original`, file);
    }
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.throws(() => listCases(dataRoot));
    const destination = path.join(directory, "new");
    assert.throws(() => initializeCase("busy", destination, dataRoot));
    assert.equal(fs.existsSync(destination), false);
  });

test("show refuses a replaced legacy/foreign private source without migration or repair", (t) => {
  const setup = initializeCase("starter", path.join(fixture(t), "case"));
  for (const value of [
    JSON.parse(fs.readFileSync(path.join(root, "fixtures/starter.json"))),
    {
      ...showCase(setup.directory).state,
      instance_id: "c545e3af-5e5c-4ab9-870b-2016673f721a",
    },
  ]) {
    fs.writeFileSync(setup.workspace_file, JSON.stringify(value));
    const before = fs.readFileSync(setup.workspace_file);
    assert.throws(() => showCase(setup.directory));
    assert.deepEqual(fs.readFileSync(setup.workspace_file), before);
  }
});

test("key-free actual case CLI validates strict arguments and all cases from outside checkout", (t) => {
  const directory = fixture(t),
    cli = path.join(root, "src/datasets.js"),
    env = keyless();
  const run = (args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: directory,
      env,
      encoding: "utf8",
      timeout: 15000,
    });
  const listed = run(["list"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).cases.length, 12);
  for (const item of JSON.parse(listed.stdout).cases) {
    const result = run(["init", item.id, path.join(directory, item.id)]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(run(["show", path.join(directory, item.id)]).status, 0);
  }
  const before = fs.readFileSync(path.join(directory, "busy/workspace.json"));
  for (const args of [
    [],
    ["--help", "extra"],
    ["list", "extra"],
    ["list", "--data-root"],
    [
      "list",
      "--data-root",
      path.join(root, "data"),
      "--data-root",
      path.join(root, "data"),
    ],
    ["init", "missing", path.join(directory, "absent")],
    ["init", "starter", "--help"],
    ["init", "starter", path.join(directory, "busy")],
  ])
    assert.notEqual(run(args).status, 0, JSON.stringify(args));
  assert.deepEqual(
    fs.readFileSync(path.join(directory, "busy/workspace.json")),
    before,
  );
  for (const entry of ["src/datasets.js", "src/operator.js", "src/server.js"])
    assert.equal(
      spawnSync(process.execPath, [path.join(root, entry), "--help"], {
        cwd: directory,
        env,
        encoding: "utf8",
        timeout: 10000,
      }).status,
      0,
    );
});
