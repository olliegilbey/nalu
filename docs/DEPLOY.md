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
set at boot — a missing or malformed var 500s the whole app.

The values are identical to your local `.env.local` **with one exception**:
`LLM_API_KEY` is a 1Password `op://` reference locally; Vercel needs the
literal key (`op read "op://…"` to resolve it, or copy from 1Password).

| Variable                               | Value                     | Notes                                                                    |
| -------------------------------------- | ------------------------- | ------------------------------------------------------------------------ |
| `NEXT_PUBLIC_SUPABASE_URL`             | from `.env.local`         | public — inlined into the client bundle                                  |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | from `.env.local`         | `sb_publishable_…`; public                                               |
| `SUPABASE_SECRET_KEY`                  | from `.env.local`         | `sb_secret_…`; secret                                                    |
| `LLM_BASE_URL`                         | from `.env.local`         | `https://api.cerebras.ai/v1`                                             |
| `LLM_API_KEY`                          | **resolved Cerebras key** | not the `op://` reference — the literal value                            |
| `LLM_MODEL`                            | from `.env.local`         | floor model deprecates 2026-05-27 — see `TODO.md`                        |
| `DATABASE_URL`                         | from `.env.local`         | **pooled** connection (`?pgbouncer=true`) — required for serverless      |
| `DIRECT_URL`                           | from `.env.local`         | direct connection; used only by `drizzle-kit migrate`                    |
| `DEV_USER_ID`                          | any valid UUID            | schema-required even in prod; unused by the prod auth path (see Gotchas) |
| `NEXT_PUBLIC_DEV_MODE`                 | `false`                   | optional — defaults to `false` if omitted                                |

`NEXT_PUBLIC_DEV_USER_ID` is **not** needed in production (dev-stub only).

### 3. Custom domain

- Add `nalu.ollie.gg` in **Settings → Domains**.
- At the `ollie.gg` DNS provider, add the record Vercel shows — for a
  subdomain that is a `CNAME` for `nalu` → `cname.vercel-dns.com`.

## Deploying

- Production deploys on every push to `main`.
- `main` is not production-ready until both PR #12 and the anonymous-auth PR
  land. Until then, push `feat/anonymous-auth` and use its **Vercel Preview
  deployment** to validate on a real Vercel URL (Preview env vars must be set
  — see step 2).

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
- **Function timeouts.** LLM-calling tRPC procedures run as serverless
  functions. Cerebras is fast and stays well under the default limit; if
  scoping/teaching turns ever 504, raise `maxDuration` on
  `src/app/api/trpc/[trpc]/route.ts`.

## Post-deploy smoke

1. Open the deployment URL → first load sets an `sb-…-auth-token` cookie.
2. Scope a topic → a course is created, no errors.
3. Reload the course URL → it persists (same anonymous user).
4. Supabase → Authentication → Users shows the anonymous user; a matching
   `user_profiles` row exists.
