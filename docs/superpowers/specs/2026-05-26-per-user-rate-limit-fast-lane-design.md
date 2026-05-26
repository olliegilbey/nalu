# Per-User Rate-Limit Fast Lane

**Date:** 2026-05-26
**Status:** Approved — ready for implementation plan

## Problem

The current Cerebras rate limiter (`src/lib/llm/cerebrasRateLimit.ts`) paces every LLM call at a 13s floor, sized for the free-tier 5 RPM cap. With Nalu now on paid Cerebras (1000 RPM, no daily cap), that floor makes a demo flow painful:

- Framework generation (2 calls) takes ~26s.
- Any `executeTurn` retry adds 13s per attempt.
- Scoping + 2 Waves (~26 calls) takes ~6 minutes of pure pacing.

A hiring manager evaluating Nalu as a portfolio piece needs the fast path. Budget exposure is small (~$0.10 per demo session), so the slowdown is a runaway-use deterrent, not wallet protection.

## Goal

Each user gets the first **30 LLM calls** at near-zero pacing (~200ms). After 30 calls, the limiter reverts to the existing 13s floor. No UI signal — the slowdown is invisible.

30 calls covers scoping (~4) + 2 Waves (~22) + ~4 retries, which lets a viewer complete the full onboarding and get well into the second Wave before pacing kicks in.

## Non-goals

- **Global daily wallet ceiling.** Skipped — per-user slowdown plus ~$0.10/session keeps exposure bounded.
- **UI indication of slow-lane state.** Skipped per product call — most viewers will have finished engaging by then.
- **Persistent counters across cold starts.** In-memory counters are sufficient for a demo. A cold start grants a user another fast-lane window; wallet exposure is unaffected.

## Design

### Knob changes — `src/lib/config/tuning.ts`

Three new fields on `LLM`:

```typescript
export const LLM = {
  defaultTemperature: 0.3,
  maxRetries: 6,
  fastLaneSpacingMs: 200, // paid tier 1000 RPM = 60ms floor; 200ms is conservative
  slowLaneSpacingMs: 13_000, // existing free-tier-safe floor, kept for after-cap behavior
  fastLaneCallsPerUser: 30, // scoping (~4) + 2 Waves (~22) + retry headroom (~4)
  lowTokenBudgetThreshold: 10_000,
} as const;
```

Rename existing `minRequestSpacingMs` → `slowLaneSpacingMs`. Behaviorally identical for users past the cap.

### UserId propagation — `src/server/trpc.ts`

Add a module-level `AsyncLocalStorage<string>` and wrap `protectedProcedure` so every LLM call originating from a tRPC request can read the caller's userId without threading it through `generateChat`'s signature:

```typescript
import { AsyncLocalStorage } from "node:async_hooks";

export const userIdStore = new AsyncLocalStorage<string>();

// inside protectedProcedure middleware:
return userIdStore.run(ctx.userId, () => next({ ctx: { ...ctx, userId: ctx.userId } }));
```

AsyncLocalStorage propagates through `await`, `setTimeout`, `Promise` chains, and `fetch` in Node 18+, so the AI SDK's transport code preserves the binding.

### Rate-limiter changes — `src/lib/llm/cerebrasRateLimit.ts`

Add a per-user call-count map alongside the existing module state:

```typescript
const callCountByUser = new Map<string, number>();
```

In `awaitCerebrasCallSlot`:

1. Read `userId` from `userIdStore.getStore()` (may be `undefined` for smoke / CLI / background jobs).
2. Look up the count: `const count = userId ? (callCountByUser.get(userId) ?? 0) : 0`.
3. Choose spacing: `count < LLM.fastLaneCallsPerUser ? fastLaneSpacingMs : slowLaneSpacingMs`.
4. Apply the existing token-budget gate (unchanged — protects shared-with-STT contention).
5. Apply the chosen spacing.
6. Increment the counter (only when `userId` is defined).

Smoke runs and CLI tools (no userId in context) get the fast path — appropriate for paid-tier smoke.

Extend `__resetCerebrasRateLimitStateForTests` to clear `callCountByUser`.

### Tests — `src/lib/llm/cerebrasRateLimit.test.ts`

Add cases:

1. With `userIdStore.run("user-a", ...)`, calls 1…30 use `fastLaneSpacingMs`.
2. Call 31 for the same user uses `slowLaneSpacingMs`.
3. Two different userIds counted independently — `user-b`'s call 1 still gets fast spacing after `user-a` exhausts its window.
4. No userId in store (background context) uses fast spacing and does not mutate the map.
5. `__resetCerebrasRateLimitStateForTests` clears both dispatch state and the per-user map.

## Trade-offs

**In-memory Map vs DB-backed counter.** Map is the chosen path:

| Aspect              | In-memory `Map`                            | DB column                      |
| ------------------- | ------------------------------------------ | ------------------------------ |
| Schema change       | None                                       | Migration on `user_profiles`   |
| Per-call cost       | O(1) Map lookup                            | +1 read + 1 write per LLM call |
| Cold-start behavior | Resets — user gets another fast window     | Durable                        |
| Failure mode        | Generous to user (more fast calls than 30) | Strict                         |
| Wallet impact       | Bounded by ~$0.10/session regardless       | Same                           |

In-memory aligns with the existing module-level state in `cerebrasRateLimit.ts`. The "generous on cold start" failure mode is acceptable for a demo and could mildly benefit a viewer who returns later.

**Why not thread `userId` through `generateChat`?** Every caller in `src/lib/course/`, `src/lib/turn/executeTurn.ts`, and tests would need the new param. AsyncLocalStorage is the standard Node pattern for ambient request-scoped data and keeps the LLM seam clean.

## Risks

- **AsyncLocalStorage propagation through the AI SDK.** Node guarantees propagation across `await` / Promises / timers / `fetch`. Verify with a test that calls `generateChat` from inside `userIdStore.run` and asserts the counter incremented.
- **Test isolation.** The existing `__resetCerebrasRateLimitStateForTests` must clear the new map. Covered by test #5 above.
- **Smoke run behavior.** No userId → fast path. Intentional. Smoke remains paced by the existing token-budget header gate if Cerebras returns headroom signals.
- **Concurrency within one userId.** If a user fires parallel calls (unlikely in current flows), the counter increments without a lock. Acceptable — overshoot is bounded by the number of in-flight calls (~1–2), not arbitrarily.

## Out of scope (future work)

- Persistent per-user counter (DB column).
- Global daily $ ceiling as a hard wallet stop.
- UI indication of slow-lane state.
- Cross-process / multi-region counter coherence on Vercel.

## File touch list

- `src/lib/config/tuning.ts` — rename + add 3 fields.
- `src/server/trpc.ts` — add `userIdStore`, wrap `protectedProcedure`.
- `src/lib/llm/cerebrasRateLimit.ts` — read userId from store, branch on count, increment.
- `src/lib/llm/cerebrasRateLimit.test.ts` — 5 new cases.
- (No DB migration. No router or component changes.)
