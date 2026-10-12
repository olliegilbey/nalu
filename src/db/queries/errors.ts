/**
 * Shared error types for the query layer.
 *
 * Kept in a separate file (no DB imports) so integration tests can import
 * error classes statically without triggering `client.ts` module evaluation
 * before the testcontainer `beforeAll` hook sets `process.env.DATABASE_URL`.
 */

/** Thrown when a required DB row is absent. */
export class NotFoundError extends Error {
  /** `resource` is the entity name, `id` the key that missed; both surface in the message. */
  constructor(
    public readonly resource: string,
    public readonly id: string,
  ) {
    super(`${resource} not found: ${id}`);
    // Restore prototype chain so `instanceof` checks work after transpilation.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a scoping-state write finds its course no longer in `scoping`.
 * The write did not apply. Usually a concurrent scoping close got there first.
 */
export class CourseNotScopingError extends Error {
  /** `courseId` is the course written to; `status` is the status it was found in. */
  constructor(
    public readonly courseId: string,
    public readonly status: string,
  ) {
    super(`course ${courseId} is in status '${status}', not 'scoping'; scoping write skipped`);
    // Restore prototype chain so `instanceof` checks work after transpilation.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
