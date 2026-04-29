/**
 * Shared error types for the query layer.
 *
 * Kept in a separate file (no DB imports) so integration tests can import
 * error classes statically without triggering `client.ts` module evaluation
 * before the testcontainer `beforeAll` hook sets `process.env.DATABASE_URL`.
 */

/** Thrown when a required DB row is absent. */
export class NotFoundError extends Error {
  constructor(
    public readonly resource: string,
    public readonly id: string,
  ) {
    super(`${resource} not found: ${id}`);
    // Restore prototype chain so `instanceof` checks work after transpilation.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
