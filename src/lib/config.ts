import { z } from "zod/v4";

/**
 * Schema for all server-side environment variables.
 * Validated lazily on first access — fails fast with clear errors
 * listing every missing/invalid var.
 */
const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  LLM_BASE_URL: z.url(),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().min(1),
  NEXT_PUBLIC_DEV_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  DATABASE_URL: z.url(), // pooled, used by app at runtime
  DIRECT_URL: z.url(), // direct, used by drizzle-kit migrate
  DEV_USER_ID: z.uuid(), // seed user id; refs auth.users when auth lands
});

/** Validated environment config. Throws on first access if env vars are missing/invalid. */
// Mutable cache — intentional; lazy init to avoid blowing up client bundles
let _env: z.infer<typeof envSchema> | undefined; // eslint-disable-line functional/no-let

export function getEnv(): z.infer<typeof envSchema> {
  if (!_env) {
    _env = envSchema.parse(process.env);
  }
  return _env;
}

/**
 * Test-only: invalidate the cached env so the next `getEnv()` re-reads
 * `process.env`. Used by the close-scoping live smoke to swap models
 * mid-test (llama for clarify/framework/baseline, qwen for the close turn
 * only — llama's 8k ceiling overflows on the close after prior turns are
 * appended). Production never mutates env, so never calls this.
 */
export function __resetEnvCacheForTests(): void {
  _env = undefined;
}
