import { initTRPC, TRPCError } from "@trpc/server";
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { NotFoundError } from "@/db/queries/errors";
import { createClient } from "@/lib/supabase/server";
import { ensureUserProfile } from "@/db/queries";
import { userIdStore } from "@/lib/llm/userIdStore";

/**
 * Build the tRPC request context. Resolves `userId` (possibly undefined).
 *
 * Production: identity comes from the Supabase session cookie that
 * `src/proxy.ts` mints for every visitor. Non-production keeps the
 * `x-dev-user-id` dev-stub seam so `just dev` and the test suite need
 * no Supabase Auth.
 */
export const createTRPCContext = async (opts: FetchCreateContextFnOptions) => {
  if (process.env.NODE_ENV === "production") {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    return { userId: data.user?.id };
  }
  // headers.get is the Web Fetch API surface — lowercase keys; tRPC-fetch
  // gives us a `Headers` object directly.
  const devUserId = opts.req.headers.get("x-dev-user-id") ?? undefined;
  return { userId: devUserId };
};

const t = initTRPC.context<typeof createTRPCContext>().create();

/** Define a tRPC router */
export const router = t.router;

/** Public procedure — no auth required */
export const publicProcedure = t.procedure;

/**
 * Map `NotFoundError` (thrown by `src/db/queries/`) to a tRPC `NOT_FOUND`
 * response. Without this middleware, plain `Error` becomes INTERNAL_SERVER_ERROR
 * on the wire — clients can't tell a missing row from a server crash. Applied
 * as a middleware (not a global error formatter) so query-layer code stays
 * tRPC-agnostic and unit tests on `src/db/queries/` see the original error.
 */
const mapNotFound = t.middleware(async ({ next }) => {
  const result = await next();
  // tRPC v11 wraps thrown errors into a `{ ok: false, error }` return value
  // (see `callRecursive` in @trpc/server). Errors don't propagate as throws to
  // outer middleware — we have to inspect the result and re-throw with the
  // semantic code.
  if (!result.ok && result.error.cause instanceof NotFoundError) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: result.error.cause.message,
      cause: result.error.cause,
    });
  }
  return result;
});

/**
 * Authenticated procedure. In production `ctx.userId` is the Supabase
 * anonymous user's id; in dev it is the `x-dev-user-id` stub. Either way,
 * `ensureUserProfile` provisions the `user_profiles` row on demand — a
 * freshly signed-in anonymous user has an `auth.users` row but no profile
 * row, and `courses.user_id` references `user_profiles.id`.
 */
export const protectedProcedure = t.procedure.use(mapNotFound).use(async ({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "no authenticated user" });
  }
  await ensureUserProfile(ctx.userId);
  // Bind `userId` first so the override ctx is well-typed for downstream
  // procedures, then immediately run it inside the ALS scope. `next()`
  // returns a thenable — we kick it off inside `run()` so every async
  // continuation (including the AI SDK's `fetch` calls) sees the store.
  const userId = ctx.userId;
  // Make `userId` available to the Cerebras rate limiter (and anything
  // else in the LLM layer that wants request-scoped ambient context)
  // without threading it through `generateChat`'s signature. ALS
  // propagates through `await`, Promise chains, timers, and `fetch`, so
  // the AI SDK's transport code preserves the binding.
  return userIdStore.run(userId, () => next({ ctx: { ...ctx, userId } }));
});
