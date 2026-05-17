import { getCourseById } from "@/db/queries/courses";
import type {
  ClarificationJsonb,
  FrameworkJsonb,
  BaselineJsonb,
  BaselineClosedJsonb,
} from "@/lib/types/jsonb";

/** Input to {@link getState}. `userId` enforces row-level ownership. */
export interface GetStateParams {
  readonly userId: string;
  readonly courseId: string;
}

/**
 * The portion of `scopingResult` that exists only after `submitBaseline` has
 * closed scoping. `deriveTurns` gates `move-on-cta` on this being non-null.
 */
export interface ScopingResult {
  readonly closingMessage: string;
  readonly startingTier: number;
}

/**
 * Client-facing projection of a `courses` row. Each JSONB column is exposed
 * directly so `deriveTurns` can render the chat scroll from a single object.
 * `scopingResult` is the post-close summary; null while scoping is in progress.
 */
export interface CourseState {
  readonly courseId: string;
  readonly status: "scoping" | "active" | "archived";
  readonly topic: string;
  readonly clarification: ClarificationJsonb | null;
  readonly framework: FrameworkJsonb | null;
  /** The pre-close baseline JSONB (questions only). Null when not yet generated. */
  readonly baseline: BaselineJsonb | null;
  /** Populated only when `status === 'active'`. Drives the Move-on CTA. */
  readonly scopingResult: ScopingResult | null;
}

/**
 * Read a course and project to the client-facing state shape.
 *
 * Trust boundary: `getCourseById` runs `courseRowGuard` which Zod-validates
 * every JSONB column. Ownership is enforced by passing `userId`; rows owned
 * by other users surface as `NotFoundError` (info-leak-safe).
 */
export async function getState(params: GetStateParams): Promise<CourseState> {
  const course = await getCourseById(params.courseId, params.userId);

  const baseline = (course.baseline as BaselineJsonb | null) ?? null;
  // The `in` check narrows baseline to BaselineClosedJsonb (the "widened" post-submitBaseline shape).
  const closedBaseline: BaselineClosedJsonb | null =
    baseline !== null && "startingTier" in baseline ? (baseline as BaselineClosedJsonb) : null;

  // Fail loud on the post-close invariant: status flips to 'active' inside the
  // same `persistScopingClose` transaction that widens the baseline JSONB, so
  // an 'active' course with a non-closed baseline is a transactional split that
  // would silently suppress the Move-on CTA. Surface it instead.
  if (course.status === "active" && closedBaseline === null) {
    throw new Error(
      `getState: invariant — course ${course.id} is 'active' but baseline is not closed`,
    );
  }

  const scopingResult: ScopingResult | null =
    course.status === "active" && closedBaseline !== null
      ? {
          closingMessage: closedBaseline.userMessage,
          startingTier: closedBaseline.startingTier,
        }
      : null;

  return {
    courseId: course.id,
    status: course.status as CourseState["status"],
    topic: course.topic,
    clarification: (course.clarification as ClarificationJsonb | null) ?? null,
    framework: (course.framework as FrameworkJsonb | null) ?? null,
    baseline,
    scopingResult,
  };
}
