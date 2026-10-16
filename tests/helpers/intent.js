import { randomUUID } from "node:crypto";
export function intent(store, sourceId, values = {}) {
  const view = store.review(sourceId);
  return {
    request_id: randomUUID(),
    expected_source_token: view?.expected_source_token ?? "0".repeat(64),
    revision: String(view?.invoice.revision ?? 1),
    ...Object.fromEntries(
      [
        "vendor_id",
        "invoice_number",
        "issued_on",
        "due_on",
        "currency",
        "subtotal_cents",
        "tax_cents",
        "total_cents",
      ].map((key) => [key, String(view?.invoice[key] ?? "")]),
    ),
    ...values,
  };
}
export function submit(store, sourceId, values = {}) {
  return store.submit(sourceId, intent(store, sourceId, values));
}
