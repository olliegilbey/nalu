import { router } from "../trpc";
import { courseRouter } from "./course";
import { waveRouter } from "./wave";
import { profileRouter } from "./profile";

/** Root router — all feature routers compose here */
export const appRouter = router({
  course: courseRouter,
  wave: waveRouter,
  profile: profileRouter,
});

/** Type-level export for the client to infer procedures */
export type AppRouter = typeof appRouter;
