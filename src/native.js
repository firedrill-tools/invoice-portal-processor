import { createHash } from "node:crypto";
import { tools, validateMessage } from "./contracts.js";
import { errorInfo, untilAbort } from "./lifecycle.js";
import { validateState } from "./state-contracts.js";
export const LIMIT = 1048576;
export const now = () => new Date().toISOString();
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export function parseJSON(value) {
  return JSON.parse(value, (_key, item) => {
    if (typeof item === "number" && !Number.isFinite(item))
      throw new Error("Nonfinite JSON number");
    return item;
  });
}
const counters = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "total_tokens",
];
export function reportedUsage(body) {
  return Object.fromEntries(
    counters.map((key) => {
      const value = body?.usage?.[key];
      return [
        key,
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0
          ? value
          : null,
      ];
    }),
  );
}
export function aggregateUsage(observations) {
  const fields = Object.fromEntries(
    counters.map((key) => {
      const values = observations.map((item) => item.reported_usage[key]);
      const sum =
        values.length && values.every((value) => value !== null)
          ? values.reduce((a, b) => a + b, 0)
          : null;
      return [key, sum !== null && Number.isSafeInteger(sum) ? sum : null];
    }),
  );
  return { fields, prepared_attempts: observations.length, cost_usd: null };
}
export function providerEndpoint(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error(
      "Provider URL requires HTTPS or loopback HTTP without credentials/query/fragment",
    );
  return url.href.replace(/\/$/, "");
}
export function portalEndpoint(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "Portal requires an exact loopback HTTP root without credentials/query/fragment",
    );
  return url.origin;
}
export async function capture(response, signal, record) {
  const reader = response.body?.getReader(),
    chunks = [];
  let size = 0,
    complete = false;
  const cancel = () => {
    reader?.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (reader)
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await untilAbort(reader.read(), signal);
        if (done) break;
        const remaining = LIMIT - size;
        chunks.push(Buffer.from(value.subarray(0, remaining)));
        size += Math.min(remaining, value.length);
        if (value.length > remaining) {
          record.truncated = true;
          reader.cancel("Evidence limit").catch(() => {});
          break;
        }
      }
    signal.throwIfAborted();
    complete = !record.truncated;
  } finally {
    const raw = Buffer.concat(chunks);
    record.capture_sha256 = hash(raw);
    record.body_sha256 = complete ? hash(raw) : null;
    try {
      record.body_text = new TextDecoder("utf8", { fatal: true }).decode(raw);
      record.body = parseJSON(record.body_text);
    } catch {
      record.body = record.body_text;
      record.captured_base64 = raw.toString("base64");
    }
    record.reported_usage = reportedUsage(record.body);
    if (record.body && typeof record.body === "object") {
      record.response_id =
        typeof record.body.id === "string" ? record.body.id : null;
      record.response_model =
        typeof record.body.model === "string" ? record.body.model : null;
    }
    signal.removeEventListener("abort", cancel);
    if (!complete) reader?.cancel("Capture ended").catch(() => {});
    reader?.releaseLock();
  }
  return Buffer.concat(chunks);
}
export class NativeEvidence {
  observations = [];
  pending = new Set();
  seenResponses = new Set();
  seenCalls = new Set();
  failed = null;
  terminal = false;
  constructor(baseURL, save, guard) {
    Object.assign(this, { baseURL, save, guard });
  }
  check() {
    this.guard();
    if (this.failed) throw this.failed;
  }
  fetch(fetcher, signal) {
    const perform = async (url, options = {}) => {
      this.check();
      if (this.observations.length >= 18)
        throw new Error("Native prepared request limit (18) reached");
      if (
        String(url) !== `${this.baseURL}/v1/messages` ||
        options.method !== "POST" ||
        typeof options.body !== "string" ||
        Buffer.byteLength(options.body) > LIMIT
      )
        throw new Error("Only bounded native JSON Messages is qualified");
      const request = parseJSON(options.body);
      if (
        request.stream === true ||
        request.max_tokens !== 1800 ||
        JSON.stringify(request.tools) !== JSON.stringify(tools)
      )
        throw new Error("Unexpected native tool/output settings");
      const record = {
        attempt: this.observations.length + 1,
        status: "prepared",
        started_at: now(),
        finished_at: null,
        path: new URL(String(url)).pathname,
        request_body: request,
        request_sha256: hash(options.body),
        http_status: null,
        request_id: null,
        body: null,
        body_text: null,
        captured_base64: null,
        capture_sha256: null,
        body_sha256: null,
        truncated: false,
        response_id: null,
        response_model: null,
        reported_usage: reportedUsage(null),
        error: null,
      };
      this.observations.push(record);
      await this.save();
      this.check();
      const controller = new AbortController(),
        timer = setTimeout(
          () => controller.abort(new Error("Provider HTTP deadline exceeded")),
          15000,
        );
      const combined = AbortSignal.any([
        signal,
        controller.signal,
        ...(options.signal ? [options.signal] : []),
      ]);
      try {
        const response = await untilAbort(
          fetcher(url, { ...options, redirect: "error", signal: combined }),
          combined,
          (late) => {
            late.body?.cancel("Invoice owner stopped").catch(() => {});
          },
        );
        record.http_status = response.status;
        record.request_id = response.headers.get("request-id");
        record.status = "received";
        const raw = await capture(response, combined, record);
        await this.save();
        this.check();
        combined.throwIfAborted();
        if (record.truncated)
          throw new Error("Native response exceeds 1 MiB evidence limit");
        if (response.ok)
          this.terminal =
            validateMessage(record.body, this.seenResponses, this.seenCalls)
              .length === 0;
        record.status = response.ok ? "accepted" : "http_error";
        record.finished_at = now();
        await this.save();
        this.check();
        const headers = new Headers(response.headers);
        headers.delete("content-encoding");
        headers.delete("content-length");
        return new Response(raw, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch (error) {
        this.failed = error;
        record.status = "failed";
        record.finished_at = now();
        record.error = errorInfo(error);
        await this.save();
        throw error;
      } finally {
        clearTimeout(timer);
      }
    };
    return (...args) => {
      const work = perform(...args);
      this.pending.add(work);
      work.finally(() => this.pending.delete(work)).catch(() => {});
      return work;
    };
  }
  async drain() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
export async function sourceSnapshot(
  baseUrl,
  signal,
  fetcher = globalThis.fetch,
) {
  const controller = new AbortController(),
    timer = setTimeout(
      () => controller.abort(new Error("Portal source read deadline exceeded")),
      5000,
    ),
    combined = AbortSignal.any([
      controller.signal,
      ...(signal ? [signal] : []),
    ]);
  try {
    const response = await untilAbort(
      fetcher(`${baseUrl}/api/state`, {
        redirect: "error",
        signal: combined,
        headers: { accept: "application/json" },
      }),
      combined,
      (late) => {
        late.body?.cancel("Source read owner stopped").catch(() => {});
      },
    );
    const record = { truncated: false };
    await capture(response, combined, record);
    if (
      !response.ok ||
      record.truncated ||
      !record.body ||
      !["vendors", "invoices", "entries", "audit"].every((key) =>
        Array.isArray(record.body[key]),
      )
    )
      throw new Error("Portal source snapshot is invalid or unavailable");
    validateState(record.body);
    return { state: record.body, sha256: hash(JSON.stringify(record.body)) };
  } finally {
    clearTimeout(timer);
  }
}
