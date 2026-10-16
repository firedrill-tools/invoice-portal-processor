import { createHash, randomUUID } from "node:crypto";
export class StateError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
export const fields = [
  "vendor_id",
  "invoice_number",
  "issued_on",
  "due_on",
  "currency",
];
export const amounts = ["subtotal_cents", "tax_cents", "total_cents"];
export const valueFields = [...fields, ...amounts];
export const currencies = ["CAD", "USD", "EUR", "GBP"];
export const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    record(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
export const sha = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || value instanceof Uint8Array
        ? value
        : canonical(value),
    )
    .digest("hex");
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function need(value, message) {
  if (!value) throw new StateError("invalid_state", message);
}
function keys(value, required, optional = []) {
  need(
    record(value) &&
      required.every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every((key) =>
        [...required, ...optional].includes(key),
      ),
    "Unsupported or incomplete source record",
  );
}
export function id(value) {
  return (
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value)
  );
}
const text = (value) =>
  typeof value === "string" &&
  Boolean(value.trim()) &&
  value.length <= 2000 &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const integer = (value, minimum = 0) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
const token = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function date(value) {
  return (
    typeof value === "string" &&
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) &&
    value.slice(0, 4) !== "0000" &&
    Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
  );
}
export function timestamp(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().replace(".000Z", "Z") ===
      value.replace(".000Z", "Z")
  );
}
export const canonicalInvoice = (value) =>
  typeof value === "string" ? value.normalize("NFC").trim().toUpperCase() : "";
export const duplicateKey = (invoice) =>
  JSON.stringify([invoice.vendor_id, canonicalInvoice(invoice.invoice_number)]);
export function validateInvoice(invoice, data) {
  if (invoice.approval !== "approved") return "approval_required";
  if (
    valueFields.some(
      (key) =>
        invoice[key] === undefined ||
        invoice[key] === null ||
        (typeof invoice[key] === "string" && !invoice[key].trim()),
    )
  )
    return "source_missing_field";
  if (
    fields.some(
      (key) =>
        typeof invoice[key] !== "string" ||
        invoice[key] !== invoice[key].trim(),
    )
  )
    return "source_invalid_field";
  if (
    !date(invoice.issued_on) ||
    !date(invoice.due_on) ||
    invoice.due_on < invoice.issued_on
  )
    return "source_invalid_date";
  if (!currencies.includes(invoice.currency))
    return "source_unsupported_currency";
  if (amounts.some((key) => !integer(invoice[key])))
    return "source_invalid_amount";
  if (
    BigInt(invoice.subtotal_cents) + BigInt(invoice.tax_cents) !==
    BigInt(invoice.total_cents)
  )
    return "source_total_mismatch";
  if (!data.vendors.some((vendor) => vendor.id === invoice.vendor_id))
    return "unknown_vendor";
  return null;
}
function vendor(value) {
  keys(value, ["id", "name"]);
  need(id(value.id) && text(value.name), "Invalid vendor");
}
function invoice(value) {
  keys(value, ["id", "approval", "revision"], valueFields);
  need(
    id(value.id) &&
      integer(value.revision, 1) &&
      ["approved", "pending", "rejected"].includes(value.approval),
    "Invalid invoice identity/revision/approval",
  );
  for (const key of fields)
    if (value[key] !== undefined && value[key] !== null)
      need(
        typeof value[key] === "string" &&
          value[key].length <= 2000 &&
          !/[\u0000-\u001f\u007f]/.test(value[key]),
        "Invalid invoice text field",
      );
  for (const key of amounts)
    if (value[key] !== undefined && value[key] !== null)
      need(
        typeof value[key] === "number" &&
          Number.isFinite(value[key]) &&
          Math.abs(value[key]) <= Number.MAX_SAFE_INTEGER,
        "Unsafe invoice amount representation",
      );
}
export function entryNumber(value) {
  if (typeof value !== "string" || !/^ENT-[0-9]{4,16}$/.test(value))
    return null;
  const number = Number(value.slice(4));
  return integer(number, 1) &&
    value === `ENT-${String(number).padStart(4, "0")}`
    ? number
    : null;
}
export function sourceToken(data, source, vendorSnapshot) {
  return sha({
    instance_id: data.instance_id,
    invoice: source,
    vendor: vendorSnapshot ?? null,
  });
}
export function reviewed(data, id) {
  const source = data.invoices.find((item) => item.id === id);
  if (!source) return null;
  const found =
    data.vendors.find((item) => item.id === source.vendor_id) ?? null;
  return {
    invoice: structuredClone(source),
    vendor: structuredClone(found),
    expected_source_token: sourceToken(data, source, found),
  };
}
const wireKeys = [
  "request_id",
  "expected_source_token",
  "revision",
  ...valueFields,
];
export function parseSubmission(sourceId, input) {
  if (
    !id(sourceId) ||
    !record(input) ||
    Object.keys(input).sort().join(",") !== [...wireKeys].sort().join(",")
  )
    throw new StateError(
      "invalid_request",
      "Submit the exact reviewed source token, stable request ID and complete form",
    );
  if (
    !id(input.request_id) ||
    !token(input.expected_source_token) ||
    typeof input.revision !== "string" ||
    !/^[1-9][0-9]*$/.test(input.revision) ||
    !integer(Number(input.revision), 1)
  )
    throw new StateError(
      "invalid_request",
      "Invalid original request identity, source token or revision",
    );
  for (const key of valueFields)
    if (
      typeof input[key] !== "string" ||
      input[key].length > 2000 ||
      /[\u0000-\u001f\u007f]/.test(input[key])
    )
      throw new StateError(
        "invalid_request",
        "Form values must be exact bounded strings",
      );
  const value = Object.fromEntries(wireKeys.map((key) => [key, input[key]]));
  return {
    input: value,
    intent_sha256: sha({ source_id: sourceId, input: value }),
  };
}
export function newState(legacy) {
  keys(legacy, ["vendors", "invoices", "entries", "audit"]);
  for (const [key, maximum] of [
    ["vendors", 500],
    ["invoices", 1000],
    ["entries", 2000],
    ["audit", 10000],
  ])
    need(
      Array.isArray(legacy[key]) && legacy[key].length <= maximum,
      "Invalid legacy source collection",
    );
  return {
    schema_version: 1,
    instance_id: randomUUID(),
    revision: 1,
    ...structuredClone(legacy),
    legacy_entry_ids: legacy.entries.map((entry) => entry?.id),
    legacy_audit_count: legacy.audit.length,
    submissions: [],
  };
}
export function validateState(data) {
  keys(data, [
    "schema_version",
    "instance_id",
    "revision",
    "vendors",
    "invoices",
    "entries",
    "audit",
    "legacy_entry_ids",
    "legacy_audit_count",
    "submissions",
  ]);
  need(
    data.schema_version === 1 &&
      uuid(data.instance_id) &&
      integer(data.revision, 1),
    "Unsupported source version/identity/revision",
  );
  for (const [name, maximum] of [
    ["vendors", 500],
    ["invoices", 1000],
    ["entries", 2000],
    ["audit", 10000],
    ["submissions", 5000],
  ])
    need(
      Array.isArray(data[name]) && data[name].length <= maximum,
      "Source collection exceeds its bounded shape",
    );
  need(
    data.revision > data.submissions.length,
    "Workspace revision predates original requests",
  );
  const vendorIds = new Set(),
    sourceIds = new Set();
  for (const item of data.vendors) {
    vendor(item);
    need(!vendorIds.has(item.id), "Duplicate vendor ID");
    vendorIds.add(item.id);
  }
  for (const item of data.invoices) {
    invoice(item);
    need(!sourceIds.has(item.id), "Duplicate source ID");
    sourceIds.add(item.id);
  }
  need(
    Array.isArray(data.legacy_entry_ids) &&
      new Set(data.legacy_entry_ids).size === data.legacy_entry_ids.length &&
      data.legacy_entry_ids.every((entry) => entryNumber(entry) !== null),
    "Invalid legacy entry provenance",
  );
  need(
    integer(data.legacy_audit_count) &&
      data.legacy_audit_count <= data.audit.length,
    "Invalid legacy audit boundary",
  );
  const entries = new Map(),
    entryKeys = new Set(),
    sourceEntries = new Set();
  for (const item of data.entries) {
    keys(item, ["id", "source_id", ...valueFields], ["provenance"]);
    const number = entryNumber(item.id);
    need(
      number !== null && !entries.has(item.id) && id(item.source_id),
      "Invalid entry identity",
    );
    const pseudo = {
      id: item.source_id,
      revision: 1,
      approval: "approved",
      ...Object.fromEntries(valueFields.map((key) => [key, item[key]])),
    };
    invoice(pseudo);
    need(
      validateInvoice(pseudo, { vendors: [{ id: item.vendor_id }] }) === null,
      "Committed entry has invalid original business values",
    );
    const key = duplicateKey(item);
    need(
      !entryKeys.has(key) && !sourceEntries.has(item.source_id),
      "Duplicate committed invoice/source",
    );
    entryKeys.add(key);
    sourceEntries.add(item.source_id);
    entries.set(item.id, item);
    if (!Object.hasOwn(item, "provenance")) {
      need(
        data.legacy_entry_ids.includes(item.id),
        "Missing original entry provenance",
      );
      continue;
    }
    need(
      !data.legacy_entry_ids.includes(item.id),
      "Legacy entry must not invent provenance",
    );
    const p = item.provenance;
    need(record(p), "Invalid original entry provenance");
    if (p.kind === "portal_submission")
      keys(p, [
        "kind",
        "request_id",
        "expected_source_token",
        "source_snapshot",
        "vendor_snapshot",
        "at",
        "actor_run_id",
      ]);
    else {
      keys(p, [
        "kind",
        "source_snapshot",
        "vendor_snapshot",
        "at",
        "actor_label",
      ]);
      need(
        p.kind === "human_import" && text(p.actor_label),
        "Unsupported entry provenance",
      );
    }
    invoice(p.source_snapshot);
    vendor(p.vendor_snapshot);
    need(
      timestamp(p.at) &&
        p.source_snapshot.id === item.source_id &&
        validateInvoice(p.source_snapshot, { vendors: [p.vendor_snapshot] }) ===
          null,
      "Invalid original reviewed source/entry time",
    );
    need(
      valueFields.every((key) => item[key] === p.source_snapshot[key]),
      "Entry differs from original reviewed values",
    );
    const current = data.invoices.find(
      (source) => source.id === item.source_id,
    );
    if (current) {
      need(
        current.revision >= p.source_snapshot.revision,
        "Current source revision predates its entry",
      );
      if (current.revision === p.source_snapshot.revision)
        need(
          canonical(current) === canonical(p.source_snapshot),
          "Changed source requires a new source revision",
        );
    }
    if (p.kind === "portal_submission")
      need(
        id(p.request_id) &&
          token(p.expected_source_token) &&
          (p.actor_run_id === null || uuid(p.actor_run_id)) &&
          sourceToken(data, p.source_snapshot, p.vendor_snapshot) ===
            p.expected_source_token,
        "Invalid original submission provenance",
      );
  }
  need(
    data.legacy_entry_ids.every((id) => entries.has(id)),
    "Legacy entry provenance references missing history",
  );
  const requests = new Map();
  for (const item of data.submissions) {
    keys(item, [
      "request_id",
      "source_id",
      "intent",
      "intent_sha256",
      "status",
      "entry_id",
      "entry_sha256",
      "error",
      "at",
      "actor_run_id",
      "source_snapshot",
      "vendor_snapshot",
      "blocking_entry_id",
    ]);
    let parsed;
    try {
      parsed = parseSubmission(item.source_id, item.intent);
    } catch {
      throw new StateError(
        "invalid_state",
        "Original request intent is invalid",
      );
    }
    need(
      id(item.request_id) &&
        item.request_id === item.intent.request_id &&
        !requests.has(item.request_id) &&
        token(item.intent_sha256) &&
        item.intent_sha256 === parsed.intent_sha256 &&
        timestamp(item.at) &&
        (item.actor_run_id === null || uuid(item.actor_run_id)),
      "Invalid original request identity/time/intent",
    );
    if (item.source_snapshot !== null) {
      invoice(item.source_snapshot);
      need(
        item.source_snapshot.id === item.source_id,
        "Original request source identity changed",
      );
      if (item.vendor_snapshot !== null) {
        vendor(item.vendor_snapshot);
        need(
          item.vendor_snapshot.id === item.source_snapshot.vendor_id,
          "Original request vendor identity changed",
        );
      }
      const current = data.invoices.find(
        (source) => source.id === item.source_id,
      );
      if (current) {
        need(
          current.revision >= item.source_snapshot.revision,
          "Current source predates original request",
        );
        if (current.revision === item.source_snapshot.revision)
          need(
            canonical(current) === canonical(item.source_snapshot),
            "Source facts changed without a revision",
          );
      }
    } else
      need(
        item.vendor_snapshot === null,
        "Absent original source has vendor provenance",
      );
    need(
      ["submitted", "rejected"].includes(item.status),
      "Invalid original request outcome",
    );
    if (item.status === "submitted") {
      const entry = entries.get(item.entry_id);
      need(
        item.source_snapshot !== null &&
          item.vendor_snapshot !== null &&
          item.blocking_entry_id === null,
        "Committed request lacks original review facts",
      );
      need(
        entry &&
          entry.provenance?.kind === "portal_submission" &&
          entry.provenance.request_id === item.request_id &&
          entry.provenance.expected_source_token ===
            item.intent.expected_source_token &&
          entry.provenance.at === item.at &&
          entry.provenance.actor_run_id === item.actor_run_id &&
          item.entry_sha256 === sha(entry) &&
          item.error === null,
        "Original request/entry binding is broken",
      );
      need(
        entry.source_id === item.source_id &&
          String(entry.provenance.source_snapshot.revision) ===
            item.intent.revision &&
          valueFields.every((key) => String(entry[key]) === item.intent[key]),
        "Original request differs from committed values",
      );
      need(
        canonical(item.source_snapshot) ===
          canonical(entry.provenance.source_snapshot) &&
          canonical(item.vendor_snapshot) ===
            canonical(entry.provenance.vendor_snapshot),
        "Original request/entry review facts differ",
      );
    } else {
      need(
        item.entry_id === null &&
          item.entry_sha256 === null &&
          text(item.error),
        "Invalid original rejection",
      );
      const source = item.source_snapshot,
        available = [...entries.values()].filter(
          (entry) =>
            entry.provenance?.kind !== "portal_submission" ||
            requests.has(entry.provenance.request_id),
        );
      let expected = source
          ? validateInvoice(source, {
              vendors: item.vendor_snapshot ? [item.vendor_snapshot] : [],
            })
          : "not_found",
        blocking = null;
      if (!expected && Number(item.intent.revision) !== source.revision)
        expected = "stale_revision";
      if (
        !expected &&
        item.intent.expected_source_token !==
          sourceToken(data, source, item.vendor_snapshot)
      )
        expected = "stale_source";
      if (!expected) {
        blocking =
          available.find((entry) => entry.source_id === item.source_id) ?? null;
        if (blocking) expected = "already_submitted";
      }
      if (!expected) {
        blocking =
          available.find(
            (entry) => duplicateKey(entry) === duplicateKey(source),
          ) ?? null;
        if (blocking) expected = "duplicate_invoice";
      }
      if (!expected && fields.some((key) => item.intent[key] !== source[key]))
        expected = "field_mismatch";
      if (
        !expected &&
        amounts.some(
          (key) =>
            !/^(0|[1-9][0-9]*)$/.test(item.intent[key]) ||
            !Number.isSafeInteger(Number(item.intent[key])) ||
            Number(item.intent[key]) !== source[key],
        )
      )
        expected = "amount_mismatch";
      if (
        !expected &&
        available.some(
          (entry) => entryNumber(entry.id) === Number.MAX_SAFE_INTEGER,
        )
      )
        expected = "entry_limit";
      need(
        expected !== null &&
          item.error === expected &&
          item.blocking_entry_id === (blocking?.id ?? null),
        "Original rejection contradicts source/intent/prior entries",
      );
    }
    requests.set(item.request_id, item);
  }
  for (const item of entries.values())
    if (item.provenance?.kind === "portal_submission")
      need(
        requests.get(item.provenance.request_id)?.entry_id === item.id,
        "Portal entry has no original request",
      );
  let previousTime = -Infinity;
  const auditRequests = new Set();
  data.audit.forEach((item, index) => {
    if (index < data.legacy_audit_count) {
      if (item.action === "submitted") {
        keys(item, ["action", "source_id", "entry_id"]);
        need(
          data.legacy_entry_ids.includes(item.entry_id) &&
            entries.get(item.entry_id)?.source_id === item.source_id,
          "Legacy audit references wrong entry",
        );
      } else {
        keys(item, ["action", "source_id", "reason"]);
        need(
          item.action === "rejected" && text(item.reason),
          "Invalid legacy rejection",
        );
      }
      need(id(item.source_id), "Invalid legacy audit source");
      return;
    }
    keys(item, [
      "id",
      "action",
      "source_id",
      "request_id",
      "entry_id",
      "reason",
      "at",
      "actor_run_id",
    ]);
    const original = requests.get(item.request_id);
    need(
      item.id ===
        `AUD-${String(index - data.legacy_audit_count + 1).padStart(4, "0")}` &&
        original &&
        data.submissions[index - data.legacy_audit_count]?.request_id ===
          item.request_id &&
        !auditRequests.has(item.request_id) &&
        item.source_id === original.source_id &&
        item.action === original.status &&
        item.entry_id === original.entry_id &&
        item.reason === original.error &&
        item.at === original.at &&
        item.actor_run_id === original.actor_run_id,
      "Audit disagrees with original request",
    );
    const time = Date.parse(item.at);
    need(time >= previousTime, "Audit times move backward");
    previousTime = time;
    auditRequests.add(item.request_id);
  });
  need(
    auditRequests.size === requests.size,
    "Original request is missing its one audit event",
  );
  return data;
}
export function money(cents) {
  if (!Number.isSafeInteger(cents)) return "Invalid amount";
  const value = BigInt(cents),
    absolute = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}
