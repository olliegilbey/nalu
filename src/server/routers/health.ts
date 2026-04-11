import { router, publicProcedure } from "../trpc";

/** Health check router — verifies the tRPC stack is working end-to-end */
export const healthRouter = router({
  ping: publicProcedure.query(() => ({
    status: "ok" as const,
    timestamp: new Date().toISOString(),
  })),
});
