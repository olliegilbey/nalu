# Deploying Nalu

Production target: **nalu.ollie.gg** on Vercel. Stack: Next.js 16 (App
Router) + Supabase (anonymous auth + Postgres) + Cerebras LLM. Zero-config
Next.js deploy — no `vercel.json` needed.

## Already done (one-time, external)

- Supabase → **Allow anonymous sign-ins** enabled.
- Cloud Postgres schema migrated (`drizzle-kit migrate` against `DIRECT_URL`).
- Anonymous auth is server-side only, so **no Supabase Site/Redirect URL
  config is required**.

## Vercel project setup

### 1. Create & connect

- Import the GitHub repo into Vercel. Framework preset: **Next.js**
  (auto-detected). Root directory: repo root — Nalu is not a monorepo.
- Package manager: **bun**, auto-detected from `bun.lock`. Install
  `bun install`, build `bun run build` — both auto.
- **Production branch: `main`.**

### 2. Environment variables

Set every variable below in **Settings → Environment Variables**, scoped to
**Production and Preview**. `src/lib/config.ts` (`getEnv`) validates the full
set on first access. `src/proxy.ts` calls it on every page request, so a
missing or malformed var 500s the whole app.

The values match your local `.env.local`. It holds plain values, with no
`op://` references (see `justfile`).

| Variable                               | Value                 | Notes                                                                    |
| -------------------------------------- | --------------------- | ------------------------------------------------------------------------ |
| `NEXT_PUBLIC_SUPABASE_URL`             | from `.env.local`     | public — inlined into the client bundle                                  |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | from `.env.local`     | `sb_publishable_…`; public                                               |
| `SUPABASE_SECRET_KEY`                  | from `.env.local`     | `sb_secret_…`; secret                                                    |
| `LLM_BASE_URL`                         | from `.env.local`     | `https://api.cerebras.ai/v1`                                             |
| `LLM_API_KEY`                          | from `.env.local`     | Cerebras key; secret                                                     |
| `LLM_MODEL`                            | from `.env.local`     | `gpt-oss-120b`; flags in `src/lib/llm/modelCapabilities.ts`              |
| `DATABASE_URL`                         | from `.env.local`     | **pooled** connection (`?pgbouncer=true`) — required for serverless      |
| `DIRECT_URL`                           | from `.env.local`     | direct connection; used only by `drizzle-kit migrate`                    |
| `DEV_USER_ID`                          | any valid UUID        | schema-required even in prod; unused by the prod auth path (see Gotchas) |
| `POSTHOG_KEY`                          | `phc_…` ingestion key | optional — absent disables analytics; read by `src/proxy.ts`             |

`NEXT_PUBLIC_DEV_USER_ID` is **not** needed in production (dev-stub only).
`POSTHOG_PERSONAL_API_KEY` is not needed either. Only the local
visitor-forensics script reads it.

`LLM_TELEMETRY=true` turns on OTel spans for every LLM call
(`src/lib/llm/telemetry.ts`). It sits outside the `getEnv` schema. Spans
export nowhere until an OTLP endpoint is configured (issue #67).

### 3. Custom domain

- Add `nalu.ollie.gg` in **Settings → Domains**.
- At the `ollie.gg` DNS provider, add the record Vercel shows — for a
  subdomain that is a `CNAME` for `nalu` → `cname.vercel-dns.com`.

## Deploying

- Production deploys on every push to `main`.
- Other branches build **Vercel Preview deployments**. Preview needs the env
  vars from step 2.

## Known behaviour & gotchas

- **Preview deploys hit the production Supabase project.** Vercel sets
  `NODE_ENV=production` for every build, including Preview — so Preview
  deployments run the real auth path and mint real anonymous users in the
  production Supabase project. Acceptable for MVP; isolate later with a
  separate Supabase project + Preview-scoped env vars if it matters.
- **`DEV_USER_ID`** is required by the env schema but unused by the
  production auth path (production identity comes from the Supabase session).
  Set it to any UUID — a known wart, not a functional dependency.
- **Migrations do not run on deploy.** A schema change requires
  `drizzle-kit migrate` against the cloud `DIRECT_URL` before the deploy that
  depends on it.
- **`getBaseUrl()`** (`src/lib/trpc.ts`) has a `localhost` fallback for
  server-side tRPC calls. Harmless today — every page fetches client-side, so
  the fallback is never reached — but revisit if SSR/RSC tRPC prefetching is
  added.
- **Function timeouts.** LLM calls run in serverless functions. The
  streaming wave-turn route
  (`src/app/api/course/[courseId]/wave/[waveNumber]/turn/route.ts`) sets
  `maxDuration = 300` to cover retries and rate-limiter pacing. The tRPC
  route sets none, and scoping runs there. Exhausted transport retries can
  hang ~2 minutes (see the `debugging-nalu-llm-pipeline` skill). If scoping
  calls ever 504, set `maxDuration` on `src/app/api/trpc/[trpc]/route.ts`.

## Observability: exporting OTel traces (OTLP)

`src/instrumentation.ts` registers the OTel SDK on every boot, and every LLM
call carries stage-labelled spans gated by `LLM_TELEMETRY` (timing, tokens,
model, retries — `recordInputs`/`recordOutputs` pinned false so learner
content never enters traces). Spans export **nowhere** until an OTLP
destination is configured; `@vercel/otel` picks it up from the standard
[OTLP env vars](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/#otlp-exporter)
— no code change involved.

Verified locally (2026-07-21) against a stub collector: setting
`OTEL_EXPORTER_OTLP_ENDPOINT` alone makes the app POST protobuf spans to
`<endpoint>/v1/traces`, and `OTEL_EXPORTER_OTLP_HEADERS` parses the
comma-separated `Header=Value` list correctly, including the space in
`Bearer <token>`.

To turn it on in production, add to Vercel env (Production; Preview too if
wanted) and redeploy:

| Variable                      | Value                                   |
| ----------------------------- | --------------------------------------- |
| `LLM_TELEMETRY`               | `true` — enables the per-LLM-call spans |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | provider base URL (below)               |
| `OTEL_EXPORTER_OTLP_HEADERS`  | provider auth headers (below)           |

**Axiom** (recommended: one bearer token + dataset header, generous free
tier). Create a dataset (e.g. `nalu`) and an API token with ingest
permission at [axiom.co](https://axiom.co), then:

```
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.axiom.co
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <xaat-token>, X-Axiom-Dataset=nalu
```

**Grafana Cloud** (alternative). From the Cloud portal's OTLP page, copy the
zone gateway + a base64 `instanceID:token` pair:

```
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-<zone>.grafana.net/otlp
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64(instanceID:token)>
```

Once live, wave-turn latency is measurable per stage (`functionId`:
"wave-mid", "clarify", …), step, and tool call — the data needed for the
`reasoning_effort: high` latency watch item.

## Post-deploy smoke

1. Open the deployment URL → first load sets an `sb-…-auth-token` cookie.
2. Scope a topic → a course is created, no errors.
3. Reload the course URL → it persists (same anonymous user).
4. Supabase → Authentication → Users shows the anonymous user; a matching
   `user_profiles` row exists.
