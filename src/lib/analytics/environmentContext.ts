/**
 * Analytics environment context. Mirrors resumate's `env`/`source`/`is_server`
 * property shape so filters/insights in the shared PostHog project work across
 * both apps. `source` is the key one: it separates preview-deploy events
 * (`"preview"`) from real production (`"production"`) so test traffic never
 * pollutes production analytics.
 */

/** `NODE_ENV`. */
export type EnvType = "development" | "production" | "test";
/** Deployment origin, derived from `VERCEL_ENV`. */
export type SourceType = "local" | "preview" | "production";

/** Environment properties stamped on every server-side event. */
export interface EnvironmentContext {
  readonly env: EnvType;
  readonly source: SourceType;
  readonly is_server: boolean;
}

/**
 * Server-side environment context from `NODE_ENV` + `VERCEL_ENV`. Vercel sets
 * `VERCEL_ENV` to `production` | `preview` | `development`; anything not
 * `production`/`preview` (incl. unset local runs) maps to `"local"`.
 */
export function getServerEnvironmentContext(): EnvironmentContext {
  const env = (process.env.NODE_ENV ?? "development") as EnvType;
  const vercelEnv = process.env.VERCEL_ENV;
  const source: SourceType =
    vercelEnv === "production" ? "production" : vercelEnv === "preview" ? "preview" : "local";
  return { env, source, is_server: true };
}
