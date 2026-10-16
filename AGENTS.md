# Agent notes

Keep the synthetic portal and model operator distinct. Never bypass `Store.submit` for a browser action or relax its exact-value, approval, arithmetic, revision, or duplicate checks to make a model trace pass. Keep `fixtures/starter.json` synthetic and resettable. Tests may use a scripted Anthropic client, but documentation must identify those results as offline. Do not claim live Claude or Firedrill execution without recorded evidence. No secrets or generated workspace/artifacts belong in Git.


Validate complete native message/tool intent before every browser action; truncated/refused/missing/mismatched stop metadata must never dispatch a submit. Preserve canonical original entry identity and require actual persisted entry for confirmation. This parsed gate does not qualify original HTTP/all-step usage or full owner lifecycle. Keep remaining native/browser/state/history/dataset/distribution work in PLAN.md and prove it before stronger claims.
