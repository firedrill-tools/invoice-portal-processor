# Agent notes

Keep the synthetic portal and model operator distinct. Never bypass `Store.submit` for a browser action or relax its exact-value, approval, arithmetic, revision, or duplicate checks to make a model trace pass. Keep `fixtures/starter.json` synthetic and resettable. Tests may use a scripted Anthropic client, but documentation must identify those results as offline. Do not claim live Claude or Firedrill execution without recorded evidence. No secrets or generated workspace/artifacts belong in Git.
