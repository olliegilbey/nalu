import { router } from "../trpc";
import { healthRouter } from "./health";

/** Root router — all feature routers compose here */
export const appRouter = router({
  health: healthRouter,
});

/** Type-level export for the client to infer procedures */
export type AppRouter = typeof appRouter;
