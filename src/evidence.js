import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { VERSION as anthropicVersion } from "@anthropic-ai/sdk/version";
import { aggregateUsage, hash, now } from "./native.js";
import { errorInfo } from "./lifecycle.js";
const require = createRequire(import.meta.url);
export const versions = {
  node: process.version,
  anthropic: anthropicVersion,
  playwright: require("playwright/package.json").version,
};
export async function publishBinary(file, bytes, guard) {
  const staged = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(staged, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    guard?.();
    await rename(staged, file);
    const directory = await open(path.dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(staged).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
export const publishJSON = (file, data) =>
  publishBinary(file, JSON.stringify(data, null, 2) + "\n");
export class RunReceipt {
  native = null;
  recordingFailure = null;
  tail = Promise.resolve();
  constructor(directory, data, writer) {
    this.directory = directory;
    this.path = path.join(directory, "trace.json");
    this.data = data;
    this.writer = writer;
  }
  static async create(
    task,
    model,
    portalUrl,
    system,
    outputRoot = "artifacts",
    writer = publishJSON,
  ) {
    const runId = randomUUID(),
      directory = path.resolve(outputRoot, runId);
    await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    const receipt = new RunReceipt(
      directory,
      {
        schema_version: 1,
        run_id: runId,
        status: "running",
        started_at: now(),
        finished_at: null,
        task,
        task_sha256: hash(task),
        instructions_sha256: hash(system),
        requested_model: model,
        portal_url: portalUrl,
        versions,
        execution_kind: "preflight",
        initial_state: null,
        initial_state_sha256: null,
        final_state: null,
        final_state_sha256: null,
        provider_observations: [],
        sdk_observations: [],
        tools: [],
        trace: [],
        browser_http_writes: [],
        reported_usage: aggregateUsage([]),
        client_reported_usage: aggregateUsage([]),
        observed_state_delta: null,
        actual_effects: { created_entry_ids: [], uncertain_submissions: [] },
        result: null,
        error: null,
      },
      writer,
    );
    try {
      await receipt.save();
    } catch (error) {
      receipt.data.status = "failed";
      receipt.data.finished_at = now();
      receipt.data.error = errorInfo(error);
      receipt.data.evidence_error = errorInfo(error);
      try {
        await receipt.save(true);
      } catch {
        receipt.data.last_durable_receipt_status = "unknown";
      }
      const failure = error instanceof Error ? error : new Error(String(error));
      throw Object.assign(failure, {
        evidence: receipt.data,
        receiptPath: receipt.path,
        runReceipt: receipt,
      });
    }
    return receipt;
  }
  guard() {
    if (this.recordingFailure) throw this.recordingFailure;
  }
  async save(force = false) {
    if (!force) this.guard();
    if (this.native) {
      this.data.provider_observations = structuredClone(
        this.native.observations,
      );
      this.data.reported_usage = aggregateUsage(this.native.observations);
    }
    this.data.client_reported_usage = aggregateUsage(
      this.data.sdk_observations,
    );
    const value = structuredClone(this.data),
      previous = force ? this.tail.catch(() => {}) : this.tail;
    this.tail = previous
      .then(() => this.writer(this.path, value))
      .catch((error) => {
        this.recordingFailure = error;
        throw error;
      });
    await this.tail;
  }
  async finish(result, failure) {
    Object.assign(this.data, {
      status: failure ? "failed" : "completed",
      finished_at: now(),
      result: failure ? null : result,
      error: failure ? errorInfo(failure) : null,
    });
    try {
      await this.save(true);
    } catch (error) {
      this.data.status = "failed";
      this.data.result = null;
      this.data.response = null;
      this.data.evidence_error = errorInfo(error);
      try {
        await this.save(true);
      } catch {
        this.data.last_durable_receipt_status = "unknown";
      }
      throw error;
    }
  }
}
