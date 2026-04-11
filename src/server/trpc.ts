import { initTRPC } from "@trpc/server";

/**
 * Creates the tRPC context for each request.
 * Will add Supabase auth + DB connection here later.
 */
export const createTRPCContext = async () => {
  return {};
};

const t = initTRPC.context<typeof createTRPCContext>().create();

/** Define a tRPC router */
export const router = t.router;

/** Public procedure — no auth required */
export const publicProcedure = t.procedure;
