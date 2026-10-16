import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { BrowserSession } from "./browser.js";
import { tools, validateMessage } from "./contracts.js";

export async function runProcessor(
  task,
  { baseUrl, model, outputRoot = "artifacts", client } = {},
) {
  if (!process.env.ANTHROPIC_API_KEY && !client)
    throw new Error("ANTHROPIC_API_KEY required; no model fallback");
  const anthropic = client || new Anthropic();
  const runId = crypto.randomUUID();
  const outputDir = path.resolve(outputRoot, runId);
  const portalUrl =
    baseUrl || process.env.INVOICE_PORTAL_URL || "http://127.0.0.1:8787";
  const parsedUrl = new URL(portalUrl);
  if (
    parsedUrl.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(parsedUrl.hostname)
  )
    throw new Error("portal URL must use local HTTP loopback");
  const browser = await BrowserSession.open(portalUrl, outputDir);
  const selectedModel =
    model || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
  const system =
    "You operate only the local Ledgerline accounts payable portal through the browser tools. " +
    "Read the source document and its approval before entry. Submit only if the source is approved, all fields exist, and subtotal plus tax equals total. " +
    "Check the vendor and invoice number for an existing entry. Enter exact source values, with amounts in integer cents. " +
    "If a source is incomplete, mismatched, pending approval, duplicated, or a browser action fails, stop and explain. " +
    "After submission inspect the confirmation; do not claim success until the portal shows the entry ID.";
  try {
    const initial = await browser.observe("initial");
    const messages = [
      {
        role: "user",
        content: `${task}\n\nInitial browser view:\n${JSON.stringify(initial)}`,
      },
    ];
    let response;
    const seenResponses = new Set(),
      seenCalls = new Set();
    for (let round = 0; round < 18; round++) {
      response = await anthropic.messages.create({
        model: selectedModel,
        max_tokens: 1800,
        system,
        tools,
        messages,
      });
      const calls = validateMessage(response, seenResponses, seenCalls);
      if (!calls.length) {
        const result = {
          task,
          model: response.model,
          response: response.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n"),
          response_id: response.id,
          usage: response.usage,
          final_url: browser.page.url(),
          trace: browser.trace,
        };
        fs.writeFileSync(
          path.join(outputDir, "trace.json"),
          `${JSON.stringify(result, null, 2)}\n`,
        );
        return { outputDir, result };
      }
      messages.push({ role: "assistant", content: response.content });
      const results = [];
      for (const call of calls) {
        const observation = await browser.execute(call.name, call.input || {});
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: JSON.stringify(observation),
          is_error: Boolean(observation.error),
        });
      }
      messages.push({ role: "user", content: results });
    }
    throw new Error("model exceeded 18 browser-action rounds");
  } finally {
    await browser.close();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const task = process.argv.slice(2).join(" ");
  if (!task) {
    console.error("Usage: npm run operate -- <task>");
    process.exitCode = 2;
  } else
    runProcessor(task)
      .then(({ outputDir, result }) =>
        console.log(
          JSON.stringify(
            {
              outputDir,
              response: result.response,
              final_url: result.final_url,
              usage: result.usage,
            },
            null,
            2,
          ),
        ),
      )
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
}
