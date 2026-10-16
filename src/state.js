import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  StateError,
  valueFields,
  fields,
  amounts,
  canonical,
  sha,
  id,
  entryNumber,
  duplicateKey,
  newState,
  validateState,
  validateInvoice,
  reviewed,
  parseSubmission,
} from "./state-contracts.js";
import { ownedPath, locked } from "./source-lock.js";
export { StateError, validateInvoice } from "./state-contracts.js";

function load(file) {
  const info = fs.lstatSync(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size > 8388608
  )
    throw new StateError(
      "invalid_state",
      "Source must be an owned regular JSON file of at most 8 MiB",
    );
  const raw = fs.readFileSync(file);
  let value;
  try {
    value = JSON.parse(
      new TextDecoder("utf8", { fatal: true }).decode(raw),
      (_key, item) => {
        if (typeof item === "number" && !Number.isFinite(item))
          throw new Error("Nonfinite source value");
        return item;
      },
    );
  } catch {
    throw new StateError("invalid_state", "Source JSON is invalid");
  }
  return { raw, hash: sha(raw), value };
}
function nextEntryId(entries) {
  const maximum = Math.max(0, ...entries.map((entry) => entryNumber(entry.id)));
  if (maximum === Number.MAX_SAFE_INTEGER)
    throw new StateError("entry_limit", "Portal entry identity limit reached");
  return `ENT-${String(maximum + 1).padStart(4, "0")}`;
}
export class Store {
  constructor(file, options = {}) {
    this.file = ownedPath(file);
    this.options = options;
    this.read();
  }
  atomic(data, expectedHash, guard, checkLock) {
    validateState(data);
    const raw = JSON.stringify(data, null, 2) + "\n";
    if (Buffer.byteLength(raw) > 8388608)
      throw new StateError(
        "state_limit",
        "Source exceeds its 8 MiB publication bound",
      );
    const staged = `${this.file}.${randomUUID()}.tmp`;
    let published = false,
      publicationAttempted = false;
    try {
      const fd = fs.openSync(staged, "wx", 0o600);
      try {
        fs.writeFileSync(fd, raw);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      guard({ phase: "before_publish" });
      checkLock();
      if (load(this.file).hash !== expectedHash)
        throw new StateError(
          "stale_workspace",
          "Source changed outside its transaction; inspect before retrying",
        );
      publicationAttempted = true;
      (this.options.rename ?? fs.renameSync)(staged, this.file);
      published = true;
      const fdDirectory = fs.openSync(path.dirname(this.file), "r");
      try {
        (this.options.syncDirectory ?? fs.fsyncSync)(fdDirectory);
      } finally {
        fs.closeSync(fdDirectory);
      }
    } catch (error) {
      if (published || publicationAttempted)
        throw new StateError(
          "publication_uncertain",
          "Source publication may have succeeded; recover the original request before retrying",
        );
      throw error;
    } finally {
      try {
        fs.unlinkSync(staged);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  transaction(work, guard = () => {}) {
    return locked(
      this.file,
      (checkLock) => {
        let { value: data, hash } = load(this.file);
        if (data?.schema_version === undefined) {
          if (this.options.requireVersioned)
            throw new StateError(
              "invalid_state",
              "Private case requires its original versioned workspace",
            );
          data = newState(data);
          validateState(data);
          this.atomic(data, hash, guard, checkLock);
          hash = load(this.file).hash;
        }
        validateState(data);
        return work(data, (value) =>
          this.atomic(value, hash, guard, checkLock),
        );
      },
      guard,
    );
  }
  read() {
    return this.transaction((data) => structuredClone(data));
  }
  review(sourceId) {
    if (!id(sourceId))
      throw new StateError("invalid_request", "Exact source ID required");
    return this.transaction((data) => reviewed(data, sourceId));
  }
  write(value, { guard = () => {} } = {}) {
    return this.transaction((current, publish) => {
      if (
        value.instance_id !== current.instance_id ||
        value.revision !== current.revision
      )
        throw new StateError(
          "stale_workspace",
          "Source edit must use the current workspace identity/revision",
        );
      for (const key of [
        "entries",
        "audit",
        "legacy_entry_ids",
        "legacy_audit_count",
        "submissions",
      ])
        if (canonical(value[key]) !== canonical(current[key]))
          throw new StateError(
            "immutable_history",
            "Source edits cannot replace committed original history",
          );
      for (const source of value.invoices) {
        const old = current.invoices.find((row) => row.id === source.id);
        if (old && canonical(old) !== canonical(source)) {
          if (old.revision === Number.MAX_SAFE_INTEGER)
            throw new StateError(
              "revision_limit",
              "Source revision limit reached",
            );
          if (source.revision !== old.revision + 1)
            throw new StateError(
              "stale_revision",
              "A changed source requires exactly the next source revision",
            );
        }
      }
      if (current.revision === Number.MAX_SAFE_INTEGER)
        throw new StateError(
          "revision_limit",
          "Workspace revision limit reached",
        );
      const data = structuredClone(value);
      data.revision = current.revision + 1;
      publish(data);
      return structuredClone(data);
    }, guard);
  }
  submit(sourceId, input, { guard = () => {}, actorRunId = null } = {}) {
    const parsed = parseSubmission(sourceId, input);
    if (
      actorRunId !== null &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        actorRunId,
      )
    )
      throw new StateError("invalid_request", "Invalid run attribution label");
    return this.transaction((data, publish) => {
      const prior = data.submissions.find(
        (item) => item.request_id === parsed.input.request_id,
      );
      if (prior) {
        if (prior.intent_sha256 !== parsed.intent_sha256)
          return {
            error: "request_reused",
            request_id: prior.request_id,
            replayed: false,
          };
        return prior.status === "submitted"
          ? {
              entry: structuredClone(
                data.entries.find((entry) => entry.id === prior.entry_id),
              ),
              request_id: prior.request_id,
              replayed: true,
            }
          : {
              error: prior.error,
              request_id: prior.request_id,
              replayed: true,
            };
      }
      const source = data.invoices.find((item) => item.id === sourceId),
        view = source ? reviewed(data, sourceId) : null;
      let error = source ? validateInvoice(source, data) : "not_found";
      if (!error && Number(parsed.input.revision) !== source.revision)
        error = "stale_revision";
      if (
        !error &&
        parsed.input.expected_source_token !== view.expected_source_token
      )
        error = "stale_source";
      let blocker = null;
      if (!error) {
        blocker =
          data.entries.find((entry) => entry.source_id === sourceId) ?? null;
        if (blocker) error = "already_submitted";
      }
      if (!error) {
        blocker =
          data.entries.find(
            (entry) => duplicateKey(entry) === duplicateKey(source),
          ) ?? null;
        if (blocker) error = "duplicate_invoice";
      }
      if (!error && fields.some((key) => parsed.input[key] !== source[key]))
        error = "field_mismatch";
      if (
        !error &&
        amounts.some(
          (key) =>
            !/^(0|[1-9][0-9]*)$/.test(parsed.input[key]) ||
            !Number.isSafeInteger(Number(parsed.input[key])) ||
            Number(parsed.input[key]) !== source[key],
        )
      )
        error = "amount_mismatch";
      if (data.revision === Number.MAX_SAFE_INTEGER)
        throw new StateError(
          "revision_limit",
          "Workspace revision limit reached",
        );
      const at = new Date().toISOString(),
        last = data.audit.at(-1);
      if (last?.at && at < last.at)
        throw new StateError(
          "history_clock",
          "Current clock predates original audit history",
        );
      let entry = null,
        allocated = null;
      if (!error) {
        try {
          allocated = nextEntryId(data.entries);
        } catch (failure) {
          if (failure.code !== "entry_limit") throw failure;
          error = "entry_limit";
        }
      }
      if (!error) {
        entry = {
          id: allocated,
          source_id: sourceId,
          ...Object.fromEntries(valueFields.map((key) => [key, source[key]])),
          provenance: {
            kind: "portal_submission",
            request_id: parsed.input.request_id,
            expected_source_token: parsed.input.expected_source_token,
            source_snapshot: structuredClone(source),
            vendor_snapshot: view.vendor,
            at,
            actor_run_id: actorRunId,
          },
        };
        data.entries.push(entry);
      }
      data.submissions.push({
        request_id: parsed.input.request_id,
        source_id: sourceId,
        intent: parsed.input,
        intent_sha256: parsed.intent_sha256,
        status: error ? "rejected" : "submitted",
        entry_id: entry?.id ?? null,
        entry_sha256: entry ? sha(entry) : null,
        error: error ?? null,
        at,
        actor_run_id: actorRunId,
        source_snapshot: source ? structuredClone(source) : null,
        vendor_snapshot: view?.vendor ?? null,
        blocking_entry_id: blocker?.id ?? null,
      });
      data.audit.push({
        id: `AUD-${String(data.audit.length - data.legacy_audit_count + 1).padStart(4, "0")}`,
        action: error ? "rejected" : "submitted",
        source_id: sourceId,
        request_id: parsed.input.request_id,
        entry_id: entry?.id ?? null,
        reason: error ?? null,
        at,
        actor_run_id: actorRunId,
      });
      data.revision++;
      publish(data);
      return error
        ? { error, request_id: parsed.input.request_id, replayed: false }
        : {
            entry: structuredClone(entry),
            request_id: parsed.input.request_id,
            replayed: false,
          };
    }, guard);
  }
}
