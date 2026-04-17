# TODOs

- **Zod bound-violation retry for scoping `generateStructured` calls.** When scoping `generateStructured` calls (e.g. framework generation, where `<max_topics>` / `<min_units>` are enforced post-parse) fail schema validation, do one automated retry feeding the validation error back to the model as corrective context. Currently the transport-level `LLM.maxRetries` covers network/transport only; schema-drift retries are a separate concern. Scoped to scoping for now; generalise to all `generateStructured` callers if/when teaching-session schemas hit the same failure mode.
