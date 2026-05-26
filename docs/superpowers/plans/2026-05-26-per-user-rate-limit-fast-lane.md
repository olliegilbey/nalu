# Per-User Rate-Limit Fast Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each user 30 fast Cerebras calls (~200ms spacing) before falling back to the existing 13s floor, so a hiring-manager demo can complete scoping + 2 Waves without a multi-minute wait.

**Architecture:** Add `AsyncLocalStorage<string>` for `userId`, populated in tRPC's `protectedProcedure`. The Cerebras rate limiter reads `userId` from the store at call time, keeps a per-user in-memory `Map` of call counts, and branches spacing on `count < LLM.fastLaneCallsPerUser`. No DB schema change. No `generateChat` signature change.

**Tech Stack:** TypeScript strict, Vitest (fake timers), Node `AsyncLocalStorage`, tRPC v11. Spec: `docs/superpowers/specs/2026-05-26-per-user-rate-limit-fast-lane-design.md`.

**Branch:** `feat/per-user-rate-limit-fast-lane` (already created and checked out).

---

## Background reading before starting

Before Task 1, the executing engineer should read:

- `docs/superpowers/specs/2026-05-26-per-user-rate-limit-fast-lane-design.md` — the approved spec.
- `src/lib/llm/cerebrasRateLimit.ts` — the rate limiter being extended (module-level state, gating via `VITEST` + `CEREBRAS_LIVE=1`).
- `src/lib/llm/cerebrasRateLimit.test.ts` — existing test patterns (fake timers, `measure()` helper, `vi.stubEnv("CEREBRAS_LIVE", "1")` to arm the gate).
- `src/lib/config/tuning.ts` lines 195-239 — the `LLM` constants being modified.
- `src/server/trpc.ts` — `protectedProcedure` is the only call site that needs ALS instrumentation.
- `src/lib/llm/CLAUDE.md` and `src/lib/config/CLAUDE.md` — directory rules.

---

## File touch list

- **Create:** `src/lib/llm/userIdStore.ts` (~10 lines).
- **Modify:** `src/lib/config/tuning.ts` — rename `minRequestSpacingMs` → `slowLaneSpacingMs`, add `fastLaneSpacingMs` + `fastLaneCallsPerUser`.
- **Modify:** `src/lib/llm/cerebrasRateLimit.ts` — read `userId` from store, branch on count, increment counter; rename usage of `minRequestSpacingMs`.
- **Modify:** `src/lib/llm/cerebrasRateLimit.test.ts` — update existing references to renamed constant; add 5 new test cases for per-user behavior.
- **Modify:** `src/server/trpc.ts` — wrap `protectedProcedure`'s `next()` in `userIdStore.run(ctx.userId, ...)`.

No DB migration. No router or component changes. No changes to `generateChat`.

---

## Why this rename, why this layering

- `minRequestSpacingMs` → `slowLaneSpacingMs` makes the after-cap behavior explicit and pairs symmetrically with `fastLaneSpacingMs`. The semantic is unchanged for users past 30 calls.
- `userIdStore` lives in `src/lib/llm/` (not `src/server/`) because the LLM layer is the consumer; the server layer just populates it. `src/lib/` must not import from `src/server/`, so the store cannot live in `src/server/`.

---

## Task 1: Create the AsyncLocalStorage module

**Files:**

- Create: `src/lib/llm/userIdStore.ts`

- [ ] **Step 1: Write the file**

```typescript
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Ambient request-scoped userId for the LLM layer.
 *
 * WHY: the Cerebras rate limiter (`cerebrasRateLimit.ts`) needs to know
 * which user owns the current LLM call so it can apply per-user pacing
 * (a "fast lane" for the first N calls, then a slow lane). Threading
 * `userId` through `generateChat` and every caller would touch dozens of
 * files; Node's `AsyncLocalStorage` is the standard pattern for
 * request-scoped ambient data and propagates through `await`, Promise
 * chains, timers, and `fetch`.
 *
 * Populated by `protectedProcedure` in `src/server/trpc.ts`. Returns
 * `undefined` when the call originates outside a tRPC request (smoke
 * runs, scripts, background jobs), in which case the rate limiter falls
 * back to the fast lane — appropriate for paid-tier smoke.
 */
export const userIdStore = new AsyncLocalStorage<string>();
```

- [ ] **Step 2: Verify typecheck**

Run: `just typecheck`
Expected: passes (the file has no runtime behavior yet, just an export).

- [ ] **Step 3: Commit**

```bash
git add src/lib/llm/userIdStore.ts
git commit -m "feat(llm): add AsyncLocalStorage seam for per-call userId"
```

---

## Task 2: Rename and extend `LLM` tuning constants

**Files:**

- Modify: `src/lib/config/tuning.ts:194-239`

- [ ] **Step 1: Update the `LLM` block**

Replace the existing block-comment for the spacing knob and the `LLM` const. Find the lines starting at `* \`minRequestSpacingMs: 13000\``(around line 212) and ending at the closing`} as const;`of`LLM` (around line 239). Replace with:

```typescript
/**
 * `slowLaneSpacingMs: 13000`: minimum gap (dispatch-to-dispatch) between
 * consecutive Cerebras API calls AFTER a user has consumed their fast-lane
 * window, enforced at the `generateChat` call site by
 * `src/lib/llm/cerebrasRateLimit.ts`. The Cerebras FREE tier caps at
 * 5 requests/min — a 12.0s exact floor (60s ÷ 5). 13s adds ~1s margin so a
 * strict server-side sliding window can't trip on clock skew or
 * response-time variance. We're on the paid tier now, but the slow-lane
 * value is sized for the free-tier floor — it's the deterrent that kicks
 * in after `fastLaneCallsPerUser` calls, not a budget mechanism.
 *
 * `fastLaneSpacingMs: 200`: spacing applied while a user is still inside
 * their fast-lane window. Paid tier supports 1000 RPM (60ms floor); 200ms
 * is a conservative cushion that absorbs `executeTurn` retry bursts
 * without measurable user-visible latency (200ms × 6 worst-case retries
 * ≈ 1.2s, vs 78s at the slow-lane floor).
 *
 * `fastLaneCallsPerUser: 30`: per-user count of fast-lane calls before
 * the slow-lane floor kicks in. Sized to cover scoping (~4 calls) plus
 * 2 Waves (~22 calls) plus ~4 calls of retry headroom — a hiring-manager
 * demo can complete the full onboarding and reach the second Wave before
 * any slowdown. Counter is in-memory (module-level Map keyed by userId);
 * resets on lambda cold start, which is generous to the user and does
 * not affect wallet exposure (~$0.10/session regardless).
 *
 * `lowTokenBudgetThreshold: 10000`: if a prior response's
 * `x-ratelimit-remaining-tokens-minute` header drops below this, the limiter
 * waits for the per-minute token bucket to reset before the next call. The
 * Cerebras free tier allows 30,000 tokens/min; a single large teaching turn
 * (full Wave context + a verbose structured reply) can consume several
 * thousand tokens. 10000 leaves comfortable headroom for one such turn
 * without tripping a mid-turn 429. The same Cerebras API key is shared with
 * another workload, so the remaining-tokens header reports the
 * account-wide budget — this backoff absorbs that contention automatically.
 */
export const LLM = {
  defaultTemperature: 0.3,
  maxRetries: 6,
  slowLaneSpacingMs: 13_000,
  fastLaneSpacingMs: 200,
  fastLaneCallsPerUser: 30,
  lowTokenBudgetThreshold: 10_000,
} as const;
```

- [ ] **Step 2: Verify typecheck fails (callers reference old name)**

Run: `just typecheck`
Expected: errors in `src/lib/llm/cerebrasRateLimit.ts` and `src/lib/llm/cerebrasRateLimit.test.ts` about `Property 'minRequestSpacingMs' does not exist on type ...`. This is correct — Task 3 fixes them.

- [ ] **Step 3: No commit yet**

Hold the commit until Task 3 (the rename has to land together with its consumers to keep `main` typecheck-green).

---

## Task 3: Update existing references to the renamed constant

**Files:**

- Modify: `src/lib/llm/cerebrasRateLimit.ts:107, 135` (TSDoc + the one usage)
- Modify: `src/lib/llm/cerebrasRateLimit.test.ts:90, 97, 114, 139, 157, 158, 173, 191, 201`

Note on semantics: the existing tests run _without_ a userIdStore context, which the new behavior routes to the **fast lane**. So after Task 5 these tests will assert on `LLM.fastLaneSpacingMs`, not the renamed slow-lane value. We do the simpler rename first here (still `slowLaneSpacingMs`) so this task stays mechanical; Task 5 will flip these to `fastLaneSpacingMs` as part of the TDD cycle, after we've added the per-user logic.

- [ ] **Step 1: In `cerebrasRateLimit.ts`, update the one usage and TSDoc**

Find on line 107:

```
 *   2. Request spacing — wait so this dispatch is ≥ `LLM.minRequestSpacingMs`
```

Replace with:

```
 *   2. Request spacing — wait so this dispatch is ≥ `LLM.slowLaneSpacingMs`
```

Find on line 135:

```typescript
const spacingWaitMs = LLM.minRequestSpacingMs - (Date.now() - lastDispatchAtMs);
```

Replace with:

```typescript
const spacingWaitMs = LLM.slowLaneSpacingMs - (Date.now() - lastDispatchAtMs);
```

- [ ] **Step 2: In `cerebrasRateLimit.test.ts`, replace all `LLM.minRequestSpacingMs` with `LLM.slowLaneSpacingMs`**

Use `replace_all` on the Edit tool, `old_string: "LLM.minRequestSpacingMs"`, `new_string: "LLM.slowLaneSpacingMs"`. Expected count: 9 replacements (lines 90, 97, 114, 139, 157, 158, 173, 191, 201).

- [ ] **Step 3: Verify typecheck passes**

Run: `just typecheck`
Expected: clean.

- [ ] **Step 4: Verify existing tests still pass**

Run: `bun run vitest run src/lib/llm/cerebrasRateLimit.test.ts`
Expected: all 11 existing cases pass (no behavior change yet).

- [ ] **Step 5: Commit the rename + Task 2 together**

```bash
git add src/lib/config/tuning.ts src/lib/llm/cerebrasRateLimit.ts src/lib/llm/cerebrasRateLimit.test.ts
git commit -m "refactor(llm): rename minRequestSpacingMs to slowLaneSpacingMs

Adds fastLaneSpacingMs and fastLaneCallsPerUser constants for the
upcoming per-user rate-limiter fast lane. Behavior unchanged."
```

---

## Task 4: TDD per-user fast/slow lane in the rate limiter

This task adds the per-user counter and branching. We write the failing tests first, then implement.

**Files:**

- Modify: `src/lib/llm/cerebrasRateLimit.test.ts` — add a `describe` block for per-user behavior; update existing spacing assertions to `fastLaneSpacingMs` (since they run without a userId).
- Modify: `src/lib/llm/cerebrasRateLimit.ts` — add per-user counter Map, read userId from store, branch on count.

### Step 1: Flip existing spacing assertions to `fastLaneSpacingMs`

The existing "request spacing" tests in `cerebrasRateLimit.test.ts` run with no `userIdStore.run(...)` wrapping, which under the new behavior is the fast-lane path. Their assertions must move from `slowLaneSpacingMs` (13s) to `fastLaneSpacingMs` (200ms).

- [ ] In `cerebrasRateLimit.test.ts`, replace `LLM.slowLaneSpacingMs` with `LLM.fastLaneSpacingMs` ONLY inside the existing `describe("request spacing — active under CEREBRAS_LIVE=1", ...)` and `describe("token-budget backoff — active under CEREBRAS_LIVE=1", ...)` blocks (lines 74-203). That's all 9 current usages.

After this edit, all 9 references in those blocks point at `fastLaneSpacingMs`.

### Step 2: Add new failing tests for per-user behavior

- [ ] Add the following imports at the top of `cerebrasRateLimit.test.ts`:

```typescript
import { userIdStore } from "./userIdStore";
```

- [ ] Add this `describe` block at the bottom of the outer `describe("cerebrasRateLimit", ...)` (just before its closing `});`):

```typescript
describe("per-user fast/slow lane — active under CEREBRAS_LIVE=1", () => {
  beforeEach(() => {
    vi.stubEnv("CEREBRAS_LIVE", "1");
  });

  /**
   * Wrap a call in the userIdStore so the limiter sees the userId.
   * Returns how many ms of fake time elapsed before resolution.
   */
  async function measureForUser(userId: string): Promise<number> {
    return userIdStore.run(userId, async () => measure(awaitCerebrasCallSlot()));
  }

  it("applies fast-lane spacing for a user's first call", async () => {
    // First call for any user: count is 0, fast-lane path; spacing is
    // 0 because there's no prior dispatch.
    const delay = await measureForUser("user-a");
    expect(delay).toBe(0);
  });

  it("applies fast-lane spacing through the threshold-th call", async () => {
    // Run fastLaneCallsPerUser calls back-to-back. The first call has no
    // prior dispatch (delay 0). Every subsequent call must wait
    // fastLaneSpacingMs — never the slow-lane floor.
    const first = await measureForUser("user-a");
    expect(first).toBe(0);

    // Iterate (threshold - 1) more times. Codebase uses for...of only
    // (eslint-plugin-functional `no-let`); `Array.from({ length })` is
    // the idiomatic way to spin a fixed count without an index var.
    for (const _ of Array.from({ length: LLM.fastLaneCallsPerUser - 1 })) {
      const delay = await measureForUser("user-a");
      expect(delay).toBe(LLM.fastLaneSpacingMs);
    }
  });

  it("flips to slow-lane spacing on the call after the threshold", async () => {
    // Exhaust the fast-lane window for user-a.
    for (const _ of Array.from({ length: LLM.fastLaneCallsPerUser })) {
      await measureForUser("user-a");
    }

    // The (threshold + 1)-th call must wait the slow-lane floor.
    const delay = await measureForUser("user-a");
    expect(delay).toBe(LLM.slowLaneSpacingMs);
  });

  it("counts users independently", async () => {
    // user-a burns through their entire fast-lane window.
    for (const _ of Array.from({ length: LLM.fastLaneCallsPerUser })) {
      await measureForUser("user-a");
    }

    // user-b's first call must still be on the fast lane — note that
    // spacing is the FAST value, not zero, because user-a's last call
    // set the global dispatch clock. The spacing gate is global; the
    // lane choice is per-user.
    const delay = await measureForUser("user-b");
    expect(delay).toBe(LLM.fastLaneSpacingMs);
  });

  it("uses fast lane and does not mutate the counter when no userId is in scope", async () => {
    // No userIdStore.run wrapper — simulates smoke / CLI / background.
    // First call: no prior dispatch, delay 0.
    const first = await measure(awaitCerebrasCallSlot());
    expect(first).toBe(0);

    // Second call without userId: must use fast-lane spacing, not slow.
    const second = await measure(awaitCerebrasCallSlot());
    expect(second).toBe(LLM.fastLaneSpacingMs);

    // Even after threshold-many no-userId calls, the next call with a
    // userId still gets the fast lane (no-userId calls do not consume
    // any user's budget).
    for (const _ of Array.from({ length: LLM.fastLaneCallsPerUser + 5 })) {
      await measure(awaitCerebrasCallSlot());
    }
    const userCall = await measureForUser("user-c");
    expect(userCall).toBe(LLM.fastLaneSpacingMs);
  });

  it("__resetCerebrasRateLimitStateForTests clears per-user counts", async () => {
    // Burn user-a's fast lane.
    for (const _ of Array.from({ length: LLM.fastLaneCallsPerUser })) {
      await measureForUser("user-a");
    }

    // Reset, then user-a's next call must be back on the fast lane.
    __resetCerebrasRateLimitStateForTests();
    // After reset, no prior dispatch → first call delay is 0.
    const delay = await measureForUser("user-a");
    expect(delay).toBe(0);
  });
});
```

- [ ] **Verify the new tests fail**

Run: `bun run vitest run src/lib/llm/cerebrasRateLimit.test.ts`
Expected: the 6 new cases fail (and likely the flipped existing cases too, since `awaitCerebrasCallSlot` still applies `slowLaneSpacingMs` unconditionally). This is the red step.

### Step 3: Implement per-user logic in `cerebrasRateLimit.ts`

- [ ] Add the import at the top of `cerebrasRateLimit.ts` (just after the existing `import { LLM } from ...` line):

```typescript
import { userIdStore } from "./userIdStore";
```

- [ ] Below the existing `let remainingTokensThisMinute: number | null = null;` declaration (around line 89), add a new module-level Map:

```typescript
/**
 * Per-user call counter, keyed by userId. Each entry counts how many LLM
 * calls this user has made in the current process lifetime. When the count
 * reaches `LLM.fastLaneCallsPerUser`, the next call (and all subsequent
 * ones) use `LLM.slowLaneSpacingMs` instead of `LLM.fastLaneSpacingMs`.
 *
 * In-memory only — no DB, no shared store. Cold starts reset the map, which
 * is generous to the user (they get another fast-lane window) and does not
 * affect wallet exposure (~$0.10/session regardless). See the spec at
 * `docs/superpowers/specs/2026-05-26-per-user-rate-limit-fast-lane-design.md`
 * for the rationale.
 *
 * No userId in scope (smoke runs, CLI, background) → the limiter uses the
 * fast lane and does not mutate this map. The Map's `get` returns undefined
 * for unknown keys, which we coerce to 0.
 */
const callCountByUser = new Map<string, number>();
```

- [ ] Replace the existing `awaitCerebrasCallSlot` function body to branch on per-user count. The new body:

```typescript
export async function awaitCerebrasCallSlot(): Promise<void> {
  // Gate: outside production / live smoke this does nothing at all.
  if (!isRateLimiterActive()) return;

  // Resolve the per-user lane. No userId in scope → fast lane, no counter
  // mutation. The lane choice is per-user; the spacing gate itself is
  // global (a single dispatch clock for the process).
  const userId = userIdStore.getStore();
  const count = userId !== undefined ? (callCountByUser.get(userId) ?? 0) : 0;
  const spacingMs =
    count < LLM.fastLaneCallsPerUser ? LLM.fastLaneSpacingMs : LLM.slowLaneSpacingMs;

  // Gate 1 — token-budget backoff. Only when we've seen headers AND the
  // last-reported remaining budget is too low to safely cover one more
  // large turn. We wait out the bucket-reset window stored at record-time.
  if (
    remainingTokensThisMinute !== null &&
    remainingTokensThisMinute < LLM.lowTokenBudgetThreshold &&
    tokenBucketResetAtMs !== null
  ) {
    const tokenWaitMs = tokenBucketResetAtMs - Date.now();
    if (tokenWaitMs > 0) {
      await sleep(tokenWaitMs);
    }
  }

  // Gate 2 — request spacing. Wait the remainder of the chosen spacing
  // window since the previous dispatch. Negative/zero when enough time
  // has passed (or when this is the first call in the process).
  const spacingWaitMs = spacingMs - (Date.now() - lastDispatchAtMs);
  if (spacingWaitMs > 0) {
    await sleep(spacingWaitMs);
  }

  // Record this call's dispatch time AFTER any waits, so it reflects the
  // moment the call is actually cleared to fire (call-start to call-start).
  lastDispatchAtMs = Date.now();

  // Increment the per-user counter ONLY when a userId is in scope. Calls
  // outside a tRPC request (smoke / CLI / background) don't consume any
  // user's fast-lane budget.
  if (userId !== undefined) {
    callCountByUser.set(userId, count + 1);
  }
}
```

- [ ] Update the `__resetCerebrasRateLimitStateForTests` function to also clear the new map:

```typescript
export function __resetCerebrasRateLimitStateForTests(): void {
  lastDispatchAtMs = 0;
  tokenBucketResetAtMs = null;
  remainingTokensThisMinute = null;
  callCountByUser.clear();
}
```

- [ ] Update the module TSDoc at the top of `cerebrasRateLimit.ts` (around lines 3-44) to mention the per-user dimension. Find the paragraph starting `Two responsibilities, both consumed by \`generateChat\`:`and update the section just before it. Specifically, after the line ending`Nalu waits when the shared bucket runs low.`, insert a new paragraph:

```
 *
 * Per-user fast/slow lane: each call reads the active userId from
 * `userIdStore` (Node AsyncLocalStorage, populated by `protectedProcedure`
 * in `src/server/trpc.ts`). The first `LLM.fastLaneCallsPerUser` calls per
 * userId use `LLM.fastLaneSpacingMs` (200ms); calls beyond that fall back
 * to `LLM.slowLaneSpacingMs` (13s). Calls with no userId in scope (smoke,
 * CLI, background) use the fast lane and do not consume any user's budget.
 * The counter is in-memory only (`callCountByUser`); cold starts reset it.
```

- [ ] **Verify all tests pass**

Run: `bun run vitest run src/lib/llm/cerebrasRateLimit.test.ts`
Expected: all 17 cases pass (11 existing + 6 new).

- [ ] **Commit**

```bash
git add src/lib/llm/cerebrasRateLimit.ts src/lib/llm/cerebrasRateLimit.test.ts
git commit -m "feat(llm): per-user fast/slow lane in Cerebras rate limiter

First fastLaneCallsPerUser calls per userId use fastLaneSpacingMs;
subsequent calls fall back to slowLaneSpacingMs. UserId is read from
the userIdStore AsyncLocalStorage at call time. Calls with no userId
in scope (smoke, CLI, background) use the fast lane and do not
consume any user's budget."
```

---

## Task 5: Populate `userIdStore` from `protectedProcedure`

**Files:**

- Modify: `src/server/trpc.ts:65-71`

- [ ] **Step 1: Add the import**

At the top of `src/server/trpc.ts`, add (after the existing `ensureUserProfile` import):

```typescript
import { userIdStore } from "@/lib/llm/userIdStore";
```

- [ ] **Step 2: Wrap `next()` in `userIdStore.run`**

Replace the existing `protectedProcedure` block (lines 65-71):

```typescript
export const protectedProcedure = t.procedure.use(mapNotFound).use(async ({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "no authenticated user" });
  }
  await ensureUserProfile(ctx.userId);
  return next({ ctx: { ...ctx, userId: ctx.userId } });
});
```

With:

```typescript
export const protectedProcedure = t.procedure.use(mapNotFound).use(async ({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "no authenticated user" });
  }
  await ensureUserProfile(ctx.userId);
  // Make `userId` available to the Cerebras rate limiter (and anything
  // else in the LLM layer that wants request-scoped ambient context)
  // without threading it through `generateChat`'s signature. ALS
  // propagates through `await`, Promise chains, timers, and `fetch`, so
  // the AI SDK's transport code preserves the binding.
  return userIdStore.run(ctx.userId, () => next({ ctx: { ...ctx, userId: ctx.userId } }));
});
```

- [ ] **Step 3: Verify typecheck and tests**

Run: `just typecheck && bun run vitest run src/server/`
Expected: clean. Integration tests in `src/server/routers/course.integration.test.ts` use the tRPC caller — they should be unaffected because the rate limiter is inert under Vitest (no `CEREBRAS_LIVE=1`).

- [ ] **Step 4: Commit**

```bash
git add src/server/trpc.ts
git commit -m "feat(server): populate userIdStore in protectedProcedure

ALS binding propagates ctx.userId to the LLM layer (specifically the
Cerebras rate limiter) without threading it through generateChat."
```

---

## Task 6: Full validation

- [ ] **Step 1: Run the full check suite**

Run: `just check`
Expected: lint, typecheck, and all vitest suites pass.

- [ ] **Step 2: Sanity-check the running app (optional but recommended)**

If the dev environment is available, start the app and walk a scoping flow to confirm the framework-generation step is visibly faster (was ~26s for the two calls; should now be ~400ms plus model latency).

Run: `just dev` (in a separate terminal)
Then in the browser, start a new course and observe scoping speed. No code change here — purely a smoke check.

- [ ] **Step 3: Push the branch**

```bash
git push -u origin feat/per-user-rate-limit-fast-lane
```

Do not open the PR automatically — the user will review and decide when to open it.

---

## Spec coverage check

Every spec requirement is covered:

- **Knob changes (`tuning.ts`)** — Task 2.
- **UserId propagation via ALS (`trpc.ts`)** — Tasks 1 + 5.
- **Rate-limiter changes (`cerebrasRateLimit.ts`)** — Task 4.
- **5 new tests** — Task 4 step 2 covers all 5 cases from the spec plus a 6th (reset clears the map), which is implicit in the spec's "test isolation" risk note.
- **Risks documented** — AsyncLocalStorage propagation (verified by per-user tests running through fake-timer `await`s), test isolation (Task 4 step 3 + the 6th new test), smoke behavior (5th new test).
- **Out of scope** — no DB migration, no global ceiling, no UI signal, no cross-process coherence. None of those are in this plan.

---

## Notes for the executor

- **No `--no-verify`.** Pre-commit hooks must pass. Fix the root cause if a hook fails.
- **Match existing comment density.** This file's CLAUDE.md and AGENTS.md ask for "more code comments than normal" — the code blocks above already include the WHY commentary expected.
- **Commit cadence:** one commit per task (Task 2 + Task 3 are combined per the rename-with-consumers rule).
- **Branch is already created and checked out** (`feat/per-user-rate-limit-fast-lane`).
