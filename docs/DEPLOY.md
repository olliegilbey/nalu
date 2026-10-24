# Deploying Nalu

Production target: **nalu.ollie.gg** on Vercel. Stack: Next.js 16 (App
Router) + Supabase (anonymous auth + Postgres) + Cerebras LLM. Zero-config
Next.js deploy — no `vercel.json` needed.

## Already done (one-time, external)

- Supabase → **Allow anonymous sign-ins** enabled.
- Cloud Postgres schema migrated (`just db-migrate-prod`).
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

Production values live here, in Vercel. On your machine, `.env.local` holds
dev values only, and `.env.production.local` holds the few production values
the local tools need (see [Env files on your machine](#env-files-on-your-machine)).
All files hold plain values, with no `op://` references (see `justfile`).

| Variable                               | Value                        | Notes                                                                    |
| -------------------------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| `NEXT_PUBLIC_SUPABASE_URL`             | Supabase project             | public — inlined into the client bundle                                  |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase project             | `sb_publishable_…`; public                                               |
| `SUPABASE_SECRET_KEY`                  | Supabase project             | `sb_secret_…`; secret                                                    |
| `LLM_BASE_URL`                         | same as dev                  | `https://api.cerebras.ai/v1`                                             |
| `LLM_API_KEY`                          | Cerebras                     | Cerebras key; secret                                                     |
| `LLM_MODEL`                            | same as dev                  | `gpt-oss-120b`; vet a replacement with `just probe-model`                |
| `DATABASE_URL`                         | also `.env.production.local` | **pooled** connection (`?pgbouncer=true`) — required for serverless      |
| `DIRECT_URL`                           | also `.env.production.local` | direct connection; used only by `just db-migrate-prod`                   |
| `DEV_USER_ID`                          | any valid UUID               | schema-required even in prod; unused by the prod auth path (see Gotchas) |
| `POSTHOG_KEY`                          | `phc_…` ingestion key        | optional — absent disables analytics; read by `src/proxy.ts`             |

`NEXT_PUBLIC_DEV_USER_ID` is **not** needed in production (dev-stub only).
`POSTHOG_PERSONAL_API_KEY` is not needed in Vercel either. Only the local
visitor-forensics script reads it, from `.env.production.local`.

`LLM_TELEMETRY=true` turns on OTel spans for every LLM call
(`src/lib/llm/telemetry.ts`). It sits outside the `getEnv` schema. Spans
export nowhere until an OTLP endpoint is configured. The recipe is in
[Observability](#observability-exporting-otel-traces-otlp) (issue #67).

Do not set `LLM_DEBUG_GRADINGS` in Vercel. It logs learner answers to
stderr for local grading diagnosis (issue #22). The code honours it only
under `NODE_ENV` `development` or `test`, so it stays off in Production and
Preview anyway.

### 3. Custom domain

- Add `nalu.ollie.gg` in **Settings → Domains**.
- At the `ollie.gg` DNS provider, add the record Vercel shows — for a
  subdomain that is a `CNAME` for `nalu` → `cname.vercel-dns.com`.

## Env files on your machine

Two gitignored files split dev from production:

- `.env.local` holds dev values only (`.env.local.example`). Its database is
  the `just db-up` container: `postgresql://postgres@127.0.0.1:54322/postgres`
  for both URLs, with no password and no `?pgbouncer=true`. `just db-migrate`,
  `db-seed` and `db-reset` refuse any other host.
- `.env.production.local` holds three production values:
  - `DATABASE_URL`, the pooled URL, for the read-only inspectors in
    `.claude/skills/`.
  - `DIRECT_URL`, for `just db-migrate-prod`.
  - `POSTHOG_PERSONAL_API_KEY`, a `phx_` personal key with scope
    `query:read`, for the visitor-forensics script. It reads production
    analytics, so it stays out of `.env.local`.

To set up a machine, or to move production values out of an old
`.env.local`:

1. Put the three production values in `.env.production.local`, and remove
   them from `.env.local`.
2. Point both URLs in `.env.local` at the container. Check without printing
   secrets: `rg -c '@127\.0\.0\.1:54322/' .env.local` prints `2`.
3. Run `just db-up`, `just db-migrate` and `just db-seed`.
4. Run `just db-migrate-prod` once, while no migration is pending. This proves
   the production path before a real migration needs it.

Local work uses `just dev`, which never calls Supabase. `just start` is
different: `next start` sets `NODE_ENV=production`, so `src/proxy.ts` and
`src/server/requestUser.ts` call Supabase. It needs real Supabase keys in
`.env.local`, and it creates anonymous users in that Supabase project.

## Deploying

- Production deploys on every push to `main`.
- Other branches build **Vercel Preview deployments**. Preview needs the env
  vars from step 2.

## Known behaviour & gotchas

- **Anonymous users are minted lazily (#232).** A page load never creates an
  `auth.users` row. `src/proxy.ts` only refreshes an existing session. Only
  a write that needs no existing course mints one
  (`src/server/requestUser.ts`): submitting a topic or saving custom
  instructions (#246). Reads never mint. A cookieless course
  read answers NOT_FOUND, so crawlers on a shared course link create no
  account. There is no API health check; point an uptime monitor at a static
  page. Supabase limits anonymous sign-ins per IP (30 an hour by default;
  Auth → Rate Limits). A learner over it gets "Something went wrong", and the
  `[trpc] procedure failed` log line shows `name=AuthApiError` and
  `authCode=over_request_rate_limit`.
- **Preview deploys hit the production Supabase project.** Vercel sets
  `NODE_ENV=production` for every build, including Preview — so Preview
  deployments run the real auth path and mint real anonymous users in the
  production Supabase project. Acceptable for MVP; isolate later with a
  separate Supabase project + Preview-scoped env vars if it matters.
- **`DEV_USER_ID`** is required by the env schema but unused by the
  production auth path (production identity comes from the Supabase session).
  Set it to any UUID — a known wart, not a functional dependency.
- **Migrations do not run on deploy.** A schema change requires
  `just db-migrate-prod` before the deploy that depends on it. A migration
  that drops a column reverses the order. The app selects every schema column
  by name, so the deployed code fails once its column is gone. Merge, let
  Vercel deploy the code that no longer names the column, then migrate. The
  recipe reads `DIRECT_URL` from `.env.production.local`, ignores the dev
  value in `.env.local`, and refuses a missing, empty or loopback host
  (`src/db/assertRemoteDirectUrl.ts`).
- **Next.js and Bun read `.env.production.local` whenever
  `NODE_ENV=production`**, ahead of `.env.local`. `just build` and
  `just start` export `.env.local` first, and an exported value wins, so they
  stay on the dev database. A bare `bun run start` or `next start` reads the
  production URLs. `just start` still calls Supabase (see
  [Env files on your machine](#env-files-on-your-machine)).
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

`src/instrumentation.ts` registers the OTel SDK on every server boot. With
`LLM_TELEMETRY=true`, every LLM call emits spans labelled by stage
(`functionId`). Spans carry timing, tokens, model and retries.
`src/lib/llm/telemetry.ts` pins `recordInputs` and `recordOutputs` to false,
so no LLM input or output enters a trace. A failed call's span keeps the
error's class name and the ERROR status, and drops the error's message and
stack. Those can quote model output or provider text (issue #204).

Spans export **nowhere** until an OTLP destination is set. `@vercel/otel`
reads it from the standard
[OTLP env vars](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/#otlp-exporter).
No code change is needed.

Verified locally (2026-07-21) against a stub collector, and against the
`@vercel/otel` 2.1 source:

- `OTEL_EXPORTER_OTLP_ENDPOINT` alone makes the app POST protobuf spans to
  `<endpoint>/v1/traces`. The SDK appends `/v1/traces` itself, so leave off
  any trailing slash.
- `OTEL_EXPORTER_OTLP_HEADERS` takes a comma-separated `Header=Value` list.
  The space in `Bearer <token>` survives parsing.
- The protocol defaults to `http/protobuf`, so `OTEL_EXPORTER_OTLP_PROTOCOL`
  can stay unset. gRPC is not supported.

To turn it on in production, add these to Vercel env (Production; Preview
too if wanted), then redeploy:

| Variable                      | Value                                   |
| ----------------------------- | --------------------------------------- |
| `LLM_TELEMETRY`               | `true` — enables the per-LLM-call spans |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | provider base URL (below)               |
| `OTEL_EXPORTER_OTLP_HEADERS`  | provider auth headers (below)           |

**Axiom** (recommended: one bearer token and a dataset header, generous free
tier). At [axiom.co](https://axiom.co), create an Events dataset (e.g.
`nalu`) and an API token with ingest permission. The endpoint is the base
domain of your edge deployment; US East 1 is shown:

```
OTEL_EXPORTER_OTLP_ENDPOINT=https://us-east-1.aws.edge.axiom.co
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <xaat-token>, X-Axiom-Dataset=nalu
```

**Grafana Cloud** (alternative). Copy the OTLP gateway URL and a base64
`instanceID:token` pair from your stack's OpenTelemetry tile:

```
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-<region>.grafana.net/otlp
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64(instanceID:token)>
```

Use these env vars or a Vercel trace drain, not both. When a drain is
configured, `@vercel/otel` skips the env-var exporter.

Once live, LLM latency is measurable per stage (`functionId`: "wave-mid",
"clarify", …), per Step, and per tool call. Issue #68
(`reasoning_effort: high` latency) waits on this data.

## Post-deploy smoke

1. Open the deployment URL in a private window → no `sb-…-auth-token` cookie
   yet. `curl -sI <url> | grep -i 'set-cookie: sb-'` prints nothing.
2. Scope a topic → the `course.clarify` response sets the `sb-…-auth-token`
   cookie, and a course is created, no errors.
3. Reload the course URL → it persists (same anonymous user).
4. Supabase → Authentication → Users shows the anonymous user; a matching
   `user_profiles` row exists.
