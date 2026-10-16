# Scenario runs

Use `npm run cases -- list` to inspect twelve hash-bound cases and their human task/focus. [DATA.md](../DATA.md) describes business facts and private initialization. Choose a task explicitly; metadata is not implicit model input.

```sh
mkdir -m 700 local-cases
npm run cases -- init busy local-cases/busy
INVOICE_WORKSPACE_FILE=local-cases/busy/workspace.json npm run portal
```

In another terminal, set your account-enabled ANTHROPIC_MODEL and ANTHROPIC_API_KEY, then use `INVOICE_OUTPUT_ROOT=local-cases/busy/artifacts npm run operate -- "Enter approved DOC-001 and verify the original saved entry."`. Inspect actual source/entry/request/audit facts and private trace/screenshots; model prose alone is not a committed effect.

Busy must preserve all twelve prior human imports and allocate ENT-0080 for one fresh exact DOC-001. Canonical duplicate starts with an original retired case-variant entry and must add none. Already-recorded has a revoked/changed current source but immutable original human values. Missing-field/mismatched-total/pending/date/currency cases remain blocked; large-cents preserves 9007199254740990 exactly. Ambiguous vendor names require the user's exact source/vendor decision; empty inbox cannot invent a source.

Initialize each independent run in a new directory. Keep old source, original requests, receipts and mutex inode for recovery; never overwrite/reset a running workspace. The five-document legacy fixture remains a migration compatibility sample; its DOC-004 duplicate depends on prior DOC-001 submission.

All repository tests use synthetic controlled responses and real local browser/server/state behavior. Live model judgment, usage billing and qualified new Firedrill persisted scenarios remain separate external gates.
