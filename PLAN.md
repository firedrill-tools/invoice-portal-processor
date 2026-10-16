# Invoice portal development audit

## Required behavior

Project #22 reads synthetic invoices and enters approved information through real browser actions. Missing/incorrect source fields, exact totals, approval, stale source and duplicate submissions are server authority. Model prose and a query string cannot establish a committed entry. Prior human entries and original facts must survive recovery, concurrent requests and case initialization.

## Reproduced baseline and first fixes

- Actual portal GET `/invoices/DOC-005?saved=1` displayed “Invoice submitted” even though approval was pending and no entry existed. Confirmation now requires an actual existing source entry.
- Actual installed Anthropic SDK0.134.0, its public controlled fetch seam and real Playwright browser: nine ordinary tool responses filled the approved form; response10 used stop_reason=max_tokens for Submit invoice. The old operator submitted, then accepted response11 final prose. The parsed native completion gate now validates the whole message and all strict known tool arguments before any browser action; only tool_use may dispatch calls and only nonblank end_turn with no calls may succeed. Unsupported/missing/unfinished/refusal/mismatched turns, replayed IDs and malformed calls fail. Bounds are 32 calls/message and 128 accepted call IDs; the existing 18-round loop remains. This is a parsed SDK boundary, not yet raw HTTP evidence or fully owned execution.
- An existing original ENT-0002 caused length+1 allocation to create another ENT-0002. Allocation now derives the maximum original canonical safe numeric identity, rejects malformed/duplicate/exhausted existing identity and preserves prior records. New entry is ENT-0003 in that case.
- Fourteen checks pass locally, including the original scripted ordinary browser flow, actual native SDK truncated-submit prevention, confirmation and noncontiguous-ID recovery. Native baseline had 11 controlled provider responses each reporting input10/output5; exposed result.usage retained only last10/5. Preserve original all-step counters/failures next. No live model or billing occurred.

## Completed native/browser checkpoint

Actual owned AnthropicSDK0.134.0 JSON HTTP now validates original completion before SDK parsing/actions, preserves all original bodies/IDs/unknown fields/independent usage/error reports and separates SDK/caller reports. Explicit model/key/endpoint, zero retries, 18 prepared requests, 1800 requested output tokens, 32 calls/message/128 accepted calls, operation/HTTP/browser limits and parent cancellation are recorded. Thinking/redacted metadata is preserved; empty/truncated/refused/malformed/mismatched output cannot act or succeed. Request count/tool-only exhaustion, oversized batches, missing/zero/partial/invalid/independent counters and failed attempt usage are qualified.

Owned Chromium BrowserServer/process, connection and fresh context close on completion/failure/startup faults; late startup/fetch resources have cleanup handlers. Browser HTTP requests are fenced before dispatch to exact origin/page; only a current single-use submit action grants invoice POST. Source font import was caught by the fence and removed. Real form bytes and original entry/source/replay acknowledgement headers preserve committed identities, with unrelated state deltas separate from browser effects. Uncertain acknowledgement fails rather than releasing successful prose. Read-only final source audit has a separate bounded cleanup phase.

Private atomic flushed receipts/captures record prepared work before dispatch and retain partial effects on provider/browser/recording/cancellation/final-source errors. Native operations and browser evidence writers drain before final publication; a delayed recording cancellation case reproduced the ordering risk and now leaves a stable final receipt. If storage cannot confirm final recording, the caller receives failure and the last durable file may be uncertain. Caller-injected client reports/pools remain caller-owned. See COMPATIBILITY.md for bounded scope and the absence of hard wire/heap/billing guarantees.

Fifty-seven checks include real native ordinary submission/readback, every failure boundary above, original scripted ordinary browser flow and actual truncated-submit prevention. Verify exact-head Linux CI/catalog for this checkpoint. Strict source/intents/history/data/distribution remain below; no live model proof.

## Independent work next

1. Strict complete source/vendor/invoice/entry/audit schemas that keep readable business conflicts (missing field, mismatched total, pending approval), exact dates/currency/minor units and canonical duplicate identity. Source panel headings must reflect actual approval; its current fixed “Approved source” heading also appears for pending documents. Bind stable submission request IDs to exact reviewed source/approval/vendor/values and explicit original provenance. Exact original recovery returns immutable entry without another effect; changed intent fails. Preserve original human entries/IDs/times and unknown legacy provenance without inventing prior runs.
2. Private unique atomic JSON publication, precommit cancellation/source binding and real cooperating writer concurrency. Qualify a persistent Node24 SQLite mutex sidecar solely for cross-process JSON transactions: never unlink/replace its inode, kernel releases locks on crash; hold it through read/validation/publication and preserve uncertain JSON commit for original-request recovery. Current JSON store remains single-process qualified; source-read/approval/form fingerprints remain to be completed.
3. Rich deterministic hash-bound starter/busy/ambiguous/boundary cases with vendors/documents/prior human entries/noncontiguous IDs and exact state relationships. Human task/focus excluded from implicit prompts; no provider answer matching. Exclusive private key-free list/init/show CLI and complete locked source archive verified outside checkout with native/browser/negative/recovery paths.
4. Verify all final gates/exact-head CI/catalog, then #27/#31/#36/#40 and Wave3.

## Parked external gates

Live Claude key/model/budget and human semantic review; qualified official new Firedrill contract/persisted scenarios/CI; publication/license choice. The local example has no external AP/finance connector or financial transfer. No retired/invented Firedrill API. Continue independent development without waiting for these gates.

Protocol references: [official stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons), [official TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) and installed pinned SDK source. Documentation distinguishes these offline controlled SDK/browser results from live judgments.
