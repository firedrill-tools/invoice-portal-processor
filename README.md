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

The agent uses the Anthropic Messages tool-use protocol. It sends actual page observations back as `tool_result` blocks, calls only the configured local portal, and stores captures plus `trace.json` under `artifacts/<run-id>/`. A missing key is an error; the application never substitutes a fake model. `ANTHROPIC_MODEL`, `INVOICE_PORTAL_URL`, `INVOICE_WORKSPACE_FILE`, and `PORT` are configurable; see `.env.example`. The operator and portal are separate processes.

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

`npm test` runs fourteen offline boundary/protocol checks and a scripted Anthropic tool-use sequence against a real Playwright browser. It checks the saved entry, duplicate and malformed submissions, and capture files. A separate actual installed Anthropic SDK test uses controlled HTTP and Chromium to prove a max_tokens submission cannot dispatch. All parsed messages/tool arguments are checked before action; tool_use is required for calls and a nonblank end_turn without calls for final success. Replayed IDs, malformed calls and contradictory/unfinished/refused turns fail. Confirmation requires a persisted entry, and canonical safe entry numbering preserves noncontiguous prior IDs. These are initial boundaries; full native ownership/raw all-step usage, strict source/recovery, rich cases and distribution remain in [PLAN.md](PLAN.md). The scripted sequence verifies tool wiring and browser behavior; it is **not** evidence of a live Claude decision. No Anthropic key was available for this repository's initial proof, so live model success, provider usage, and Firedrill integration remain pending. The new Firedrill interface must be qualified before connection.

Dependency versions are pinned in `package-lock.json`. This repository is private and intentionally has no license yet; publication and licensing decisions are tracked in the portfolio plan.

Explore related applications in the [Firedrill example catalog](https://github.com/firedrill-tools/firedrill-example-catalog). Product and setup references: [Firedrill](https://firedrill.run/) and the [official developer documentation](https://docs.firedrill.run/). Use documentation matching the qualified release; this repository records its current integration limits above.
