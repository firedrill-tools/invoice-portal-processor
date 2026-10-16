# Invoice source and original request contract

## Workspace

Node24+ is required for the built-in SQLite mutex. `Store` accepts one existing regular JSON file without symlink/hardlink aliases. The real parent path determines its persistent `<file>.lock.sqlite` sidecar. Read, review, source edit, migration and submit all hold an immediate SQLite transaction through JSON validation/publication. The sidecar is a mutex only; it contains no business records, lease/PID or invented scenario state. Keep its inode permanently attached to the workspace. Kernel locks release on process crash; a busy source fails after a 1-second lock wait instead of taking over another writer.

Schema1 has exactly `schema_version`, `instance_id` (fresh UUIDv4), safe positive `revision`, `vendors`, `invoices`, `entries`, `audit`, `legacy_entry_ids`, `legacy_audit_count` and `submissions`. Bounds are 500 vendors, 1000 invoices, 2000 entries, 10000 audit rows, 5000 original requests and 8MiB JSON. Empty source/vendor lists are valid. The native operator's decoded source snapshot is separately bounded to 1MiB; larger valid workspaces fail its audit rather than losing validation.

Vendors have exact unique ASCII IDs and bounded nonblank names. Invoice IDs/revisions/approval are mandatory; business fields may be absent/null/blank or contain readable date/currency/total conflicts. Unsafe numeric representations, wrong types, unknown fields, duplicate IDs and structurally incoherent committed history are rejected. The server shows readable conflicts but cannot commit them.

For approved complete sources, issue/due dates must be real canonical YYYY-MM-DD Gregorian dates with due >= issue. This demo supports CAD/USD/EUR/GBP (two minor units). Cents must be safe nonnegative integers; BigInt validates addition and renders exact money. Invoice identity is `[exact vendor ID, NFC(trim(invoice number)).toUpperCase()]`; punctuation is preserved. Vendor names never merge identities. Current vendor/source may be retired without rewriting historical facts.

The previous four-array `{vendors,invoices,entries,audit}` format migrates atomically after full validation. Original entry array order, noncontiguous IDs, values and legacy audit prefix remain unchanged. Legacy IDs and audit boundary explicitly mark unknown prior provenance. The migration does not invent human actors, timestamps, model history or original requests. New IDs advance from the greatest canonical safe original ENT number. Canonical duplicates or malformed legacy history stop migration without changing bytes.

## Reviewed form and immutable intent

A coherent read renders displayed source/vendor facts and hidden request/token/revision together. The token hashes the workspace instance, complete invoice including actual approval/revision and exact vendor snapshot. Unrelated transactions do not invalidate it; a different case instance does. It is a coherence fingerprint, not authentication.

POST `/invoices/:id` accepts exactly eleven string fields:

- `request_id`: stable bounded ASCII identity for this original attempt;
- `expected_source_token`: original 64-character lowercase SHA256 fingerprint;
- `revision`: canonical safe positive decimal integer;
- `vendor_id`, `invoice_number`, `issued_on`, `due_on`, `currency`;
- `subtotal_cents`, `tax_cents`, `total_cents`: canonical safe nonnegative decimal integer strings matching source exactly.

Extra, duplicate, non-string, malformed or oversized (16KiB) form fields fail before any business transaction. Model/browser writes always call `Store.submit`. Each fresh well-formed attempt commits exactly one immutable submitted/rejected original request, one matching audit row and a workspace revision; successful attempts also append one entry with original source/vendor/time/request/actor provenance. Actor run IDs are diagnostic labels, not authenticated human identity. Rejections retain the exact decision-time source/vendor/blocking-entry facts and can still be validated after a later correction.

Before fresh business checks, an existing request ID is resolved by its digest of source ID and complete exact form. Exact replay returns the original entry or rejection, without modifying state, even after source approval/value/revision changes. Changed intent under that ID returns `request_reused`. A corrected submission requires a new review and a new request ID. Original entries remain accessible at `/entries/:entry-id`; current source pages link to them.

`Store.write` requires the current workspace instance/revision, preserves committed entries/requests/audit/legacy provenance and requires exactly the next invoice revision for changed existing source facts. It is a developer source-edit API; it cannot seed or replace committed history. Full validation enforces original entry/request/source snapshot hashes, canonical duplicates, outcome reasons, ordered one-event audit bindings and monotonic event times. These are integrity checks within owned files, not cryptographic authentication of arbitrary external edits.

## Publication and recovery

Each transaction rereads and validates under the persistent mutex. Publication uses a unique exclusive0600 staged file, file flush, prepublication guard, unchanged original source hash, unchanged mutex inode, atomic rename and parent directory sync. Entry/request/audit/revision publish together. A failed guard before publication leaves the old source intact. An error during/after attempted rename is `publication_uncertain`: inspect/recover the exact original request, since JSON may already contain the full commit. Do not replay a changed intent or reset a source to hide an uncertain effect.

The server checks disconnect/deadline before publication (5 seconds from request handling). Filesystem calls are synchronous and cannot promise a hard end-to-end cancellation bound. A transport disconnect cannot undo an already dispatched commit. The native browser persists exact prepared request ID/body/digest before POST and labels its owned run. Final validated readback correlates that same persisted original request if acknowledgement is lost; actor/initial-state evidence separates an owned new entry from an existing/human effect. Valid fallback acknowledgement must bind canonical entry ID, exact source, exact original request ID and replay flag. If final source is unavailable and acknowledgement is absent/mismatched, outcome remains failed/uncertain with the prepared intent retained. Changed original history across two otherwise valid source snapshots also fails the run.

Cooperating local processes on a filesystem supporting SQLite locking/atomic same-directory rename are qualified. External editors that ignore the mutex are not cooperating writers: the hash check catches changes observed before publication but is not an OS access sandbox or distributed compare-and-swap. Never unlink/recreate a live mutex. Crash-left staged files belong to their original transaction; normal operations do not delete other writers' files.

## Qualified offline proof

The suite covers complete immutable original success/rejection replay; source/vendor/revision/instance binding; duplicate casing and preserved punctuation; invalid dates/currencies/totals/amounts; large exact cents in actual SDK/Chromium entry; structural/cross-history corruption without repair; existing unordered legacy IDs/audit; prepublish cancellation; uncertain rename/directory sync; actual process contention, unrelated/same/canonical-duplicate submissions, lock inode replacement and crash release before/after commit. These controls concern synthetic local records; no real AP connector, payment, live model or billing proof is implied.
