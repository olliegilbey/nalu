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
