# Invoice portal processor

A Claude tool-use agent reads synthetic invoices in a local accounts payable portal and enters approved values using **real Playwright browser actions**. The portal saves exact original entries to a versioned JSON workspace. Every model action records a page observation and real private screenshot.

## Run locally

Requires **Node 24+**, npm, and Chromium for Playwright. Node's built-in SQLite supplies the cooperating-process mutex; JSON remains the business source of truth.

```sh
npm ci
npx playwright install chromium
mkdir -m 700 local-run
node --input-type=module -e 'import fs from "node:fs"; fs.copyFileSync("fixtures/starter.json", "local-run/workspace.json", fs.constants.COPYFILE_EXCL)'
INVOICE_WORKSPACE_FILE=local-run/workspace.json npm run portal
```

In another terminal, set `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` to your account's enabled model, then run:

```sh
INVOICE_OUTPUT_ROOT=local-run/artifacts npm run operate -- "Enter approved invoice DOC-001 into the portal, then verify the saved entry"
```

Neither model nor key has a scripted fallback. The pinned SDK uses an explicit validated endpoint, zero retries and bounded execution. Original HTTP completion is checked before SDK parsing and browser actions. Browser HTTP resources and forms stay on the configured exact loopback origin; fonts use local fallbacks. Tests control HTTP responses through the actual SDK and do not call a paid provider.

`INVOICE_PORTAL_URL`, `INVOICE_WORKSPACE_FILE`, `INVOICE_OUTPUT_ROOT`, `ANTHROPIC_BASE_URL` and `PORT` are configurable; see [.env.example](.env.example). The portal URL must be a loopback HTTP root without credentials/query/fragment. The provider requires HTTPS or controlled loopback HTTP.

Each run creates a fresh private `<output-root>/<run-id>/trace.json` and viewport PNGs. Receipts bind task/instruction/source hashes, complete initial/final portal facts, original provider requests/decoded responses/usage/errors, separately labeled SDK reports, prepared browser form intents, original-request recovery and resource cleanup. Missing/cache/zero counters remain distinct; cost stays unknown. Keep these files private: they contain source, form and conversation data.

## Source authority and recovery

| Source | Condition | Expected portal result |
| --- | --- | --- |
| DOC-001 | Approved, exact CAD totals | One original entry after exact fields are entered |
| DOC-002 | Missing due date | Blocked |
| DOC-003 | Subtotal plus tax differs from total | Blocked |
| DOC-004 | Same vendor/invoice number as DOC-001 | Blocked after DOC-001 submits |
| DOC-005 | Approval pending | Blocked |

The source panel shows actual approval, exact decimal money **and raw cents**. Supported demo currencies are CAD, USD, EUR and GBP, each with two minor units. Real Gregorian dates, due date order, safe nonnegative integer cents, BigInt addition, approved source, exact vendor ID and every original field are server authority. Invoice duplicate identity uses NFC, trimmed uppercase invoice text while preserving punctuation and the exact vendor ID. Readable business conflicts stay inspectable; structurally invalid source/history is refused without repair.

Every form carries a stable request ID and a token binding the same displayed source revision, approval, values, vendor facts and workspace instance. An exact repeat returns the original immutable entry or rejection, even after a later source correction/revocation, without another audit event or revision change. Changed payload/source under that request ID fails. A fresh request needs a fresh review. Original entry pages preserve recorded values/vendor/time; unknown legacy provenance is explicitly unknown.

JSON transactions use a persistent private SQLite mutex across cooperating processes, private unique staged files, flush/rename/parent sync and prepublication cancellation/source checks. Original history cannot be replaced through source edits. Crashed processes release their OS lock. Preserve the sidecar inode for the lifetime of that workspace. Start a new scenario in a **new directory/file**; overwriting a running workspace or removing its lock is unsupported. See [SOURCE.md](SOURCE.md) for the contract and limits.

A failed acknowledgement may follow a committed entry. The operator retains the prepared exact intent and correlates its original persisted request during final readback. It reports `entry_recorded`, `entry_confirmed` or `no_new_entry` from evidence, with unrelated human changes separate. If neither a valid acknowledgement nor original request can be confirmed, it returns failure with uncertain intent. Provider, cancellation, browser or recording failure retains any known committed ID beside the receipt path. Do not replace an uncertain original request with a new ID before recovery.

## Verification and limits

`npm test` qualifies **125 offline checks**, including actual Anthropic SDK/public controlled HTTP → real Chromium → portal flows, exact large-cent entry, strict source/history corruption refusal, original success/rejection recovery, uncertain commit recovery, cross-process same/competing submissions, mutex contention/replacement and process crashes before/after publication. Native completion, all-step raw usage/errors, budgets, stalled/late responses, browser startup/closure, private recording faults and partial effects remain covered. Original injected-client tests are labeled separately.

[COMPATIBILITY.md](COMPATIBILITY.md) defines ownership, bounds and evidence scope. Rich deterministic hash-bound datasets, exclusive private case CLI and a fresh locked source archive remain active in [PLAN.md](PLAN.md). No live Claude judgment, billing, Firedrill integration or financial transfer is claimed. Live model/new Firedrill/publication/license gates remain parked.

Dependencies are pinned in `package-lock.json`. This repository is private and intentionally has no license pending the portfolio decision.

Explore the [Firedrill example catalog](https://github.com/firedrill-tools/firedrill-example-catalog). Product/setup references: [Firedrill](https://firedrill.run/) and [official developer documentation](https://docs.firedrill.run/); use the documentation matching a qualified release.
