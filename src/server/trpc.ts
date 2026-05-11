import { initTRPC, TRPCError } from "@trpc/server";
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";

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
 * Authenticated procedure. Requires `x-dev-user-id` to be set on the
 * request. Once real auth lands, the body of this middleware swaps to
 * Supabase session resolution; call sites stay unchanged.
 */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "missing x-dev-user-id header" });
  }
  return next({ ctx: { ...ctx, userId: ctx.userId } });
});
