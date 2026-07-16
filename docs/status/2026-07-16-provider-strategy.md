# Provider strategy: `@ai-sdk/cerebras` vs `openai-compatible`, AI Gateway vs direct

Decision-input note (Phase 5 Task 6, plan `2026-06-10-llm-hygiene-observability.md`). No code changes. Sources fetched 2026-07-16; written against the **paid Cerebras Developer tier** reality (constraints are token cost + latency, not 5 RPM).

## 1. `@ai-sdk/cerebras` vs current `@ai-sdk/openai-compatible`

**What we run today** (`src/lib/llm/provider.ts`): `createOpenAICompatible` pointed at Cerebras' Chat Completions endpoint, `supportsStructuredOutputs: true`, plus the hand-rolled `toCerebrasJsonSchema` pipeline (keyword stripping, `oneOf`→`anyOf`, 5000-char/depth-10 budget asserts, tool-input null-strip).

**What the dedicated provider adds** (per https://ai-sdk.dev/providers/ai-sdk-providers/cerebras):

- `strictJsonSchema` option — requests constrained decoding ("guarantee schema compliance") on the wire.
- `reasoningEffort` provider option (`low`/`medium`/`high`) for reasoning models incl. `gpt-oss-120b`.
- Catalogued model ids, correct default base URL/headers out of the box.
- It is a **thin wrapper over `@ai-sdk/openai-compatible`** — that package is literally in its dependency tree. Same transport, same wire protocol.

**What it does NOT replace**: none of `toCerebrasJsonSchema`. The provider does no keyword cleaning, no budget enforcement, no tool-input null-strip — all of which exist because of Cerebras' documented strict-mode budget and live-probed model behaviour (null unions crater `gpt-oss-120b` tool reliability ~95%→~44%, `docs/status/2026-07-06-tool-call-probe-verdict.md`). The schema layer survives a provider swap unchanged.

**Version blocker**: `@ai-sdk/cerebras@3.x` (latest 3.0.11) depends on `@ai-sdk/provider@4` — provider spec **V4**, while this stack (`ai@6.0.158`, `@ai-sdk/openai-compatible@2.0.41`) is spec **V3**. The same V4-vs-V3 clash we documented for `@ai-sdk/devtools`. The only compatible release today is the legacy `@ai-sdk/cerebras@2.0.67` line — adopting a frozen back-line to gain a thin wrapper is a bad trade.

**Verdict: stay on `openai-compatible`.** Revisit at the next `ai` major bump (which also retires the devtools middleware cast): at that point `@ai-sdk/cerebras@3.x` becomes a one-line swap in `provider.ts`, and the concrete win to validate is whether `strictJsonSchema` delivers real constrained decoding on the paid tier — memory `cerebras-strict-mode-not-enforced` records that `response_format` was soft guidance on free-tier models; if paid-tier constrained decoding is real, validation-retry burn (cost + latency) drops and `executeTurn`'s retry loop becomes a rarely-hit backstop. That's a cheap live probe at upgrade time, not a reason to switch now.

## 2. Vercel AI Gateway vs direct Cerebras + `cerebrasRateLimit.ts`

**What Gateway offers** (https://vercel.com/docs/ai-gateway, https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway, /docs/ai-gateway/pricing):

- **One key, provider routing**: model strings like `cerebras/gpt-oss-120b`; Cerebras is in the catalog. `providerOptions.gateway.order` = provider preference with automatic failover; `models` = model-level fallback. Notably `gpt-oss-120b` is an open model served by several gateway providers (Groq, Fireworks, …), so *same-model cross-provider failover* is a real availability story.
- **Zero token markup**, paid tier, including BYOK. Billing via prepaid AI Gateway Credits (auto top-up available).
- **BYOK**: our existing Cerebras key can ride along per-request (`providerOptions.gateway.byok`); on BYOK failure Gateway retries with system credentials, billed to credits.
- **Spend observability**: per-generation cost via `gateway.getGenerationInfo()`, spend reports, per-user/tag attribution (Custom Reporting is a paid add-on: $0.075/1k writes, $5/1k queries).
- **Latency**: an extra hop; no published numbers. Our new stage-labelled OTel spans (Phase 5 Task 3) are exactly the instrument to measure it in a trial once an OTLP endpoint is wired.

**What it would replace in `cerebrasRateLimit.ts` — and what it wouldn't**:

| Limiter responsibility | Gateway impact |
| --- | --- |
| Absorbing account-wide contention from the **STT-shared key** (reads `x-ratelimit-*` headers) | **Replaced** — Gateway credits are a separate budget; the shared-key coupling disappears entirely. (A second Cerebras key would NOT achieve this: keys are tier-bound and the rate headers are account-wide.) |
| 429-avoidance request spacing (free-tier 5 RPM era) | **Already moot** on the paid tier; Gateway failover further reduces 429 exposure. |
| **Per-user fast/slow lane** (`userIdStore` + `LLM.fastLaneCallsPerUser`) — a per-user cost/burst governor | **Not replaced.** Gateway has no per-user throttling; its `user` field is reporting-only. The lane logic is app-level and survives a gateway hop unchanged (it paces *before* dispatch; it doesn't care what's on the other end). |
| Per-day token cap awareness (never implemented — no TPD header) | **Improved**: spend reports + credits balance give the cumulative view the limiter could never see. |

**Costs of switching**: prepaid credits to manage; BYOK silent-fallback-to-system-credentials means occasional spend outside the Cerebras account even in BYOK mode; one more infra dependency; unmeasured added latency on a product where the user already notices slowness.

## 3. Recommendation + triggers

**Now: stay direct (`openai-compatible` + `cerebrasRateLimit.ts`).** One provider, paid tier, working pipeline; both candidate switches add a dependency without removing any code we rely on (schema cleaning and fast-lane both survive either move).

Switch **provider package** (`@ai-sdk/cerebras@3.x`) when:

- the `ai` major bump lands (provider spec V4) — do it as part of that upgrade, then probe `strictJsonSchema` constrained decoding on the paid tier.
- OR we need `reasoningEffort` control sooner (it can also be hand-set via `providerOptions` on the current adapter — check before switching for this alone).

Switch to **AI Gateway** when any of:

- a **second provider / failover** is needed — e.g. the next Cerebras model deprecation cliff (May 2026 took `llama3.1-8b` + `qwen-3-235b`; `gpt-oss-120b` is the current floor) or availability incidents;
- **spend isolation from the STT workload** becomes a priority (the only clean decoupling available — second keys don't isolate);
- we want **per-generation cost attribution** without building cumulative `usage` accounting ourselves.

Before adopting Gateway: wire an OTLP endpoint, set `LLM_TELEMETRY=true`, and A/B the added hop latency with the stage-labelled spans from this branch.

## Sources

- https://ai-sdk.dev/providers/ai-sdk-providers/cerebras (fetched 2026-07-16)
- https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway (fetched 2026-07-16; old `/gateway` URL is 404)
- https://vercel.com/docs/ai-gateway + /pricing (last_updated 2026-06-29 / 2026-06-20)
- npm dependency metadata: `@ai-sdk/cerebras@3.0.11` → `@ai-sdk/provider@4.0.3`; `@ai-sdk/cerebras@2.0.67` → `@ai-sdk/provider@3.0.14`
- Local: `src/lib/llm/{provider,toCerebrasJsonSchema,cerebrasRateLimit}.ts`, memories `cerebras-strict-mode-not-enforced`, `cerebras-free-tier-limits` (paid tier 2026-07-16), `llama-8b-deprecation`
