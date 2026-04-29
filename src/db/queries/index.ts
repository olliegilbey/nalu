// Barrel re-export for the query layer.
//
// Callers (tRPC procedures, scripts) import from `@/db/queries` rather than
// reaching into individual files. Each domain module owns its own typed
// param shapes and runtime validators; this file just stitches them
// together. `NotFoundError` is re-exported once from `./errors` so callers
// have a single canonical import site (per-module re-exports remain for
// direct-file imports but are masked at this barrel by ES module semantics).

export { NotFoundError } from "./errors";
export * from "./userProfiles";
export * from "./courses";
export * from "./scopingPasses";
export * from "./waves";
export * from "./contextMessages";
export * from "./concepts";
export * from "./assessments";
