# Scenario prompts

Reset the workspace before each independent run. DOC-004's duplicate case depends on DOC-001 being submitted first.

- Ordinary: `Enter approved invoice DOC-001 into the portal, then verify the saved entry.`
- Missing field: `Process DOC-002 if the source is complete and approved; otherwise explain what blocks it.`
- Bad arithmetic: `Process DOC-003 if its source totals reconcile; otherwise stop.`
- Duplicate: after DOC-001 succeeds, `Process DOC-004 if it is not already represented in the portal.`
- Approval: `Process DOC-005 only if approved.`

Observe saved portal state and `artifacts/<run-id>/trace.json`; do not score only the model's final prose.
