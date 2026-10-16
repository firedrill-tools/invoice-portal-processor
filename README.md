# Invoice portal processor

A Claude tool-use agent reads synthetic invoices in a local accounts payable portal and enters approved values using **real Playwright browser actions**. The portal saves entries to a JSON workspace and rejects unsupported writes. Each agent action records a screenshot and page observation.

## Run locally

Requires Node 22+, npm, and Chromium for Playwright.

```sh
npm ci
npx playwright install chromium
cp fixtures/starter.json workspace.json
npm run portal
```

In another terminal, set `ANTHROPIC_API_KEY` and run:

```sh
npm run operate -- "Enter approved invoice DOC-001 into the portal, then verify the saved entry"
```

The agent uses the actual pinned Anthropic Messages SDK with an explicit account model/key, no retries and bounded execution. Its original HTTP completion is checked before SDK parsing and browser actions. Tools exchange real page observations and private viewport screenshots. The operator and portal are separate processes; browser HTTP resources/forms stay on the exact configured loopback origin. Fonts use local fallbacks.

Set `ANTHROPIC_MODEL` to an enabled model as well as `ANTHROPIC_API_KEY`. Neither is substituted with a scripted model. `INVOICE_PORTAL_URL`, `INVOICE_WORKSPACE_FILE`, `INVOICE_OUTPUT_ROOT`, `ANTHROPIC_BASE_URL` and `PORT` are configurable; see [.env.example](.env.example). The portal URL is a loopback HTTP root without credentials/query/fragment. The provider requires HTTPS or controlled loopback HTTP. Tests inject controlled HTTP into the real SDK and never call a paid provider.

Each run creates `artifacts/<run-id>/trace.json` plus real PNG captures in a private directory. The receipt contains task/instruction/source hashes, initial/final portal facts, all original provider requests/decoded responses/usage/errors, separately labeled SDK reports, actual browser HTTP submissions and process cleanup. Missing/cache/zero counters remain distinct; cost stays unknown. Existing human state changes and browser-acknowledged entries are recorded separately. Keep local receipts private: they contain source/form/chat data.

If a provider, browser, deadline or recording step fails after a submission, the run returns failure and preserves the acknowledged entry identity. The CLI reports `entry_recorded` or `no_new_entry` from acknowledged effects. Failures include any known committed entry IDs beside the receipt path. An uncertain acknowledgement retains its original form intent and returns failure for inspection before retrying. A fresh browser run can read back an existing entry without claiming a new effect. [COMPATIBILITY.md](COMPATIBILITY.md) defines the exact ownership, limits and evidence scope.

## Cases and controls

| Source | Condition | Expected portal result |
| --- | --- | --- |
| DOC-001 | Approved, exact CAD totals | One entry after all source fields are entered |
| DOC-002 | Missing due date | Blocked |
| DOC-003 | Subtotal plus tax differs from total | Blocked |
| DOC-004 | Same vendor/invoice number as DOC-001 | Blocked after DOC-001 submits |
| DOC-005 | Approval pending | Blocked |

Server validation compares every submitted value with the source record, checks revision and approval, verifies integer-cent arithmetic, and deduplicates by both source ID and vendor/invoice number. It writes an audit event for submitted and rejected attempts. This is a local demo with one server process and a single JSON workspace, not a multi-user AP system. Reset by copying `fixtures/starter.json` over `workspace.json`.

## Verification and limits

`npm test` passes 57 offline checks, including actual Anthropic SDK/public controlled HTTP → real Chromium → portal flows. These cover ordinary entry/readback, raw completion before actions, all-step usage/errors, malformed/refused/unfinished output, budgets, cancellation/stalled bodies/late startup, startup/close faults, recording faults before/after submission and final-state failure. One real submit followed by a provider error retains the original entry; unrelated human writes remain separate from browser effects. The original injected-client browser flow remains explicitly labeled as such.

Strict full source/history/currency/date validation, reviewed submission request recovery, cooperating writers, richer deterministic datasets/private CLI and fresh distribution remain active tasks in [PLAN.md](PLAN.md). The current server still owns its existing approval/value/arithmetic/revision/duplicate gates. No live Claude judgment, billing or Firedrill integration is claimed. The official qualified new Firedrill contract and persisted scenarios remain external gates.

Dependency versions are pinned in `package-lock.json`. This repository is private and intentionally has no license yet; publication and licensing decisions are tracked in the portfolio plan.

Explore related applications in the [Firedrill example catalog](https://github.com/firedrill-tools/firedrill-example-catalog). Product and setup references: [Firedrill](https://firedrill.run/) and the [official developer documentation](https://docs.firedrill.run/). Use documentation matching the qualified release; this repository records its current integration limits above.
