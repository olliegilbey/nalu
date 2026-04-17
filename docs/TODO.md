# TODOs

- **Zod bound-violation retry for scoping LLM calls.** When `generateStructured` fails schema validation (e.g. framework-scope invariants), do one automated retry feeding the validation error back to the model as corrective context. Currently the transport-level `LLM.maxRetries` covers network/transport only; schema-drift retries are a separate concern.
