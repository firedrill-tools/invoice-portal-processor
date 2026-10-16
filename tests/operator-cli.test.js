import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import express from "express";
import { initializeCase, showCase, listCases } from "../src/datasets.js";
import { startServer } from "../src/server.js";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function environment() {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      key.startsWith("ANTHROPIC_") ||
      key.startsWith("INVOICE_") ||
      ["NODE_OPTIONS", "NODE_PATH"].includes(key)
    )
      delete env[key];
  return env;
}
async function fixture(t, mode) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "invoice-cli-"));
  const selected = initializeCase("busy", path.join(directory, "case")),
    original = showCase(selected.directory).state;
  const portal = await startServer(selected.workspace_file, 0),
    app = express(),
    requests = [];
  let notify;
  const interruptedRequest = new Promise((resolve) => {
    notify = resolve;
  });
  const target = original.invoices.find((source) => source.id === "DOC-001");
  const actions = [
    ["browser_click", { role: "link", name: "Review DOC-001 →" }],
    ...Object.entries({
      "Vendor ID": target.vendor_id,
      "Invoice number": target.invoice_number,
      "Issue date": target.issued_on,
      "Due date": target.due_on,
      Currency: target.currency,
      "Subtotal cents": String(target.subtotal_cents),
      "Tax cents": String(target.tax_cents),
      "Total cents": String(target.total_cents),
    }).map(([label, value]) => ["browser_fill", { label, value }]),
    ["browser_click", { role: "button", name: "Submit invoice" }],
  ];
  app.use(express.json({ limit: "2mb" }));
  app.post("/v1/messages", (req, res) => {
    requests.push(req.body);
    const index = requests.length;
    if (
      (["SIGINT", "SIGHUP"].includes(mode) && index === 1) ||
      (mode === "SIGTERM" && index === 11)
    ) {
      notify();
      return;
    }
    res.set("request-id", `controlled-http-${index}`);
    if (mode === "provider-failure" && index === 11)
      return res.status(503).json({
        type: "error",
        error: {
          type: "overloaded_error",
          message: "Controlled unavailable",
        },
        usage: { input_tokens: 7, output_tokens: 0 },
      });
    const action = actions[index - 1];
    res.json({
      id: `msg_controlled_${index}`,
      type: "message",
      role: "assistant",
      model: "synthetic-offline-http",
      stop_reason: action ? "tool_use" : "end_turn",
      stop_sequence: null,
      content: action
        ? [
            {
              type: "tool_use",
              id: `tool_${index}`,
              name: action[0],
              input: action[1],
            },
          ]
        : [{ type: "text", text: "Original portal entry verified." }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  });
  const provider = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  const env = {
    ...environment(),
    ANTHROPIC_API_KEY: "synthetic-not-a-paid-key",
    ANTHROPIC_MODEL: "synthetic-offline-http",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${provider.address().port}`,
    INVOICE_PORTAL_URL: `http://127.0.0.1:${portal.address().port}`,
    INVOICE_OUTPUT_ROOT: path.join(directory, "runs"),
  };
  t.after(async () => {
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    portal.closeAllConnections();
    await new Promise((resolve) => portal.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, selected, original, requests, interruptedRequest, env };
}
function start(t, context) {
  const child = spawn(
    process.execPath,
    [path.join(root, "src/operator.js"), "Enter approved DOC-001."],
    {
      cwd: context.directory,
      env: context.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 45000,
      killSignal: "SIGKILL",
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (bytes) => {
    stdout += bytes;
  });
  child.stderr.on("data", (bytes) => {
    stderr += bytes;
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  });
  const completed = once(child, "close").then(([code, signal]) => ({
    code,
    signal,
    stdout,
    stderr,
  }));
  return { child, completed };
}
for (const mode of [
  "ordinary",
  "provider-failure",
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
])
  test(
    `normal actual SDK/operator CLI ${mode} preserves busy human history and private final evidence`,
    { timeout: 60000 },
    async (t) => {
      const context = await fixture(t, mode),
        operation = start(t, context);
      if (mode.startsWith("SIG")) {
        await Promise.race([
          context.interruptedRequest,
          operation.completed.then((value) => {
            throw new Error(`CLI ended before cancellation: ${value.stderr}`);
          }),
        ]);
        operation.child.kill(mode);
      }
      const result = await operation.completed;
      assert.equal(result.signal, null, result.stderr);
      assert.equal(
        result.code,
        mode === "ordinary"
          ? 0
          : mode === "SIGINT"
            ? 130
            : mode === "SIGTERM"
              ? 143
              : mode === "SIGHUP"
                ? 129
                : 1,
        result.stderr,
      );
      const output = JSON.parse(
        mode === "ordinary"
          ? result.stdout
          : result.stderr.trim().split("\n").at(-1),
      );
      const file =
          mode === "ordinary"
            ? path.join(output.outputDir, "trace.json")
            : output.receipt_path,
        receipt = JSON.parse(fs.readFileSync(file, "utf8"));
      const current = showCase(context.selected.directory).state,
        committed = !["SIGINT", "SIGHUP"].includes(mode);
      assert.deepEqual(current.entries.slice(0, 12), context.original.entries);
      assert.deepEqual(current.invoices, context.original.invoices);
      assert.equal(current.entries.length, committed ? 13 : 12);
      assert.deepEqual(
        receipt.actual_effects.created_entry_ids,
        committed ? ["ENT-0080"] : [],
      );
      assert.equal(
        receipt.status,
        mode === "ordinary" ? "completed" : "failed",
      );
      assert.equal(
        receipt.lifecycle.browser.browser_process_exit_confirmed,
        true,
      );
      assert.equal(receipt.lifecycle.native_http_operations_drained, true);
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(
        context.requests.length,
        ["SIGINT", "SIGHUP"].includes(mode) ? 1 : 11,
      );
      if (mode === "provider-failure") {
        assert.equal(receipt.reported_usage.fields.input_tokens, 107);
        assert.equal(receipt.reported_usage.fields.output_tokens, 50);
        assert.deepEqual(output.actual_effects.created_entry_ids, ["ENT-0080"]);
      }
      if (mode === "ordinary") {
        assert.equal(output.outcome, "entry_recorded");
        const busy = listCases().cases.find((item) => item.id === "busy");
        const serialized = JSON.stringify(context.requests);
        assert.ok(!serialized.includes(busy.task));
        assert.ok(!serialized.includes(busy.focus));
        assert.equal(receipt.initial_state.entries.length, 12);
        assert.equal(receipt.final_state.entries.length, 13);
      }
      const before = fs.readFileSync(file);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(fs.readFileSync(file), before);
    },
  );

test("normal missing-key CLI writes private failed preflight without browser or provider work", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "invoice-cli-keyless-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [path.join(root, "src/operator.js"), "Inspect the invoice inbox."],
    {
      cwd: directory,
      env: {
        ...environment(),
        ANTHROPIC_MODEL: "synthetic-enabled-name",
        INVOICE_OUTPUT_ROOT: path.join(directory, "runs"),
      },
      encoding: "utf8",
      timeout: 15000,
    },
  );
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stderr.trim().split("\n").at(-1));
  assert.match(output.error, /ANTHROPIC_API_KEY required/);
  const receipt = JSON.parse(fs.readFileSync(output.receipt_path));
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.initial_state, null);
  assert.equal(receipt.provider_observations.length, 0);
  assert.equal(Object.hasOwn(receipt.lifecycle, "browser"), false);
});

test(
  "actual portal CLI serves an isolated case with the selected ephemeral address",
  { timeout: 15000 },
  async (t) => {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "invoice-portal-cli-"),
      ),
      setup = initializeCase("empty-inbox", path.join(directory, "case"));
    const child = spawn(process.execPath, [path.join(root, "src/server.js")], {
      cwd: directory,
      env: {
        ...environment(),
        INVOICE_WORKSPACE_FILE: setup.workspace_file,
        PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
    });
    const closed = once(child, "close");
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const address = await new Promise((resolve, reject) => {
      let output = "";
      child.stdout.on("data", (bytes) => {
        output += bytes;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) resolve(match[0]);
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Portal exited ${code}`)));
    });
    const state = await (
      await fetch(`${address}/api/state`, { signal: AbortSignal.timeout(3000) })
    ).json();
    assert.equal(state.invoices.length, 0);
    assert.equal(state.entries.length, 1);
  },
);
