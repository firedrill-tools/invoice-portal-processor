import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import express from "express";
import { createApp } from "../src/server.js";
import { startServer } from "../src/server.js";
import { Store } from "../src/state.js";
import { runProcessor } from "../src/operator.js";
import { publishJSON } from "../src/evidence.js";
import { BrowserSession } from "../src/browser.js";
import { submit } from "./helpers/intent.js";

const usage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 2,
};
const call = (name = "browser_inspect", input = {}, id = "call_1") => ({
  type: "tool_use",
  id,
  name,
  input,
});
const body = (
  content = [
    { type: "text", text: "Source inspected; no invoice entry was created." },
  ],
  index = 1,
) => ({
  id: `msg_synthetic_${index}`,
  type: "message",
  role: "assistant",
  model: "synthetic-returned",
  stop_reason: content.some((item) => item.type === "tool_use")
    ? "tool_use"
    : "end_turn",
  stop_sequence: null,
  content,
  usage: { ...usage },
  unknown_metadata: { retained: true },
});
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "invoice-native-")),
    file = path.join(root, "workspace.json");
  fs.writeFileSync(
    file,
    fs.readFileSync(new URL("../fixtures/starter.json", import.meta.url)),
    { mode: 0o600 },
  );
  const server = await startServer(file, 0),
    store = new Store(file);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    file,
    store,
    options: {
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      key: "synthetic-not-a-provider-key",
      model: "synthetic-offline",
      providerBaseUrl: "https://api.anthropic.com",
      outputRoot: path.join(root, "runs"),
    },
  };
}
function script(items) {
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({
      url: String(url),
      body: JSON.parse(options.body),
      signal: options.signal,
    });
    const item = items[requests.length - 1];
    if (typeof item === "number")
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "overloaded_error",
            message: "Controlled unavailable",
          },
          usage: { input_tokens: 7, output_tokens: 0 },
        }),
        {
          status: item,
          headers: {
            "content-type": "application/json",
            "request-id": "failed-synthetic",
          },
        },
      );
    return new Response(
      typeof item === "string" ? item : JSON.stringify(item),
      {
        headers: {
          "content-type": "application/json",
          "request-id": `request_${requests.length}`,
        },
      },
    );
  };
  return { requests, fetch };
}
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
const submission = () =>
  actions.map(([name, input], index) =>
    body([call(name, input, `call_${index + 1}`)], index + 1),
  );

test("owned actual native SDK loop retains all original usage/source and closes its Chromium process", async (t) => {
  const context = await fixture(t),
    before = context.store.read(),
    transport = script([
      body([
        {
          type: "thinking",
          thinking: "Controlled metadata",
          signature: "synthetic-signature",
        },
        call(),
      ]),
      body(undefined, 2),
    ]);
  const { result, receiptPath } = await runProcessor(
    "Inspect the invoice inbox.",
    { ...context.options, fetch: transport.fetch },
  );
  assert.deepEqual(context.store.read(), before);
  assert.equal(transport.requests.length, 2);
  assert.deepEqual(result.usage, {
    input_tokens: 20,
    output_tokens: 10,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 4,
    total_tokens: null,
  });
  assert.equal(result.cost_usd, null);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.provider_observations.length, 2);
  assert.equal(receipt.sdk_observations.length, 2);
  assert.equal(
    receipt.provider_observations[0].body.unknown_metadata.retained,
    true,
  );
  assert.equal(receipt.provider_observations[0].request_id, "request_1");
  assert.equal(receipt.lifecycle.browser.browser_process_exit_confirmed, true);
  assert.equal(receipt.lifecycle.parent_listener_removed, true);
  assert.deepEqual(receipt.actual_effects, {
    created_entry_ids: [],
    uncertain_submissions: [],
  });
  assert.equal(fs.statSync(receiptPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(receiptPath)).mode & 0o777, 0o700);
  for (const item of receipt.trace)
    assert.equal(fs.statSync(item.screenshot).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(receipt).includes(context.options.key));
  assert.ok(transport.requests.every((request) => request.signal.aborted));
  assert.equal(transport.requests[0].body.max_tokens, 1800);
});

for (const mode of [
  "max_tokens",
  "absent-stop",
  "refusal",
  "pause_turn",
  "wrong-stop",
  "empty-final",
  "unknown-tool",
  "extra-args",
  "bad-json",
  "over-limit",
  "nonfinite",
  "bad-thinking",
]) {
  test(`original native ${mode} cannot dispatch a browser action or release success`, async (t) => {
    const context = await fixture(t),
      before = context.store.read();
    let value = body([call()]);
    if (mode === "max_tokens" || mode === "refusal" || mode === "pause_turn")
      value.stop_reason = mode;
    if (mode === "absent-stop") delete value.stop_reason;
    if (mode === "wrong-stop") value.stop_reason = "end_turn";
    if (mode === "empty-final") value = body([{ type: "text", text: "   " }]);
    if (mode === "unknown-tool") value.content[0].name = "direct_submit";
    if (mode === "extra-args") value.content[0].input = { submit: true };
    if (mode === "bad-json") value = "{not valid JSON";
    if (mode === "over-limit")
      value = JSON.stringify(value) + " ".repeat(1048576);
    if (mode === "nonfinite")
      value = JSON.stringify(value).replace(
        '"input_tokens":10',
        '"input_tokens":1e400',
      );
    if (mode === "bad-thinking")
      value.content = [
        { type: "thinking", thinking: 42, signature: "bad" },
        call(),
      ];
    const transport = script([value]);
    await assert.rejects(
      runProcessor("Inspect source only.", {
        ...context.options,
        fetch: transport.fetch,
      }),
      (error) => {
        assert.equal(error.evidence.status, "failed");
        assert.equal(error.evidence.result, null);
        assert.deepEqual(error.evidence.tools, []);
        assert.equal(error.evidence.provider_observations.length, 1);
        assert.equal(
          error.evidence.lifecycle.browser.browser_process_exit_confirmed,
          true,
        );
        return true;
      },
    );
    assert.equal(transport.requests.length, 1);
    assert.deepEqual(context.store.read(), before);
  });
}
for (const mode of ["missing", "zero", "partial", "invalid", "independent"]) {
  test(`original native ${mode} counters remain distinct and cost unknown`, async (t) => {
    const context = await fixture(t),
      value = body();
    if (mode === "missing") delete value.usage;
    if (mode === "zero")
      value.usage = {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        total_tokens: 0,
      };
    if (mode === "partial") value.usage = { input_tokens: 7 };
    if (mode === "invalid")
      value.usage = {
        input_tokens: true,
        output_tokens: -1,
        cache_creation_input_tokens: "0",
      };
    if (mode === "independent") value.usage.total_tokens = 99;
    const transport = script([value]),
      { receiptPath, result } = await runProcessor("Inspect source.", {
        ...context.options,
        fetch: transport.fetch,
      });
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    assert.deepEqual(receipt.provider_observations[0].body, value);
    assert.equal(result.cost_usd, null);
    if (mode === "missing" || mode === "invalid")
      assert.ok(Object.values(result.usage).every((item) => item === null));
    if (mode === "zero")
      assert.ok(Object.values(result.usage).every((item) => item === 0));
    if (mode === "partial") {
      assert.equal(result.usage.input_tokens, 7);
      assert.equal(result.usage.output_tokens, null);
      assert.equal(result.usage.cache_read_input_tokens, null);
    }
    if (mode === "independent") assert.equal(result.usage.total_tokens, 99);
  });
}

test("provider failure after an acknowledged real submit preserves the committed effect and all attempts", async (t) => {
  const context = await fixture(t),
    transport = script([...submission(), 503]);
  await assert.rejects(
    runProcessor("Enter the approved DOC-001.", {
      ...context.options,
      fetch: transport.fetch,
    }),
    (error) => {
      const receipt = JSON.parse(fs.readFileSync(error.receiptPath, "utf8"));
      assert.equal(receipt.status, "failed");
      assert.equal(receipt.result, null);
      assert.equal(receipt.provider_observations.length, 11);
      assert.equal(receipt.provider_observations.at(-1).http_status, 503);
      assert.equal(receipt.reported_usage.fields.input_tokens, 107);
      assert.equal(receipt.reported_usage.fields.output_tokens, 50);
      assert.equal(receipt.client_reported_usage.fields.input_tokens, null);
      assert.equal(receipt.client_reported_usage.prepared_attempts, 11);
      assert.deepEqual(receipt.actual_effects.created_entry_ids, ["ENT-0001"]);
      assert.equal(receipt.browser_http_writes[0].entry_id, "ENT-0001");
      assert.equal(receipt.final_state.entries.length, 1);
      return true;
    },
  );
  assert.equal(transport.requests.length, 11);
  assert.equal(context.store.read().entries.length, 1);
});

for (const phase of [
  "initial",
  "request",
  "response",
  "tool",
  "final",
  "submit",
  "ack",
]) {
  test(`recording ${phase} fault stops further work and keeps actual effects`, async (t) => {
    const context = await fixture(t),
      transport = script(
        phase === "final" || phase === "submit" || phase === "ack"
          ? [...submission(), body(undefined, 11)]
          : [body([call()]), body(undefined, 2)],
      );
    let failed = false;
    const publish = async (file, value) => {
      const match =
        phase === "initial"
          ? value.provider_observations.length === 0 &&
            value.initial_state === null
          : phase === "request"
            ? value.provider_observations.some(
                (item) => item.status === "prepared",
              )
            : phase === "response"
              ? value.provider_observations.some(
                  (item) => item.status === "received",
                )
              : phase === "tool"
                ? value.tools.some((item) => item.status === "prepared")
                : phase === "final"
                  ? value.status === "completed"
                  : value.browser_http_writes.some(
                      (item) =>
                        item.status ===
                        (phase === "ack" ? "acknowledged" : "prepared"),
                    );
      if (!failed && match) {
        failed = true;
        throw new Error(`Controlled ${phase} recording fault`);
      }
      await publishJSON(file, value);
    };
    await assert.rejects(
      runProcessor("Enter only approved source.", {
        ...context.options,
        fetch: transport.fetch,
        publish,
      }),
      (error) => {
        assert.equal(error.evidence.status, "failed");
        assert.equal(error.evidence.result, null);
        if (phase === "final" || phase === "ack")
          assert.deepEqual(error.evidence.actual_effects.created_entry_ids, [
            "ENT-0001",
          ]);
        if (phase !== "initial")
          assert.equal(
            JSON.parse(fs.readFileSync(error.receiptPath, "utf8")).status,
            "failed",
          );
        return true;
      },
    );
    assert.equal(failed, true);
    assert.equal(
      context.store.read().entries.length,
      phase === "final" || phase === "ack" ? 1 : 0,
    );
    if (phase === "initial" || phase === "request")
      assert.equal(transport.requests.length, 0);
  });
}

for (const mode of ["cancel", "late-response", "stalled-body"]) {
  test(`native ${mode} closes resources and cannot change the final receipt later`, async (t) => {
    const context = await fixture(t),
      controller = new AbortController();
    let entered,
      release,
      cancelled = false;
    const ready = new Promise((resolve) => {
      entered = resolve;
    });
    const fetch = async () => {
      entered();
      if (mode === "stalled-body")
        return new Response(
          new ReadableStream({
            pull() {
              return new Promise(() => {});
            },
            cancel() {
              cancelled = true;
              return new Promise(() => {});
            },
          }),
        );
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const pending = runProcessor("Inspect source.", {
      ...context.options,
      fetch,
      signal: controller.signal,
    });
    await ready;
    controller.abort(new Error("Controlled parent cancellation"));
    let receiptPath;
    await assert.rejects(pending, (error) => {
      receiptPath = error.receiptPath;
      assert.equal(
        error.evidence.lifecycle.browser.browser_process_exit_confirmed,
        true,
      );
      assert.equal(error.evidence.status, "failed");
      assert.equal(error.evidence.actual_effects.created_entry_ids.length, 0);
      return true;
    });
    const before = fs.readFileSync(receiptPath);
    if (mode !== "stalled-body") {
      release(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
      );
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(cancelled, true);
    assert.deepEqual(fs.readFileSync(receiptPath), before);
    assert.equal(context.store.read().entries.length, 0);
  });
}

test(
  "overall deadline closes an actual browser and cancels a noncooperative client",
  { timeout: 10000 },
  async (t) => {
    const context = await fixture(t);
    await assert.rejects(
      runProcessor("Inspect source.", {
        ...context.options,
        timeoutMs: 5000,
        fetch: async () => new Promise(() => {}),
      }),
      (error) => {
        assert.equal(error.evidence.status, "failed");
        assert.equal(error.evidence.lifecycle.deadline_timer_cleared, true);
        assert.equal(
          error.evidence.lifecycle.browser.browser_process_exit_confirmed,
          true,
        );
        return true;
      },
    );
  },
);

test("missing key fails with private preflight evidence before browser/provider use", async (t) => {
  const context = await fixture(t);
  let launched = false;
  await assert.rejects(
    runProcessor("Inspect source.", {
      ...context.options,
      key: "",
      browserType: {
        launchServer() {
          launched = true;
        },
      },
    }),
    (error) => {
      assert.equal(error.evidence.status, "failed");
      assert.equal(error.evidence.provider_observations.length, 0);
      assert.equal(error.evidence.initial_state, null);
      return true;
    },
  );
  assert.equal(launched, false);
});

test("late browser startup is closed without late receipt mutation", async (t) => {
  const context = await fixture(t),
    controller = new AbortController();
  let entered,
    release,
    closed = false;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const browserType = {
    launchServer() {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  };
  const pending = runProcessor("Inspect source.", {
    ...context.options,
    signal: controller.signal,
    browserType,
    fetch: async () => {
      throw new Error("Must not call provider");
    },
  });
  await ready;
  controller.abort(new Error("Controlled startup cancellation"));
  let receiptPath;
  await assert.rejects(pending, (error) => {
    receiptPath = error.receiptPath;
    assert.equal(error.evidence.status, "failed");
    assert.equal(error.evidence.lifecycle.browser.startup_completed, false);
    return true;
  });
  const before = fs.readFileSync(receiptPath);
  release({
    async close() {
      closed = true;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, true);
  assert.deepEqual(fs.readFileSync(receiptPath), before);
});

test("browser origin policy blocks another local origin before its handler receives a request", async (t) => {
  const context = await fixture(t),
    browser = await BrowserSession.open(
      context.options.baseUrl,
      path.join(context.root, "captures"),
    );
  t.after(() => browser.close());
  let received = 0;
  const other = await startServer(context.file, 0);
  other.on("request", () => received++);
  t.after(() => new Promise((resolve) => other.close(resolve)));
  await assert.rejects(
    browser.page.goto(`http://127.0.0.1:${other.address().port}`),
  );
  assert.equal(received, 0);
  assert.equal(browser.blockedRequests.length, 1);
  await browser.close();
  assert.equal(browser.lifecycle.browser_process_exit_confirmed, true);
});

test("unrelated human submission appears only in observed state delta, not browser effects", async (t) => {
  const context = await fixture(t),
    original = script([body()]);
  const fetch = async (url, options) => {
    submit(context.store, "DOC-001", {
      revision: "1",
      vendor_id: "V-100",
      invoice_number: "HOS-1042",
      issued_on: "2026-10-01",
      due_on: "2026-10-31",
      currency: "CAD",
      subtotal_cents: "12000",
      tax_cents: "1560",
      total_cents: "13560",
    });
    return original.fetch(url, options);
  };
  const { result } = await runProcessor("Inspect source only.", {
    ...context.options,
    fetch,
  });
  assert.deepEqual(result.actual_effects.created_entry_ids, []);
  assert.deepEqual(result.observed_state_delta.added_entry_ids, ["ENT-0001"]);
});

test("browser startup failure closes the real launched process and retains failed evidence", async (t) => {
  const context = await fixture(t),
    browserType = {
      launchServer: (options) => chromium.launchServer(options),
      async connect(endpoint, options) {
        const browser = await chromium.connect(endpoint, options);
        browser.newContext = async () => {
          throw new Error("Controlled context startup fault");
        };
        return browser;
      },
    };
  await assert.rejects(
    runProcessor("Inspect source.", {
      ...context.options,
      browserType,
      fetch: async () => {
        throw new Error("Must not dispatch");
      },
    }),
    (error) => {
      assert.equal(error.evidence.status, "failed");
      assert.equal(error.evidence.lifecycle.browser.startup_completed, false);
      assert.equal(
        error.evidence.lifecycle.browser.browser_process_exit_confirmed,
        true,
      );
      assert.equal(error.evidence.provider_observations.length, 0);
      return true;
    },
  );
});

test("cleanup fault fails the run while still confirming the actual browser process exit", async (t) => {
  const context = await fixture(t),
    transport = script([body()]),
    browserType = {
      launchServer: (options) => chromium.launchServer(options),
      async connect(endpoint, options) {
        const browser = await chromium.connect(endpoint, options),
          original = browser.newContext.bind(browser);
        browser.newContext = async (options) => {
          const context = await original(options),
            close = context.close.bind(context);
          context.close = async () => {
            await close();
            throw new Error("Controlled context close fault");
          };
          return context;
        };
        return browser;
      },
    };
  await assert.rejects(
    runProcessor("Inspect source.", {
      ...context.options,
      browserType,
      fetch: transport.fetch,
    }),
    (error) => {
      assert.equal(error.evidence.status, "failed");
      assert.equal(error.evidence.result, null);
      assert.equal(
        error.evidence.lifecycle.browser.browser_process_exit_confirmed,
        true,
      );
      assert.equal(error.evidence.lifecycle.browser.close_errors.length, 1);
      return true;
    },
  );
});

test("lost write acknowledgement recovers its original persisted request without another entry", async (t) => {
  const context = await fixture(t),
    app = express();
  app.use((req, res, next) => {
    const set = res.set.bind(res);
    res.set = (key, value) =>
      typeof key === "string" && key.toLowerCase().startsWith("x-invoice-")
        ? res
        : set(key, value);
    next();
  });
  app.use(createApp(context.file));
  const server = await new Promise((resolve) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const transport = script([...submission(), body(undefined, 11)]);
  const { result, receiptPath } = await runProcessor("Enter approved source.", {
    ...context.options,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    fetch: transport.fetch,
  });
  assert.equal(result.outcome, "entry_recorded");
  assert.deepEqual(result.actual_effects.created_entry_ids, ["ENT-0001"]);
  assert.deepEqual(result.actual_effects.uncertain_submissions, []);
  const evidence = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  assert.equal(
    evidence.browser_http_writes[0].recovery_source,
    "persisted_request",
  );
  assert.equal(evidence.final_state.entries.length, 1);
});

test("unavailable final snapshot cannot erase the earlier acknowledged committed entry", async (t) => {
  const context = await fixture(t),
    transport = script([...submission(), body(undefined, 11)]);
  let reads = 0;
  const portalFetch = (url, options) =>
    ++reads === 1
      ? globalThis.fetch(url, options)
      : Promise.resolve(
          new Response('{"error":"Controlled source outage"}', { status: 503 }),
        );
  await assert.rejects(
    runProcessor("Enter approved source.", {
      ...context.options,
      fetch: transport.fetch,
      portalFetch,
    }),
    (error) => {
      assert.equal(error.evidence.status, "failed");
      assert.equal(error.evidence.final_state, null);
      assert.ok(error.evidence.final_snapshot_error);
      assert.deepEqual(error.evidence.actual_effects.created_entry_ids, [
        "ENT-0001",
      ]);
      assert.equal(error.evidence.reported_usage.prepared_attempts, 11);
      return true;
    },
  );
  assert.equal(context.store.read().entries.length, 1);
});

test("tool-only native loop stops at eighteen prepared requests without a final success", async (t) => {
  const context = await fixture(t),
    transport = script(
      Array.from({ length: 18 }, (_, index) =>
        body([call("browser_inspect", {}, `call_${index + 1}`)], index + 1),
      ),
    );
  await assert.rejects(
    runProcessor("Inspect without changing invoices.", {
      ...context.options,
      fetch: transport.fetch,
    }),
    (error) => {
      assert.equal(error.evidence.status, "failed");
      assert.equal(error.evidence.provider_observations.length, 18);
      assert.equal(error.evidence.tools.length, 18);
      assert.equal(error.evidence.reported_usage.fields.input_tokens, 180);
      assert.equal(error.evidence.result, null);
      return true;
    },
  );
  assert.equal(transport.requests.length, 18);
  assert.equal(context.store.read().entries.length, 0);
});

test("an oversized parallel tool batch is rejected before its first browser action", async (t) => {
  const context = await fixture(t),
    transport = script([
      body(
        Array.from({ length: 33 }, (_, index) =>
          call("browser_inspect", {}, `call_${index}`),
        ),
      ),
    ]);
  await assert.rejects(
    runProcessor("Inspect source.", {
      ...context.options,
      fetch: transport.fetch,
    }),
    (error) => {
      assert.deepEqual(error.evidence.tools, []);
      assert.equal(error.evidence.provider_observations.length, 1);
      return true;
    },
  );
  assert.equal(transport.requests.length, 1);
});

test("parent cancellation after a real acknowledged submit preserves its original committed identity", async (t) => {
  const context = await fixture(t),
    controller = new AbortController(),
    ordinary = script(submission());
  let attempts = 0;
  const fetch = (url, options) => {
    if (++attempts === 11) {
      controller.abort(new Error("Controlled cancellation after commit"));
      return new Promise(() => {});
    }
    return ordinary.fetch(url, options);
  };
  await assert.rejects(
    runProcessor("Enter approved DOC-001.", {
      ...context.options,
      fetch,
      signal: controller.signal,
    }),
    (error) => {
      assert.equal(error.evidence.status, "failed");
      assert.deepEqual(error.evidence.actual_effects.created_entry_ids, [
        "ENT-0001",
      ]);
      assert.equal(error.evidence.final_state.entries.length, 1);
      assert.equal(error.evidence.reported_usage.fields.input_tokens, null);
      assert.equal(
        error.evidence.client_reported_usage.fields.input_tokens,
        null,
      );
      assert.equal(
        error.evidence.lifecycle.browser.browser_process_exit_confirmed,
        true,
      );
      return true;
    },
  );
  assert.equal(attempts, 11);
  assert.equal(context.store.read().entries.length, 1);
});

test("cancellation drains delayed original-response recording before publishing the final receipt", async (t) => {
  const context = await fixture(t),
    controller = new AbortController(),
    transport = script([body([call()])]);
  let entered,
    release,
    blocked = false;
  const ready = new Promise((resolve) => {
      entered = resolve;
    }),
    recorded = new Promise((resolve) => {
      release = resolve;
    });
  const publish = async (file, value) => {
    if (
      !blocked &&
      value.status === "running" &&
      value.provider_observations[0]?.status === "received"
    ) {
      blocked = true;
      entered();
      await recorded;
    }
    if (
      value.status === "failed" &&
      value.provider_observations[0]?.status === "failed"
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    await publishJSON(file, value);
  };
  const pending = runProcessor("Inspect only.", {
    ...context.options,
    signal: controller.signal,
    fetch: transport.fetch,
    publish,
  });
  await ready;
  controller.abort(new Error("Controlled cancellation during recording"));
  release();
  let receiptPath;
  await assert.rejects(pending, (error) => {
    receiptPath = error.receiptPath;
    assert.equal(error.evidence.lifecycle.native_http_operations_drained, true);
    assert.equal(error.evidence.provider_observations[0].status, "failed");
    return true;
  });
  const before = fs.readFileSync(receiptPath);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(fs.readFileSync(receiptPath), before);
  assert.equal(context.store.read().entries.length, 0);
});

test("ordinary actual SDK submit completes, and a fresh readback run confirms the existing entry without a new effect", async (t) => {
  const context = await fixture(t),
    transport = script([
      ...submission(),
      body([{ type: "text", text: "Portal entry ENT-0001 is recorded." }], 11),
    ]);
  const first = await runProcessor(
    "Enter approved DOC-001 and verify its persisted entry.",
    { ...context.options, fetch: transport.fetch },
  );
  assert.equal(transport.requests.length, 11);
  assert.equal(first.result.outcome, "entry_recorded");
  assert.equal(first.result.usage.input_tokens, 110);
  assert.equal(first.result.usage.output_tokens, 55);
  assert.deepEqual(first.result.actual_effects.created_entry_ids, ["ENT-0001"]);
  assert.match(first.result.final_url, /saved=1/);
  const original = context.store.read(),
    recovery = script([
      body([call("browser_click", { role: "link", name: "Review DOC-001 →" })]),
      body(
        [
          {
            type: "text",
            text: "Existing entry ENT-0001 was confirmed; no new submission was needed.",
          },
        ],
        2,
      ),
    ]);
  const second = await runProcessor(
    "Inspect DOC-001 and verify any existing portal entry.",
    { ...context.options, fetch: recovery.fetch },
  );
  assert.equal(second.result.outcome, "no_new_entry");
  assert.notEqual(first.outputDir, second.outputDir);
  assert.deepEqual(context.store.read(), original);
  assert.deepEqual(second.result.actual_effects.created_entry_ids, []);
  assert.deepEqual(second.result.observed_state_delta.added_entry_ids, []);
  assert.ok(second.result.trace.at(-1).text.includes("Portal entry ENT-0001"));
  assert.equal(
    JSON.parse(fs.readFileSync(second.receiptPath, "utf8")).status,
    "completed",
  );
});

for (const acknowledgement of ["missing", "mismatched-request"])
  test(`${acknowledgement} acknowledgement and unavailable persisted state remain uncertain with the actual commit intact`, async (t) => {
    const context = await fixture(t),
      app = express();
    app.use((req, res, next) => {
      const set = res.set.bind(res);
      res.set = (key, value) =>
        typeof key === "string" &&
        acknowledgement === "missing" &&
        key.toLowerCase().startsWith("x-invoice-")
          ? res
          : set(
              key,
              typeof key === "string" &&
                key.toLowerCase() === "x-invoice-request-id"
                ? "unrelated-request"
                : value,
            );
      next();
    });
    app.use(createApp(context.file));
    const server = await new Promise((resolve) => {
      const value = app.listen(0, "127.0.0.1", () => resolve(value));
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    let reads = 0;
    const transport = script([...submission(), body(undefined, 11)]);
    await assert.rejects(
      runProcessor("Enter approved source.", {
        ...context.options,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        fetch: transport.fetch,
        portalFetch: (url, options) =>
          ++reads === 1
            ? globalThis.fetch(url, options)
            : Promise.resolve(new Response("unavailable", { status: 503 })),
      }),
      (error) => {
        assert.equal(error.evidence.status, "failed");
        assert.deepEqual(error.evidence.actual_effects.created_entry_ids, []);
        assert.equal(
          error.evidence.actual_effects.uncertain_submissions.length,
          1,
        );
        assert.ok(error.evidence.browser_http_writes[0].request_id);
        assert.ok(error.evidence.browser_http_writes[0].intent_sha256);
        if (acknowledgement === "mismatched-request")
          assert.equal(
            error.evidence.browser_http_writes[0].acknowledged_request_id,
            "unrelated-request",
          );
        return true;
      },
    );
    assert.equal(context.store.read().entries.length, 1);
    assert.equal(context.store.read().submissions.length, 1);
  });

test("actual SDK and browser copy the large original safe cents through form and persisted entry exactly", async (t) => {
  const context = await fixture(t),
    data = context.store.read();
  Object.assign(data.invoices[0], {
    subtotal_cents: Number.MAX_SAFE_INTEGER - 1,
    tax_cents: 0,
    total_cents: Number.MAX_SAFE_INTEGER - 1,
    revision: 2,
  });
  context.store.write(data);
  const values = {
    "Subtotal cents": "9007199254740990",
    "Tax cents": "0",
    "Total cents": "9007199254740990",
  };
  const transport = script([
    ...actions.map(([name, input], index) =>
      body(
        [
          call(
            name,
            values[input.label] === undefined
              ? input
              : { ...input, value: values[input.label] },
            `call_${index + 1}`,
          ),
        ],
        index + 1,
      ),
    ),
    body(undefined, 11),
  ]);
  const { result, receiptPath } = await runProcessor(
    "Enter the approved exact original invoice values.",
    { ...context.options, fetch: transport.fetch },
  );
  assert.equal(result.outcome, "entry_recorded");
  const state = context.store.read(),
    receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  assert.equal(state.entries[0].subtotal_cents, Number.MAX_SAFE_INTEGER - 1);
  assert.equal(state.entries[0].tax_cents, 0);
  assert.equal(state.entries[0].total_cents, Number.MAX_SAFE_INTEGER - 1);
  assert.equal(
    receipt.browser_http_writes[0].input.total_cents,
    "9007199254740990",
  );
  assert.ok(result.trace.at(-1).text.includes("90071992547409.90"));
  assert.ok(result.trace.at(-1).text.includes("Exact cents: 9007199254740990"));
});

test("changed original history between valid API snapshots fails readback without inventing a model effect", async (t) => {
  const context = await fixture(t);
  // Both individual snapshots satisfy the business schema; continuity must also preserve original records.
  const legacy = JSON.parse(
    fs.readFileSync(new URL("../fixtures/starter.json", import.meta.url)),
  );
  legacy.entries = [
    {
      id: "ENT-0007",
      source_id: "RETIRED",
      vendor_id: "V-100",
      invoice_number: "HUMAN-7",
      issued_on: "2026-01-01",
      due_on: "2026-01-31",
      currency: "CAD",
      subtotal_cents: 100,
      tax_cents: 0,
      total_cents: 100,
    },
  ];
  fs.writeFileSync(context.file, JSON.stringify(legacy));
  const original = new Store(context.file).read();
  let reads = 0;
  await assert.rejects(
    runProcessor("Inspect the invoice inbox.", {
      ...context.options,
      fetch: script([body()]).fetch,
      portalFetch: async (url, options) => {
        const response = await globalThis.fetch(url, options);
        if (++reads === 1) return response;
        const state = await response.json();
        state.entries[0].invoice_number = "REWRITTEN";
        return new Response(JSON.stringify(state), {
          headers: { "content-type": "application/json" },
        });
      },
    }),
    (error) => {
      assert.match(error.message, /Original portal history changed/);
      assert.deepEqual(error.evidence.observed_state_delta.changed_entry_ids, [
        "ENT-0007",
      ]);
      assert.deepEqual(error.evidence.actual_effects.created_entry_ids, []);
      assert.equal(error.evidence.status, "failed");
      return true;
    },
  );
  assert.deepEqual(context.store.read(), original);
});
