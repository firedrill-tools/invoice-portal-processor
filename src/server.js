import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store, validateInvoice } from "./state.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const escape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const money = (cents) => `${(cents / 100).toFixed(2)}`;
const field = (label, name, type = "text") =>
  `<label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" required autocomplete="off">`;
const layout = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} | Ledgerline</title><link rel="stylesheet" href="/assets/style.css"></head><body><header><div class="brand">LEDGERLINE <span>/ AP PORTAL</span></div><span class="local">LOCAL BUSINESS WORKSPACE</span></header><main>${body}</main></body></html>`;

export function createApp(file) {
  const store = new Store(file);
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use("/assets", express.static(path.join(root, "public")));
  app.get("/", (_req, res) => {
    const data = store.read();
    const rows = data.invoices
      .map((invoice) => {
        const vendor =
          data.vendors.find((v) => v.id === invoice.vendor_id)?.name ||
          "Unknown vendor";
        const entry = data.entries.find(
          (item) => item.source_id === invoice.id,
        );
        return `<tr><td><a href="/invoices/${escape(invoice.id)}">${escape(invoice.id)}</a><small>${escape(invoice.invoice_number)}</small></td><td>${escape(vendor)}</td><td>${escape(invoice.currency)} ${money(invoice.total_cents)}</td><td>${entry ? "Submitted" : escape(invoice.approval)}</td><td><a href="/invoices/${escape(invoice.id)}">Review ${escape(invoice.id)} →</a></td></tr>`;
      })
      .join("");
    res.send(
      layout(
        "Invoice inbox",
        `<div class="eyebrow">ACCOUNTS PAYABLE / 01</div><h1>Invoice inbox</h1><p class="intro">Review approved source documents, then enter their exact values into the portal. Submissions are checked against the source.</p><section class="panel"><div class="panel-title"><h2>Source documents</h2><span>${data.invoices.length} records</span></div><div class="table-wrap"><table><thead><tr><th>Document</th><th>Vendor</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section><p class="footnote">Synthetic data only · Local demonstration</p>`,
      ),
    );
  });
  app.get("/invoices/:id", (req, res) => {
    const data = store.read();
    const invoice = data.invoices.find((item) => item.id === req.params.id);
    if (!invoice)
      return res
        .status(404)
        .send(layout("Not found", "<h1>Invoice not found</h1>"));
    const vendor = data.vendors.find((item) => item.id === invoice.vendor_id);
    const existing = data.entries.find((item) => item.source_id === invoice.id);
    const duplicate = data.entries.find(
      (item) =>
        item.vendor_id === invoice.vendor_id &&
        item.invoice_number === invoice.invoice_number,
    );
    const precheck = validateInvoice(invoice, data);
    const status =
      req.query.saved === "1" && existing
        ? '<div role="status" class="notice">Invoice submitted. Portal entry confirmed below.</div>'
        : "";
    const source = `<dl><div><dt>Source ID</dt><dd>${escape(invoice.id)}</dd></div><div><dt>Vendor</dt><dd>${escape(vendor?.name || "Unknown")} (${escape(invoice.vendor_id)})</dd></div><div><dt>Invoice number</dt><dd>${escape(invoice.invoice_number)}</dd></div><div><dt>Issue date</dt><dd>${escape(invoice.issued_on)}</dd></div><div><dt>Due date</dt><dd>${escape(invoice.due_on || "Missing")}</dd></div><div><dt>Subtotal</dt><dd>${money(invoice.subtotal_cents)} ${escape(invoice.currency)}</dd></div><div><dt>Tax</dt><dd>${money(invoice.tax_cents)} ${escape(invoice.currency)}</dd></div><div><dt>Total</dt><dd>${money(invoice.total_cents)} ${escape(invoice.currency)}</dd></div><div><dt>Approval</dt><dd>${escape(invoice.approval)}</dd></div></dl>`;
    let action;
    if (existing)
      action = `<div role="status" class="notice">Portal entry ${escape(existing.id)} recorded for ${escape(existing.vendor_id)} / ${escape(existing.invoice_number)}. No further submission is needed.</div>`;
    else if (duplicate)
      action = `<div role="alert" class="warning">Duplicate: ${escape(duplicate.id)} already records this vendor and invoice number. Stop and review.</div>`;
    else if (precheck)
      action = `<div role="alert" class="warning">Source cannot be submitted: ${escape(precheck)}. Resolve the document before entry.</div>`;
    else
      action = `<p class="hint">Enter amounts in cents, exactly as shown on the source. No values are filled automatically.</p><form method="post" action="/invoices/${escape(invoice.id)}"><input type="hidden" name="revision" value="${invoice.revision}">${field("Vendor ID", "vendor_id")}${field("Invoice number", "invoice_number")}${field("Issue date", "issued_on")}${field("Due date", "due_on")}${field("Currency", "currency")}${field("Subtotal cents", "subtotal_cents", "number")}${field("Tax cents", "tax_cents", "number")}${field("Total cents", "total_cents", "number")}<button type="submit">Submit invoice</button></form>`;
    res.send(
      layout(
        invoice.id,
        `<a class="back" href="/">← Invoice inbox</a><div class="eyebrow">SOURCE DOCUMENT / ${escape(invoice.id)}</div><h1>${escape(invoice.invoice_number)}</h1><p class="intro">Read the source and verify approval before entering a portal record.</p>${status}<div class="columns"><section class="panel"><div class="panel-title"><h2>Approved source</h2><span>Revision ${invoice.revision}</span></div>${source}</section><section class="panel"><div class="panel-title"><h2>Portal entry</h2><span>CONTROLLED WRITE</span></div>${action}</section></div>`,
      ),
    );
  });
  app.post("/invoices/:id", (req, res) => {
    const result = store.submit(req.params.id, req.body);
    if (result.error)
      return res
        .status(result.error === "not_found" ? 404 : 409)
        .send(
          layout(
            "Submission blocked",
            `<a class="back" href="/invoices/${escape(req.params.id)}">← Source document</a><div role="alert" class="warning"><h1>Submission blocked</h1><p>${escape(result.error)}</p></div><p>No portal entry was created.</p>`,
          ),
        );
    res.set("X-Invoice-Entry-ID", result.entry.id);
    res.set("X-Invoice-Source-ID", encodeURIComponent(req.params.id));
    res.set("X-Invoice-Replayed", "false");
    res.redirect(303, `/invoices/${encodeURIComponent(req.params.id)}?saved=1`);
  });
  app.get("/api/state", (_req, res) => res.json(store.read()));
  return app;
}

export function startServer(file, port = 8787) {
  return new Promise((resolve) => {
    const server = createApp(file).listen(port, "127.0.0.1", () =>
      resolve(server),
    );
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const file = path.resolve(
    process.env.INVOICE_WORKSPACE_FILE || "workspace.json",
  );
  startServer(file, Number(process.env.PORT || 8787)).then(() =>
    console.log("Invoice portal listening on 127.0.0.1"),
  );
}
