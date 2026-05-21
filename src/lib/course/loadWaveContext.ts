import { TRPCError } from "@trpc/server";
import { getCourseById } from "@/db/queries/courses";
import { getWaveById } from "@/db/queries/waves";
import type { Course, Wave } from "@/db/schema";

/**
 * One round-trip fetch + access-control check for a (user, course, wave)
 * triple. Used by `submitWaveTurn` (and any future server-side path that
 * needs the loaded course + wave pair).
 *
 * Open-questionnaire reconstruction is gone — it now lives on the typed
 * `waves.chat_log` and is derived by a tiny pure helper
 * (`findOpenQuestionnaire`) when needed.
 */
export interface LoadedWaveContext {
  readonly course: Course;
  readonly wave: Wave;
}

/**
 * Load (course, wave) and enforce ownership + cross-course containment.
 *
 * NOT_FOUND from `getCourseById` is the info-leak-safe response for both
 * "no such course" and "course owned by another user". FORBIDDEN for the
 * cross-course mismatch is a real condition: the wave id exists but doesn't
 * belong to the requesting user's course.
 */
export async function loadWaveContext(params: {
  readonly userId: string;
  readonly courseId: string;
  readonly waveId: string;
}): Promise<LoadedWaveContext> {
  // Ownership is enforced inside getCourseById: a course owned by a different
  // user is reported as NotFoundError (info-leak-safe). Router layer maps the
  // class to a TRPC NOT_FOUND code at the transport boundary.
  const course = await getCourseById(params.courseId, params.userId);
  const wave = await getWaveById(params.waveId);
  // Cross-course containment: a wave id that belongs to a different course
  // must not leak into this caller's flow.
  if (wave.courseId !== course.id) {
    throw new TRPCError({ code: "FORBIDDEN", message: "wave does not belong to course" });
  }
  return { course, wave };
}
