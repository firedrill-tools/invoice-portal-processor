import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Store } from "../src/state.js";
import { startServer } from "../src/server.js";
import { runProcessor } from "../src/operator.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = path.join(root, "fixtures/starter.json");
const valid = { revision: "1", vendor_id: "V-100", invoice_number: "HOS-1042", issued_on: "2026-10-01", due_on: "2026-10-31", currency: "CAD", subtotal_cents: "12000", tax_cents: "1560", total_cents: "13560" };
const setup = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "invoice-portal-")); const file = path.join(dir, "workspace.json"); fs.copyFileSync(fixture, file); return { dir, file, store: new Store(file) }; };

test("store accepts exact approved invoice once and rejects duplicate delivery", () => {
  const { store } = setup();
  const first = store.submit("DOC-001", valid);
  assert.equal(first.entry.id, "ENT-0001");
  assert.equal(store.submit("DOC-001", valid).error, "already_submitted");
  assert.equal(store.submit("DOC-004", valid).error, "duplicate_invoice");
  assert.equal(store.read().entries.length, 1);
  assert.deepEqual(store.read().audit.map((item) => item.action), ["submitted", "rejected", "rejected"]);
});

test("store rejects missing fields, mismatched source totals, pending approval, and tampering", () => {
  const { store } = setup();
  assert.equal(store.submit("DOC-002", { ...valid, vendor_id: "V-200", invoice_number: "NLS-218" }).error, "source_missing_field");
  assert.equal(store.submit("DOC-003", { ...valid, invoice_number: "HOS-1043" }).error, "source_total_mismatch");
  assert.equal(store.submit("DOC-005", { ...valid, vendor_id: "V-200", invoice_number: "NLS-219" }).error, "approval_required");
  assert.equal(store.submit("DOC-001", { ...valid, total_cents: "13561" }).error, "amount_mismatch");
  assert.equal(store.submit("DOC-001", { ...valid, due_on: "2026-11-30" }).error, "field_mismatch");
  assert.equal(store.submit("DOC-001", { ...valid, revision: "0" }).error, "stale_revision");
  assert.equal(store.read().entries.length, 0);
});

test("scripted Claude tool-use drives a real browser and saves confirmation captures", async () => {
  const { dir, file, store } = setup();
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
    ["browser_click", { role: "button", name: "Submit invoice" }]
  ];
  let round = 0;
  const client = { messages: { create: async ({ messages, tools }) => {
    assert.equal(tools.length, 3);
    if (round > 0) {
      const latest = messages.at(-1).content[0];
      assert.equal(latest.type, "tool_result");
      assert.equal(latest.is_error, false);
    }
    const action = actions[round++];
    return { id: `msg-${round}`, model: "scripted-offline", usage: { input_tokens: 0, output_tokens: 0 },
      content: action ? [{ type: "tool_use", id: `tool-${round}`, name: action[0], input: action[1] }] : [{ type: "text", text: "Portal entry ENT-0001 confirmed." }] };
  } } };
  try {
    const { outputDir, result } = await runProcessor("Enter DOC-001", { baseUrl, outputRoot: dir, client });
    assert.equal(store.read().entries.length, 1);
    assert.equal(store.read().entries[0].total_cents, 13560);
    assert.match(result.final_url, /saved=1/);
    assert.match(result.trace.at(-1).text, /ENT-0001/);
    assert.equal(result.trace.length, 11);
    assert.equal(fs.readdirSync(outputDir).filter((name) => name.endsWith(".png")).length, 11);
    assert.equal(JSON.parse(fs.readFileSync(path.join(outputDir, "trace.json"))).response, "Portal entry ENT-0001 confirmed.");
    const duplicate = await fetch(`${baseUrl}/invoices/DOC-004`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(valid) });
    assert.equal(duplicate.status, 409);
    assert.equal(store.read().entries.length, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
