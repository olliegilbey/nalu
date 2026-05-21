import { router } from "../trpc";
import { healthRouter } from "./health";
import { courseRouter } from "./course";
import { waveRouter } from "./wave";

/** Root router — all feature routers compose here */
export const appRouter = router({
  health: healthRouter,
  course: courseRouter,
  wave: waveRouter,
});

/** Type-level export for the client to infer procedures */
export type AppRouter = typeof appRouter;
