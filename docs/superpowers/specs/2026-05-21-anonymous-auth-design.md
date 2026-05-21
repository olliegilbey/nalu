# Anonymous Auth — Design

**Date:** 2026-05-21
**Status:** Approved design — ready for implementation plan
**Author:** drafted with Claude via brainstorming

## Context & problem

Nalu has no real authentication. User identity is a dev stub:

- `createTRPCContext` (`src/server/trpc.ts`) reads an `x-dev-user-id` header and
  exposes it as `ctx.userId`.
- `providers.tsx` injects that header **only when `NODE_ENV === "development"`**.

Consequence: in a production build (`NODE_ENV === "production"`) no header is
sent, `ctx.userId` is `undefined`, and `protectedProcedure` throws
`UNAUTHORIZED` on **every** call. The app is non-functional on Vercel as it
stands. Production needs a real identity mechanism before `nalu.ollie.gg` can
work at all.

The app currently has **no `@supabase/*` dependency** — it talks to Postgres
directly via Drizzle. The Supabase env vars are validated by `config.ts` but
unused. This work introduces the Supabase client for auth only.

## Goals

- Every production visitor gets a stable, real account with zero login friction.
- A returning visitor in the same browser resumes their courses; a course URL
  works as a personal bookmark.
- The auth seam swaps cleanly to full Supabase Auth (email/OAuth) later with no
  call-site churn.
- Minimal change, minimal risk, shippable today. Local dev and the existing
  test suite are untouched.

## Non-goals (deferred to follow-ups)

- **Turnstile / CAPTCHA** on sign-in. Supabase's built-in 30/hr/IP rate limit
  is the only abuse guard for MVP.
- **Anon-user cleanup cron** (sweeping `auth.users` rows older than 30 days).
- **Account upgrade UI** — linking an email/OAuth to make an anonymous account
  permanent and cross-device. The mechanism (`updateUser` / `linkIdentity`)
  exists; the UI is out of scope here.
- **Cross-device / cross-browser identity.** Anonymous accounts are
  device-bound by nature: clearing cookies, switching browser, or switching
  device yields a fresh account. This is an accepted property, fixed later by
  the account-upgrade flow.

## Approach

**Chosen — proxy-owned anonymous auth, server-only Supabase.**
`proxy.ts` mints the anonymous session; the tRPC context only _reads_ it; the
`user_profiles` row is created by an idempotent app-level upsert. The browser
bundle stays Supabase-unaware — no `providers.tsx` change, no `supabase-js` in
the client bundle.

**Rejected — client-side `signInAnonymously()` in `providers.tsx`.**
Races the first tRPC call (needs a loading gate), ships `supabase-js` to the
client bundle, adds client state. More moving parts for no benefit.

**Rejected — DB trigger (`handle_new_user`) for profile provisioning.**
Requires a hand-written migration — the repo forbids hand-edited migrations
except the documented `pgcrypto` bootstrap — plus a cross-schema
`SECURITY DEFINER` trigger. The app-level upsert is migration-free and testable
with the existing integration harness.

## How anonymous auth works (reference)

`supabase.auth.signInAnonymously()` creates a real `auth.users` row
(`is_anonymous = true`) and returns a session: a short-lived access-token JWT
(~1 hr) plus a long-lived refresh token. With `@supabase/ssr` both tokens live
in HttpOnly cookies so the server can read them. The JWT's `sub` claim is the
user's UUID — the stable identity, and the value used as `user_profiles.id` /
`courses.user_id`.

## Architecture

### Components

1. **`src/lib/supabase/server.ts`** _(new)_ — `createSupabaseServerClient(cookieAdapter)`:
   a thin factory over `@supabase/ssr`'s `createServerClient`. Reads
   `process.env.NEXT_PUBLIC_SUPABASE_URL` and
   `process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` directly (matches
   Supabase's documented pattern; anon sign-in needs only the publishable
   key — the secret key is **not** used). Generic over a cookie get/set
   adapter so both call sites below reuse it.

2. **`src/proxy.ts`** _(new — Next 16 `proxy` convention, formerly `middleware`)_ —
   runs on page routes. Builds a Supabase client bound to request **and**
   response cookies; calls `getUser()`; if there is no user, calls
   `signInAnonymously()`. Returns the response carrying any refreshed
   `Set-Cookie` headers.
   - **Gated on `NODE_ENV === "production"`.** In any other environment it is
     a passthrough (`NextResponse.next()`), so `just dev` and tests keep using
     the existing `x-dev-user-id` seam with no dependency on Supabase Auth.
   - **Fails open:** if Supabase is unreachable, return `NextResponse.next()`
     rather than bricking the page; the subsequent tRPC call degrades to
     `UNAUTHORIZED`, handled by the UI's existing error state.
   - **Matcher:** all routes except `/api` and static assets — i.e. exclude
     `api`, `_next/static`, `_next/image`, `favicon.ico`. The proxy refreshes
     the token on every page navigation; the `/api/trpc` route is a read-only
     consumer of the cookie, so it does not need the proxy.

3. **`src/server/trpc.ts`** _(modified)_
   - `createTRPCContext`: when `NODE_ENV === "production"`, build a
     **read-only** Supabase client from the request's `Cookie` header (a
     cookie adapter whose `setAll` is a no-op — the proxy owns cookie writes),
     call `getUser()`, set `userId = user?.id`. Otherwise keep the existing
     `x-dev-user-id` path unchanged.
   - `protectedProcedure`: add one step that calls
     `ensureUserProfile(ctx.userId)` before the procedure body runs.

4. **`src/db/queries/userProfiles.ts`** _(modified)_ — add
   `ensureUserProfile(userId)`:
   `INSERT INTO user_profiles (id, display_name) VALUES ($1, 'Learner')
ON CONFLICT (id) DO NOTHING`. Idempotent and concurrency-safe. `displayName`
   is `NOT NULL`, so it defaults to `"Learner"`.

5. **`package.json`** — add `@supabase/ssr` and `@supabase/supabase-js`.
   **No new env vars** — `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SECRET_KEY` are
   already declared and validated in `src/lib/config.ts`.

### Why `getUser()`, not the raw cookie

Supabase's docs are explicit: session cookies are spoofable, so the server must
call `getUser()` to validate the token against the auth server. `getClaims()`
(local asymmetric-JWT verification, no network round-trip) is a drop-in latency
optimization noted as a follow-up — not used for MVP to keep the path simple
and unambiguously correct.

### Why the profile upsert lives in `protectedProcedure`

Per-request `ON CONFLICT DO NOTHING` is one cheap round-trip — negligible
beside the multi-second LLM calls — and it is self-healing: if a profile row is
ever missing, the next protected call recreates it before any `courses` write
hits the `user_id` foreign key. Provisioning inside the proxy (only on fresh
sign-in) would be one insert instead of N, but a transient failure there would
leave an authenticated user with no profile and a hard FK error on their next
action. Robustness wins; the cost is trivial.

## Data flow

### First visit

1. `GET /` → proxy runs → no session cookie → `signInAnonymously()` creates an
   `auth.users` row and a session → `Set-Cookie` on the `/` response.
2. The page hydrates; tRPC calls to `/api/trpc` carry the cookie.
3. `createTRPCContext` reads the cookie → `getUser()` → `ctx.userId`.
4. `protectedProcedure` → `ensureUserProfile(userId)` inserts the profile row.
5. `clarify` → `createCourse({ userId })` → a course owned by the anon user.

### Return visit (same browser)

Cookie present → same `userId` → same `user_profiles` row → all started courses
list and resume. A `/course/<id>` URL resumes for its owner; any other visitor
gets `NOT_FOUND` via the existing `getState` / `getWaveState` `userId` filter —
no new authorization code (covered today by
`course.integration.test.ts` ownership-isolation tests).

## Error handling

| Situation                      | Behaviour                                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Proxy can't reach Supabase     | `NextResponse.next()` (fail open); the next tRPC call returns `UNAUTHORIZED`, handled by the existing UI error state. |
| No user in `createTRPCContext` | `protectedProcedure` throws `UNAUTHORIZED` — existing behaviour, existing UI handling.                                |
| Concurrent first requests      | `ensureUserProfile` is idempotent via `ON CONFLICT DO NOTHING`.                                                       |

### Known limitation (accepted for MVP)

Access tokens last ~1 hr. The proxy refreshes on every page navigation,
including wave→wave transitions (each changes the URL). A single wave page held
open for over an hour with zero navigation lets the token expire → tRPC returns
`UNAUTHORIZED` → a page reload re-mints the session. Documented and accepted.

## Testing

- `ensureUserProfile` — integration test (insert-new, insert-idempotent),
  matching the existing `src/db/queries/*.integration.test.ts` pattern.
- `createTRPCContext` resolution — unit test with a mocked Supabase client:
  production path resolves `user.id`; non-production path resolves the
  `x-dev-user-id` header.
- `proxy.ts` — matcher correctness via Next's `unstable_doesProxyMatch`. The
  live Supabase interaction is verified by a manual production smoke:
  `bun run build && bun run start` pointed at the cloud Supabase project.
- Existing `course.integration.test.ts` `UNAUTHORIZED` tests are unaffected —
  they use `createCaller` directly, bypassing `createTRPCContext`.

## Manual configuration (one-time, outside code)

- In the Supabase project's Auth settings, enable **Allow anonymous sign-ins**
  (off by default).

## Footprint

- **New files:** `src/proxy.ts`, `src/lib/supabase/server.ts`.
- **Modified:** `src/server/trpc.ts`, `src/db/queries/userProfiles.ts`,
  `package.json` (+ `bun.lock`).
- **New dependencies:** `@supabase/ssr`, `@supabase/supabase-js`.

## Branching & sequencing (execution note)

PR #12 (`feat/teaching-loop`) is in review and **actively moving** (review
fixes, likely rebases). Branch the auth work off **`main`**, not off
`feat/teaching-loop`:

- `feat/anonymous-auth` then contains only auth commits, on a stable base —
  immune to PR #12 rebases, force-pushes, or branch deletion.
- Auth touches different files than the teaching loop (`src/server/trpc.ts`,
  `src/db/queries/userProfiles.ts`, new files — vs `src/lib/course/*`, the
  wave router, prompts), so the post-merge integration is low-conflict.
- After PR #12 merges, `git rebase main feat/anonymous-auth` replays only the
  auth commits onto the updated `main`. Branching off `feat/teaching-loop`
  instead would leave the original pre-squash teaching-loop commits on the
  auth branch, which collide against the squash-merged version in `main` —
  and that collision is unrecoverable cleanly once `feat/teaching-loop` is
  deleted (the ref marking the branch base is gone).
- This also decouples shipping: auth can merge and deploy independently of
  PR #12's review timeline.

To smoke-test auth + teaching loop together before PR #12 merges, create a
throwaway local branch and merge both into it. This choice does not affect the
design above.

## Follow-ups (out of scope, tracked for later)

- Turnstile / invisible CAPTCHA on anonymous sign-in.
- Scheduled cleanup of stale anonymous `auth.users` rows.
- Account-upgrade flow: link email/OAuth to convert an anonymous account into a
  permanent, cross-device one.
- Swap `getUser()` for `getClaims()` to drop the per-request auth round-trip.
