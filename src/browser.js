import path from "node:path";
import { chromium } from "playwright";
import { portalEndpoint, hash, now } from "./native.js";
import { publishBinary } from "./evidence.js";
import { errorInfo, untilAbort, within } from "./lifecycle.js";
import { parseSubmission } from "./state-contracts.js";

const closeLate = (resource) => {
  void within(resource.close(), 5000, "Late browser cleanup")
    .catch(() => resource.kill?.())
    .catch(() => {});
};
export class BrowserSession {
  server = null;
  browser = null;
  context = null;
  page = null;
  step = 0;
  trace = [];
  httpWrites = [];
  blockedRequests = [];
  pending = new Set();
  requests = new Map();
  failure = null;
  closed = false;
  closing = null;
  writeGrant = null;
  constructor(
    baseUrl,
    captureDir,
    {
      signal,
      guard = () => {},
      onEvidence = async () => {},
      browserType = chromium,
      runId = null,
    } = {},
  ) {
    this.baseUrl = portalEndpoint(baseUrl);
    this.captureDir = captureDir;
    this.signal = signal ?? new AbortController().signal;
    this.outerGuard = guard;
    this.onEvidence = onEvidence;
    this.browserType = browserType;
    this.runId = runId;
    this.lifecycle = {
      startup_started: true,
      startup_completed: false,
      browser_process_exit_confirmed: false,
      context_close_attempted: false,
      late_resource_cleanup_registered: true,
    };
  }
  guard() {
    this.outerGuard();
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("Browser owner is closed");
    this.signal.throwIfAborted();
  }
  track(promise) {
    this.pending.add(promise);
    promise
      .catch((error) => {
        this.failure ??= error;
      })
      .finally(() => this.pending.delete(promise));
    return promise;
  }
  static async open(baseUrl, captureDir, options = {}) {
    const value = new BrowserSession(baseUrl, captureDir, options);
    try {
      value.guard();
      value.server = await untilAbort(
        value.browserType.launchServer({
          headless: true,
          timeout: 10000,
          handleSIGINT: false,
          handleSIGTERM: false,
          handleSIGHUP: false,
        }),
        value.signal,
        closeLate,
      );
      value.guard();
      value.browser = await untilAbort(
        value.browserType.connect(value.server.wsEndpoint(), {
          timeout: 10000,
        }),
        value.signal,
        closeLate,
      );
      value.guard();
      value.context = await untilAbort(
        value.browser.newContext({
          viewport: { width: 1280, height: 900 },
          serviceWorkers: "block",
          acceptDownloads: false,
        }),
        value.signal,
        closeLate,
      );
      value.guard();
      value.context.setDefaultTimeout(5000);
      value.context.setDefaultNavigationTimeout(5000);
      await value.context.route("**/*", (route) => value.route(route));
      value.guard();
      value.page = await untilAbort(
        value.context.newPage(),
        value.signal,
        closeLate,
      );
      value.guard();
      value.context.on("response", (response) => {
        if (!value.closed) value.track(value.response(response));
      });
      await untilAbort(
        value.page.goto(value.baseUrl, {
          waitUntil: "domcontentloaded",
          timeout: 5000,
        }),
        value.signal,
      );
      value.guard();
      value.lifecycle.startup_completed = true;
      value.cancel = () => {
        void value.close().catch(() => {});
      };
      value.signal.addEventListener("abort", value.cancel, { once: true });
      if (value.signal.aborted) value.cancel();
      value.guard();
      return value;
    } catch (error) {
      try {
        await value.close();
      } catch (cleanup) {
        Object.assign(error, { browserCleanupError: errorInfo(cleanup) });
      }
      throw Object.assign(error, {
        browserLifecycle: value.lifecycle,
        browserEvidence: {
          trace: value.trace,
          browser_http_writes: value.httpWrites,
          blocked_browser_requests: value.blockedRequests,
        },
      });
    }
  }
  async route(route) {
    const request = route.request();
    try {
      this.guard();
      const url = new URL(request.url());
      if (
        url.origin !== this.baseUrl ||
        url.username ||
        url.password ||
        !["http:"].includes(url.protocol) ||
        request.frame().page() !== this.page
      )
        throw new Error("Browser request left its exact portal/page owner");
      if (request.method() !== "GET" && request.method() !== "POST")
        throw new Error("Unsupported portal request method");
      if (request.method() === "POST") {
        if (
          !this.writeGrant ||
          this.writeGrant.used ||
          request.url() !== this.writeGrant.url
        )
          throw new Error(
            "Portal write requires the current explicit submit action",
          );
        this.writeGrant.used = true;
        const body = request.postData();
        if (typeof body !== "string" || Buffer.byteLength(body) > 16384)
          throw new Error("Portal form exceeds its bounded intent");
        const parameters = new URLSearchParams(body);
        if (new Set(parameters.keys()).size !== [...parameters.keys()].length)
          throw new Error("Duplicate portal form fields");
        const parsed = parseSubmission(
          this.writeGrant.source_id,
          Object.fromEntries(parameters),
        );
        const record = {
          request_id: parsed.input.request_id,
          intent_sha256: parsed.intent_sha256,
          input: parsed.input,
          run_id: this.runId,
          status: "prepared",
          dispatch_attempted: false,
          prepared_at: now(),
          url: request.url(),
          source_id: this.writeGrant.source_id,
          body,
          body_sha256: hash(body),
          http_status: null,
          location: null,
        };
        this.requests.set(request, record);
        this.httpWrites.push(record);
        await this.onEvidence();
        this.guard();
      }
      const record = this.requests.get(request);
      if (record) record.dispatch_attempted = true;
      await route.continue(
        request.method() === "POST" && this.runId
          ? {
              headers: { ...request.headers(), "x-invoice-run-id": this.runId },
            }
          : undefined,
      );
    } catch (error) {
      this.failure ??= error;
      const record = this.requests.get(request);
      if (record && !record.dispatch_attempted)
        record.status = "blocked_before_dispatch";
      this.blockedRequests.push({
        url: request.url(),
        method: request.method(),
        error: errorInfo(error),
      });
      await route.abort().catch(() => {});
      await this.onEvidence().catch(() => {});
    }
  }
  async response(response) {
    const record = this.requests.get(response.request());
    if (!record) return;
    record.http_status = response.status();
    const headers = await response.allHeaders();
    record.location = headers.location ?? null;
    record.entry_id = headers["x-invoice-entry-id"] ?? null;
    record.acknowledged_request_id = headers["x-invoice-request-id"] ?? null;
    try {
      record.acknowledged_source_id = headers["x-invoice-source-id"]
        ? decodeURIComponent(headers["x-invoice-source-id"])
        : null;
    } catch {
      record.acknowledged_source_id = null;
    }
    record.replayed =
      headers["x-invoice-replayed"] === "true"
        ? true
        : headers["x-invoice-replayed"] === "false"
          ? false
          : null;
    record.status = "acknowledged";
    record.finished_at = now();
    if (!this.closed) await this.onEvidence();
  }
  async observe(action = "inspect") {
    this.guard();
    if (new URL(this.page.url()).origin !== this.baseUrl)
      throw new Error("Browser left its exact configured portal");
    if (this.step >= 129) throw new Error("Browser observation limit reached");
    const bytes = await untilAbort(
      this.page.screenshot({ fullPage: false, timeout: 5000 }),
      this.signal,
    );
    this.guard();
    if (bytes.length > 4194304)
      throw new Error("Viewport screenshot exceeds 4 MiB evidence limit");
    const screenshot = path.join(
      this.captureDir,
      `step-${String(this.step++).padStart(2, "0")}.png`,
    );
    await this.track(publishBinary(screenshot, bytes, () => this.guard()));
    this.guard();
    const [title, text, controls] = await untilAbort(
      Promise.all([
        this.page.title(),
        this.page.locator("body").innerText({ timeout: 5000 }),
        this.page.locator("a,button,input,select").evaluateAll((elements) =>
          elements.slice(0, 40).map((el) => ({
            tag: el.tagName.toLowerCase(),
            text: (el.textContent ?? "").trim().slice(0, 90),
            label: el.labels?.[0]?.textContent?.trim() ?? "",
            value: "value" in el ? String(el.value).slice(0, 2000) : "",
          })),
        ),
      ]),
      this.signal,
    );
    this.guard();
    const view = {
      url: this.page.url(),
      title: title.slice(0, 200),
      text: text.slice(0, 6000),
      controls,
      screenshot,
      screenshot_sha256: hash(bytes),
      screenshot_bytes: bytes.length,
      screenshot_kind: "viewport",
    };
    this.trace.push({ action, ...view });
    await this.onEvidence();
    this.guard();
    return view;
  }
  async execute(name, args) {
    this.guard();
    const firstWrite = this.httpWrites.length;
    try {
      if (name === "browser_inspect") return await this.observe();
      if (name === "browser_click") {
        if (!["link", "button"].includes(args.role))
          throw new Error("Unsupported browser click role");
        const target = this.page.getByRole(args.role, {
          name: args.name,
          exact: true,
        });
        if (args.role === "button") {
          const form = await untilAbort(
            target.evaluate((el) =>
              el.type === "submit" && el.form
                ? {
                    method: el.form.method,
                    action: el.hasAttribute("formaction")
                      ? el.formAction
                      : el.form.action,
                  }
                : null,
            ),
            this.signal,
          );
          this.guard();
          if (form) {
            const url = new URL(form.action);
            if (
              form.method.toLowerCase() !== "post" ||
              url.origin !== this.baseUrl ||
              url.username ||
              url.password ||
              url.search ||
              !/^\/invoices\/[^/]+$/.test(url.pathname)
            )
              throw new Error("Submit form is outside the owned invoice path");
            this.writeGrant = {
              url: url.href,
              source_id: decodeURIComponent(
                url.pathname.slice("/invoices/".length),
              ),
            };
          }
        }
        await untilAbort(target.click({ timeout: 5000 }), this.signal);
      } else if (name === "browser_fill")
        await untilAbort(
          this.page
            .getByLabel(args.label, { exact: true })
            .fill(args.value, { timeout: 5000 }),
          this.signal,
        );
      else throw new Error("Unsupported browser tool");
      this.guard();
      await untilAbort(
        this.page.waitForLoadState("domcontentloaded", { timeout: 5000 }),
        this.signal,
      );
      await Promise.allSettled([...this.pending]);
      this.guard();
      if (
        this.httpWrites
          .slice(firstWrite)
          .some((write) => write.http_status !== 303)
      )
        throw new Error(
          "Portal submission was blocked or its acknowledgement is uncertain",
        );
      return await this.observe(`${name} ${JSON.stringify(args)}`);
    } catch (error) {
      this.guard();
      const observation = await this.observe(`failed ${name}`);
      return { error: errorInfo(error), ...observation };
    } finally {
      this.writeGrant = null;
    }
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.signal.removeEventListener("abort", this.cancel);
    this.closing = (async () => {
      const errors = [];
      if (this.context) {
        this.lifecycle.context_close_attempted = true;
        await within(this.context.close(), 5000, "Browser context close").catch(
          (error) => errors.push(errorInfo(error)),
        );
      }
      if (this.browser)
        await within(
          this.browser.close(),
          5000,
          "Browser connection close",
        ).catch((error) => errors.push(errorInfo(error)));
      if (this.server) {
        await within(this.server.close(), 5000, "Browser server close").catch(
          async (error) => {
            errors.push(errorInfo(error));
            await within(this.server.kill(), 5000, "Browser kill").catch(
              (failure) => errors.push(errorInfo(failure)),
            );
          },
        );
        const child = this.server.process();
        this.lifecycle.browser_process_exit_confirmed =
          child.exitCode !== null || child.signalCode !== null;
        if (!this.lifecycle.browser_process_exit_confirmed) {
          await within(this.server.kill(), 5000, "Browser kill").catch(
            (error) => errors.push(errorInfo(error)),
          );
          this.lifecycle.browser_process_exit_confirmed =
            child.exitCode !== null || child.signalCode !== null;
        }
      }
      await Promise.allSettled([...this.pending]);
      this.lifecycle.owner_closed = true;
      this.lifecycle.close_errors = errors;
      if (
        errors.length ||
        (this.server && !this.lifecycle.browser_process_exit_confirmed)
      )
        throw new Error("Browser cleanup could not complete without error");
    })();
    return this.closing;
  }
}
