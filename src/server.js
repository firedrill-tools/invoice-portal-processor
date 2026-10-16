import express from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Store } from "./state.js";
import {
  StateError,
  validateInvoice,
  reviewed,
  duplicateKey,
  money,
  parseSubmission,
} from "./state-contracts.js";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const escape = (value) =>
  String(value ?? "Missing")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const field = (label, name, type = "text") =>
  `<label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" required autocomplete="off">`;
const layout = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} | Ledgerline</title><link rel="stylesheet" href="/assets/style.css"></head><body><header><div class="brand">LEDGERLINE <span>/ AP PORTAL</span></div><span class="local">LOCAL BUSINESS WORKSPACE</span></header><main>${body}</main></body></html>`;
const amount = (value, currency) =>
  `${money(value)} ${escape(currency)}<small>Exact cents: ${escape(value)}</small>`;
function sourceFields(invoice, vendor) {
  return `<dl><div><dt>Source ID</dt><dd>${escape(invoice.id ?? invoice.source_id)}</dd></div><div><dt>Vendor</dt><dd>${escape(vendor?.name ?? "Unknown")} (${escape(invoice.vendor_id)})</dd></div><div><dt>Invoice number</dt><dd>${escape(invoice.invoice_number)}</dd></div><div><dt>Issue date</dt><dd>${escape(invoice.issued_on || "Missing")}</dd></div><div><dt>Due date</dt><dd>${escape(invoice.due_on || "Missing")}</dd></div><div><dt>Subtotal</dt><dd>${amount(invoice.subtotal_cents, invoice.currency)}</dd></div><div><dt>Tax</dt><dd>${amount(invoice.tax_cents, invoice.currency)}</dd></div><div><dt>Total</dt><dd>${amount(invoice.total_cents, invoice.currency)}</dd></div>${invoice.approval ? `<div><dt>Approval</dt><dd>${escape(invoice.approval)}</dd></div>` : ""}</dl>`;
}
export function createApp(file, { storeOptions } = {}) {
  const store = new Store(file, storeOptions),
    app = express();
  app.locals.store = store;
  app.use(
    express.urlencoded({ extended: false, limit: "16kb", parameterLimit: 16 }),
  );
  app.use("/assets", express.static(path.join(root, "public")));
  app.get("/", (_req, res) => {
    const data = store.read(),
      rows = data.invoices
        .map((invoice) => {
          const vendor = data.vendors.find(
              (row) => row.id === invoice.vendor_id,
            ),
            entry = data.entries.find((row) => row.source_id === invoice.id),
            link = `/invoices/${encodeURIComponent(invoice.id)}`;
          return `<tr><td><a href="${link}">${escape(invoice.id)}</a><small>${escape(invoice.invoice_number)}</small></td><td>${escape(vendor?.name ?? "Unknown vendor")}</td><td>${escape(invoice.currency)} ${money(invoice.total_cents)}</td><td>${entry ? "Submitted" : escape(invoice.approval)}</td><td><a href="${link}">Review ${escape(invoice.id)} →</a></td></tr>`;
        })
        .join("");
    res.send(
      layout(
        "Invoice inbox",
        `<div class="eyebrow">ACCOUNTS PAYABLE / 01</div><h1>Invoice inbox</h1><p class="intro">Review source approval and exact values before entering a portal record.</p><section class="panel"><div class="panel-title"><h2>Source documents</h2><span>${data.invoices.length} records</span></div>${data.invoices.length ? `<div class="table-wrap"><table><thead><tr><th>Document</th><th>Vendor</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p role="status">No source invoices are waiting for review.</p>'}</section><p class="footnote">Synthetic data only · Local demonstration</p>`,
      ),
    );
  });
  app.get("/invoices/:id", (req, res) => {
    const data = store.read(),
      view = reviewed(data, req.params.id);
    if (!view)
      return res
        .status(404)
        .send(layout("Not found", "<h1>Invoice not found</h1>"));
    const { invoice, vendor } = view;
    const existing = data.entries.find(
        (entry) => entry.source_id === invoice.id,
      ),
      duplicate = data.entries.find(
        (entry) => duplicateKey(entry) === duplicateKey(invoice),
      ),
      precheck = validateInvoice(invoice, data);
    const status =
      req.query.saved === "1" && existing
        ? '<div role="status" class="notice">Invoice submitted. Portal entry confirmed below.</div>'
        : "";
    let action;
    if (existing)
      action = `<div role="status" class="notice">Portal entry ${escape(existing.id)} recorded for ${escape(existing.vendor_id)} / ${escape(existing.invoice_number)}. <a href="/entries/${encodeURIComponent(existing.id)}">View original entry</a>. No further submission is needed.</div>`;
    else if (duplicate)
      action = `<div role="alert" class="warning">Duplicate: ${escape(duplicate.id)} already records this vendor and invoice number. Stop and review.</div>`;
    else if (precheck)
      action = `<div role="alert" class="warning">Source cannot be submitted: ${escape(precheck)}. Resolve the document before entry.</div>`;
    else
      action = `<p class="hint">Enter the exact cents and source values shown here. Your reviewed source is checked again on submission.</p><form method="post" action="/invoices/${encodeURIComponent(invoice.id)}"><input type="hidden" name="request_id" value="${randomUUID()}"><input type="hidden" name="expected_source_token" value="${view.expected_source_token}"><input type="hidden" name="revision" value="${invoice.revision}">${field("Vendor ID", "vendor_id")}${field("Invoice number", "invoice_number")}${field("Issue date", "issued_on")}${field("Due date", "due_on")}${field("Currency", "currency")}${field("Subtotal cents", "subtotal_cents", "number")}${field("Tax cents", "tax_cents", "number")}${field("Total cents", "total_cents", "number")}<button type="submit">Submit invoice</button></form>`;
    res.send(
      layout(
        invoice.id,
        `<a class="back" href="/">← Invoice inbox</a><div class="eyebrow">SOURCE DOCUMENT / ${escape(invoice.id)}</div><h1>${escape(invoice.invoice_number)}</h1><p class="intro">Review actual source approval and exact values before entry.</p>${status}<div class="columns"><section class="panel"><div class="panel-title"><h2>Source document</h2><span>Revision ${invoice.revision}</span></div>${sourceFields(invoice, vendor)}</section><section class="panel"><div class="panel-title"><h2>Portal entry</h2><span>CONTROLLED WRITE</span></div>${action}</section></div>`,
      ),
    );
  });
  app.get("/entries/:id", (req, res) => {
    const data = store.read(),
      entry = data.entries.find((row) => row.id === req.params.id);
    if (!entry)
      return res
        .status(404)
        .send(layout("Not found", "<h1>Entry not found</h1>"));
    const p = entry.provenance;
    res.send(
      layout(
        entry.id,
        `<a class="back" href="/">← Invoice inbox</a><div class="eyebrow">ORIGINAL PORTAL RECORD</div><h1>${escape(entry.id)}</h1><div role="status" class="notice">Portal entry ${escape(entry.id)} recorded for ${escape(entry.vendor_id)} / ${escape(entry.invoice_number)}.</div><section class="panel"><div class="panel-title"><h2>Original recorded values</h2><span>${p?.kind === "portal_submission" ? "Portal submission" : p?.kind === "human_import" ? "Imported human history" : "Legacy history · original provenance unknown"}</span></div>${sourceFields({ ...entry, id: entry.source_id }, p?.vendor_snapshot)}<p>Recorded time: ${escape(p?.at ?? "Unknown (legacy history)")}</p>${data.invoices.some((row) => row.id === entry.source_id) ? `<a href="/invoices/${encodeURIComponent(entry.source_id)}">Review current source ${escape(entry.source_id)}</a>` : ""}</section>`,
      ),
    );
  });
  app.post("/invoices/:id", (req, res, next) => {
    let input;
    try {
      input = parseSubmission(req.params.id, req.body).input;
    } catch (error) {
      return next(error);
    }
    const controller = new AbortController(),
      deadline = performance.now() + 5000;
    const cancel = () =>
      controller.abort(
        new StateError(
          "cancelled",
          "Submission was cancelled; inspect its original request ID",
        ),
      );
    req.once("aborted", cancel);
    const disconnect = () => {
      if (!res.writableFinished) cancel();
    };
    res.once("close", disconnect);
    try {
      const result = store.submit(req.params.id, input, {
        actorRunId: req.get("x-invoice-run-id") ?? null,
        guard: () => {
          if (req.aborted || controller.signal.aborted)
            throw new StateError(
              "cancelled",
              "Submission cancelled; recover the original request before retrying",
            );
          if (performance.now() >= deadline)
            throw new StateError(
              "request_deadline",
              "Submission deadline reached; recover its original request",
            );
        },
      });
      res.set("X-Invoice-Request-ID", result.request_id);
      res.set("X-Invoice-Replayed", String(result.replayed));
      if (result.error)
        return res
          .status(result.error === "not_found" ? 404 : 409)
          .send(
            layout(
              "Submission blocked",
              `<a class="back" href="/invoices/${encodeURIComponent(req.params.id)}">← Source document</a><div role="alert" class="warning"><h1>Submission blocked</h1><p>${escape(result.error)}</p></div><p>No new portal entry was created by this request. Inspect the original request before changing its intent.</p>`,
            ),
          );
      res.set("X-Invoice-Entry-ID", result.entry.id);
      res.set(
        "X-Invoice-Source-ID",
        encodeURIComponent(result.entry.source_id),
      );
      res.redirect(
        303,
        `/entries/${encodeURIComponent(result.entry.id)}?saved=1`,
      );
    } catch (error) {
      next(error);
    } finally {
      req.removeListener("aborted", cancel);
      res.removeListener("close", disconnect);
    }
  });
  app.get("/api/state", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(store.read());
  });
  app.use((error, _req, res, _next) => {
    const code = error.code ?? "internal",
      status =
        code === "invalid_request"
          ? 400
          : code === "state_busy" || code === "publication_uncertain"
            ? 503
            : code === "cancelled"
              ? 499
              : [
                    "request_deadline",
                    "stale_workspace",
                    "stale_revision",
                    "immutable_history",
                    "revision_limit",
                    "entry_limit",
                    "state_limit",
                  ].includes(code)
                ? 409
                : 500;
    res
      .status(status)
      .send(
        layout(
          "Request unavailable",
          `<div role="alert" class="warning"><h1>Request unavailable</h1><p>${escape(code)}</p></div><p>Inspect the original request and persisted portal state before retrying. A failed acknowledgement can follow a committed entry.</p>`,
        ),
      );
  });
  return app;
}
export function startServer(file, port = 8787, options = {}) {
  return new Promise((resolve, reject) => {
    const server = createApp(file, options).listen(port, "127.0.0.1", () =>
      resolve(server),
    );
    server.once("error", reject);
  });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const file = path.resolve(
    process.env.INVOICE_WORKSPACE_FILE || "workspace.json",
  );
  startServer(file, Number(process.env.PORT || 8787))
    .then(() => console.log("Invoice portal listening on 127.0.0.1"))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
