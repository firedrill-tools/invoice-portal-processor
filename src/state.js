import fs from "node:fs";

const fields = ["vendor_id", "invoice_number", "issued_on", "due_on", "currency"];
const money = ["subtotal_cents", "tax_cents", "total_cents"];

export function validateInvoice(invoice, data) {
  if (invoice.approval !== "approved") return "approval_required";
  if (fields.some((key) => !invoice[key])) return "source_missing_field";
  if (money.some((key) => !Number.isSafeInteger(invoice[key]) || invoice[key] < 0)) return "source_invalid_amount";
  if (invoice.subtotal_cents + invoice.tax_cents !== invoice.total_cents) return "source_total_mismatch";
  if (!data.vendors.some((vendor) => vendor.id === invoice.vendor_id)) return "unknown_vendor";
  return null;
}

export class Store {
  constructor(file) { this.file = file; if (!fs.existsSync(file)) throw new Error(`workspace missing: ${file}`); }
  read() { return JSON.parse(fs.readFileSync(this.file, "utf8")); }
  write(data) {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(temp, this.file);
  }
  submit(id, input) {
    const data = this.read();
    const invoice = data.invoices.find((item) => item.id === id);
    let error = invoice ? validateInvoice(invoice, data) : "not_found";
    if (!error && Number(input.revision) !== invoice.revision) error = "stale_revision";
    if (!error && data.entries.some((entry) => entry.source_id === id)) error = "already_submitted";
    if (!error && data.entries.some((entry) => entry.vendor_id === invoice.vendor_id && entry.invoice_number === invoice.invoice_number)) error = "duplicate_invoice";
    if (!error && fields.some((key) => String(input[key] ?? "").trim() !== String(invoice[key]))) error = "field_mismatch";
    if (!error && money.some((key) => !/^(0|[1-9]\d*)$/.test(String(input[key] ?? "")) || Number(input[key]) !== invoice[key])) error = "amount_mismatch";
    if (error) {
      data.audit.push({ action: "rejected", source_id: id, reason: error });
      this.write(data);
      return { error };
    }
    const entry = { id: `ENT-${String(data.entries.length + 1).padStart(4, "0")}`, source_id: id,
      ...Object.fromEntries([...fields, ...money].map((key) => [key, invoice[key]])) };
    data.entries.push(entry);
    data.audit.push({ action: "submitted", source_id: id, entry_id: entry.id });
    this.write(data);
    return { entry };
  }
}
