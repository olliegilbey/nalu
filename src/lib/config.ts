import { z } from "zod/v4";

/**
 * Schema for all server-side environment variables.
 * Validated lazily on first access — fails fast with clear errors
 * listing every missing/invalid var.
 */
const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  // New Supabase key system (2025+): publishable replaces the legacy anon JWT.
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().startsWith("sb_publishable_"),
  // New Supabase key system: secret replaces the legacy service_role JWT.
  SUPABASE_SECRET_KEY: z.string().startsWith("sb_secret_"),
  LLM_BASE_URL: z.url(),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().min(1),
  // Default LLM provider when no per-request `nalu-llm-provider` cookie is
  // present. "cerebras" = the LLM_* vars above; "corti" = the CORTI_* vars
  // below. The corti-nalu deployment sets LLM_PROVIDER=corti.
  LLM_PROVIDER: z.enum(["cerebras", "corti"]).default("cerebras"),
  CORTI_BASE_URL: z.url().default("https://ai.eu.corti.app/v1"),
  // Either a ready bearer (CORTI_API_KEY) or the console's client-credential
  // trio, from which provider.ts derives the bearer as
  // base64(tenant:client_credentials:client_id:client_secret) — the same
  // construction @corti/cli uses for the OpenAI-compatible endpoint.
  // All optional at boot so cerebras-only environments still start; a call
  // that selects corti without either form throws a descriptive error.
  CORTI_API_KEY: z.string().min(1).optional(),
  CORTI_TENANT_NAME: z.string().min(1).optional(),
  CORTI_CLIENT_ID: z.string().min(1).optional(),
  CORTI_CLIENT_SECRET: z.string().min(1).optional(),
  CORTI_MODEL: z.string().min(1).default("corti-s1"),
  NEXT_PUBLIC_DEV_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  DATABASE_URL: z.url(), // pooled, used by app at runtime
  DIRECT_URL: z.url(), // direct, used by drizzle-kit migrate
  DEV_USER_ID: z.uuid(), // seed user id; refs auth.users when auth lands
  // PostHog EU project public key (phc_…). Server-side only — proxy.ts captures
  // a $pageview per visit. Optional: absent = analytics disabled.
  POSTHOG_KEY: z.string().optional(),
  // Observability flags LLM_TELEMETRY (src/lib/llm/telemetry.ts) and
  // LLM_DEVTOOLS (src/lib/llm/provider.ts) are deliberately NOT in this
  // schema: their helpers read process.env directly, and a strict entry here
  // would turn a flag typo into a whole-app boot crash via schema validation.
});

/** Validated environment config. Throws on first access if env vars are missing/invalid. */
// Mutable cache — intentional; lazy init to avoid blowing up client bundles
let _env: z.infer<typeof envSchema> | undefined;

/** Validated server env; throws on first call if any var is missing/invalid. Cached. */
export function getEnv(): z.infer<typeof envSchema> {
  if (!_env) {
    _env = envSchema.parse(process.env);
  }
  return _env;
}
