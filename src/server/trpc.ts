import { initTRPC, TRPCError } from "@trpc/server";
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { NotFoundError } from "@/db/queries/errors";

/**
 * Build the tRPC request context. Dev-stub auth: reads `x-dev-user-id`
 * from the incoming headers and exposes it as `userId` (possibly undefined).
 * Real Supabase Auth lands in a follow-up spec; the seam stays in this
 * function so the swap is local.
 */
export const createTRPCContext = async (opts: FetchCreateContextFnOptions) => {
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
 * Authenticated procedure. Requires `x-dev-user-id` to be set on the
 * request. Once real auth lands, the body of this middleware swaps to
 * Supabase session resolution; call sites stay unchanged.
 */
export const protectedProcedure = t.procedure.use(mapNotFound).use(({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "missing x-dev-user-id header" });
  }
  return next({ ctx: { ...ctx, userId: ctx.userId } });
});
