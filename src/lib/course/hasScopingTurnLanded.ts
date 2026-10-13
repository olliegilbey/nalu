import type { CourseState } from "./getState";

/** A scoping Turn that can fail and offer a Retry. `scopingClose` is `submitBaseline`. */
export type ScopingTurnKind = "framework" | "baseline" | "scopingClose";

/**
 * True once server state holds the Turn's model output. Pure.
 *
 * The server can commit a Turn whose reply never reached the client (a
 * network drop). A failure the client recorded for a landed Turn is stale,
 * so the caller hides its Retry.
 */
export function hasScopingTurnLanded(state: CourseState, kind: ScopingTurnKind): boolean {
  switch (kind) {
    case "framework":
      return state.framework !== null;
    case "baseline":
      return state.baseline !== null;
    case "scopingClose":
      return state.scopingResult !== null;
  }
}
