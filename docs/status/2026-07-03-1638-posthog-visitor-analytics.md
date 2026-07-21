# Status: PostHog visitor analytics

## Task Overview

Wire PostHog into Nalu to **know where visitors come from** (geo), plus
referrer/UTM/pageviews. Constraints from the user: "clean and neat, not
extensive" (no big event taxonomy), **anonymous**, and **reuse resumate's EU
PostHog project** (`../resumate`) rather than a new one (free tier = 1 project/
org). Later addition: **preview-deploy data must be separable from production**
in PostHog so test traffic doesn't pollute real analytics.

Success = correct visitor geo landing in PostHog on a real deploy, with
preview vs production distinguishable.

## Reference Docs

- `docs/superpowers/specs/2026-07-02-posthog-visitor-analytics-design.md`
  - **Lines ~1-12 + the "Revision — 2026-07-03" section (~line 158 to end)** are
    the **CURRENT** design (server-side capture). Read the Revision FIRST.
  - Lines ~36-154 are the **original client-only/reverse-proxy design — SUPERSEDED**;
    kept only because it documents *why* the proxy approach fails.
- `docs/superpowers/plans/2026-07-02-posthog-visitor-analytics.md`
  - **Lines 1-11**: SUPERSEDED banner. The task list below it is the client
    approach, kept for record only — do not execute.
- Memory `reference_posthog_reverse_proxy_breaks_geoip` — the core gotcha.

## Current State

**Branch:** `feat/posthog-analytics` (7 commits ahead of `main`, not pushed, no PR yet):
- `70d853e` docs(spec) · `c338d7a` docs(plan)
- `ebc7d9a` + `429a279` — **client approach (SUPERSEDED, kept for history)**
- `7aa9c97` docs(spec): pivot to server-side
- `86df740` feat: server-side pageview with correct geo
- `fb7a899` feat: env/source/is_server preview-vs-prod separation

**Working tree:** clean re: this task. `git status` shows only PRE-EXISTING,
UNRELATED changes — `.claude/settings.json` (modified) and 5 untracked
`docs/superpowers/plans/2026-06-10-*.md`. **Leave these alone; not part of this task.**

**Files delivered (server-side approach):**
- `src/lib/analytics/buildPageviewEvent.ts` (+`.test.ts`) — pure `$pageview`
  payload builder. Props: `$current_url`, `$pathname`, `app:"nalu"`, `$ip`,
  `$referrer`/`$referring_domain`, `$raw_user_agent`, `utm_*`, `env`/`source`/`is_server`.
- `src/lib/analytics/capturePageview.ts` (+`.test.ts`) — extracts IP/referrer/UA
  from headers, `POST`s to `https://eu.i.posthog.com/i/v0/e/`. Best-effort, never throws.
- `src/lib/analytics/environmentContext.ts` (+`.test.ts`) — `getServerEnvironmentContext()`
  → `{env, source, is_server}`. `source` = `production|preview|local` from `VERCEL_ENV`.
- `src/proxy.ts` (+`proxy.test.ts`) — added `event?: NextFetchEvent`; after
  resolving the anon user id, `event.waitUntil(capturePageview(...))` gated on
  `env.POSTHOG_KEY` + `userId` + `!prefetch` (skips `next-router-prefetch`/`purpose:prefetch`).
- `src/lib/config.ts` — `POSTHOG_KEY: z.string().optional()` (server env).
- `.env.local.example`, `TODO.md` — documented / marked DONE.
- Client artifacts fully REVERTED: `posthog-js` removed, provider + `next.config.ts`
  rewrites gone.

**Verification done:** `just check` + `just build` clean; **424 unit tests pass**
(incl. 19 new analytics/proxy). Live acceptance: real `POST /api/_lib/i/v0/e/`
returned `{"status":"Ok"}` during the earlier client smoke (proxy plumbing proven).

**Vercel env (`ollie-gg/nalu`, `prj_OLA84Ap2qHpOEPR3OOM5ajUhbtgR`):**
- `POSTHOG_KEY` → **Production: SET.** Preview: **NOT set** (see Next Steps).

## Important Discoveries

1. **Reverse-proxying PostHog breaks GeoIP on PostHog Cloud** — Cloud geolocates
   the TCP connection IP and ignores `X-Forwarded-For` (no trusted-proxies on
   Cloud), so a Vercel proxy makes every visitor look like they're in Vercel's
   datacenter. This killed the original client approach. **Fix = capture
   server-side and pass the real IP as `properties.$ip`** (PostHog uses it in
   preference to the connection IP). Sources cited in the spec Revision.
   resumate has the same latent bug on its *client* events.
2. **`proxy.ts` is the right seam** — Next 16.2 (`node_modules/next/dist/docs/…/proxy.md`)
   confirms Proxy defaults to **Node.js runtime** and exposes `event.waitUntil`.
   It already resolves the anon Supabase user id → `distinct_id` links PostHog
   sessions to DB courses for free (the originally-deferred goal).
3. **Vercel headers** (doc updated 2025-12-13): `x-forwarded-for` = real client
   IP (Nalu is directly on Vercel). `x-vercel-ip-country/city/region/...` are the
   documented fallback if `$ip` ever under-resolves (set `$geoip_*` manually +
   `$geoip_disable:true`).
4. **Env separation** mirrors resumate's `env`/`source`/`is_server` property
   names so the shared project's filters work for both apps. Filter real
   analytics on **`source = production`**.
5. **Vercel CLI v54.3.0 preview-env catch-22 (cost me 3 attempts — don't repeat):**
   Vercel auto-forces `--non-interactive` "when an agent is detected," and in
   that mode it **refuses to assume "all preview branches"** — even the CLI's own
   suggested `vercel env add POSTHOG_KEY preview --value <v> --yes` returns
   `{"status":"action_required","reason":"git_branch_required"}`. Working paths in
   Next Steps. (Production add worked fine via stdin pipe because production has
   no branch ambiguity.)
6. The key lives in `.env.local` as **`NEXT_PUBLIC_POSTHOG_KEY`** (leftover from
   the client smoke); the server var is **`POSTHOG_KEY`** — same `phc_` value
   (47 chars). Source it without exposing:
   `VAL=$(grep -h '^NEXT_PUBLIC_POSTHOG_KEY=' .env.local | cut -d= -f2- | tr -d '\r\n')`.

## Next Steps

Priority order:

1. **Add `POSTHOG_KEY` to Vercel Preview.** Pick one:
   - *All preview branches (best, persistent)* — **dashboard**: Settings → Env
     Variables → `POSTHOG_KEY` → tick **Preview**; OR **interactive terminal**
     (`!` prefix, gets a real TTY so "omit branch = all" works):
     `vercel env add POSTHOG_KEY preview` → paste value → choose "all Preview branches".
   - *This branch only, works from an agent shell*:
     ```
     VAL=$(grep -h '^NEXT_PUBLIC_POSTHOG_KEY=' .env.local | cut -d= -f2- | tr -d '\r\n')
     vercel env add POSTHOG_KEY preview feat/posthog-analytics --value "$VAL" --yes
     ```
     (Passing the git-branch positional avoids the all-branches guard. Downside:
     only that branch's previews get it — a later dashboard "all preview" add
     would then be redundant.)
2. **Open the PR** — invoke `superpowers:finishing-a-development-branch`.
   The user offered to squash the 2 superseded client commits (`ebc7d9a`,
   `429a279`) for a clean history — **ask before squashing**; branch isn't pushed.
3. **Preview test:** deploy preview → load the URL → confirm PostHog events arrive
   with **`source = preview`** and correct geo.
4. **Production geo confirmation:** only verifiable on a real prod deploy
   (`proxy.ts` is prod-gated; local `x-forwarded-for` is localhost). Confirm
   `$geoip_country_name` is correct for a real visit. If missing → the `$geoip_*`
   + `$geoip_disable:true` fallback (Discovery #3).

**Where work stopped (verbatim):**
> User: `/handoff` — "I know that preview is possible to do from the cli though too."

Confirmed true: preview IS CLI-doable, but the **all-preview-branches** form is
blocked from an agent-detected shell (Discovery #5). Branch-specific works from
the agent shell; all-branches needs a real TTY or the dashboard.

## Context to Preserve

- User = Ollie: product-manager-and-learner framing, wants terse/clean, "not
  extensive." Match existing conventions; don't over-build.
- **Security:** never print the `POSTHOG_KEY` value into chat. Source it via
  pipe/shell-var and `--value "$VAL"` (never `--value phc_…` literal). It's a
  public PostHog ingestion key (`phc_`, client-safe by design), but the user
  explicitly asked to keep it out of visible context — honor that.
- **Never bypass git hooks** (`--no-verify` forbidden). Commit subjects must be
  lowercase (commitlint). End every commit message with:
  `Claude-Session: https://claude.ai/code/session_01CPwPMLtj5WqPwryzkRQo33`
- Reused resumate's EU PostHog project; do NOT create a new one. Separation is
  by the `app:"nalu"` and `source` properties (not a separate project).
- `proxy.ts` is prod-gated (`NODE_ENV !== "production"` → passthrough); RLS/anon-
  auth invariants there are load-bearing — the pageview capture was added
  *after* auth resolution and must not change the fail-open behavior.

## Restart Hint

Tests green, branch clean (only unrelated pre-existing tree changes). **Safe to
`/clear`.** Resume by adding the preview key (Next Steps #1) then opening the PR.
