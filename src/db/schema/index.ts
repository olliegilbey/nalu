/**
 * Schema barrel — re-exports every table, type, and zod schema from the
 * per-table files so callers can `import * as schema from "@/db/schema"`
 * (used by the Drizzle client and the integration-test harness) or pull
 * named exports directly.
 *
 * No Drizzle `relations()` declarations for MVP — the query layer uses
 * explicit joins via primary-key columns (spec §8 conventions). Adding
 * `relations` is a query-builder convenience we can revisit if a query
 * site genuinely needs nested-result helpers.
 */
export * from "./userProfiles";
export * from "./courses";
export * from "./scopingPasses";
export * from "./waves";
export * from "./contextMessages";
export * from "./concepts";
export * from "./assessments";
