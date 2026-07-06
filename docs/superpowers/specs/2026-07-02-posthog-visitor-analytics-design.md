# PostHog Visitor Analytics — Design

**Date:** 2026-07-02 (revised 2026-07-03)
**Status:** Superseded by the Revision below — client approach abandoned after live verification
**Author:** Ollie + agent (brainstormed)

> **⚠️ Read the Revision at the bottom first.** The original client-only,
> reverse-proxied design below was implemented and smoke-tested, and
> verification revealed it **breaks GeoIP** — the one thing this feature exists
> for. We pivoted to server-side capture. The original is kept for the record
> (it documents why the proxy approach fails).

## Goal

Know where Nalu's visitors come from — geo, referrer, UTM, pageviews — with the
leanest clean wiring. No custom event taxonomy, no `identify`, no server SDK.

## Motivation

A prod visitor's origin is currently unrecoverable after ~1hr: runtime logs age
out fast, Vercel's `client_ip*` metric dimensions are gated behind Observability
Plus, and `@vercel/analytics` is unwired (see `TODO.md` §Analytics / visitor
observability and the `reference_visitor_ip_geo_forensics` memory). Surfaced
2026-07-01 trying to identify an anonymous visitor to the "how transformers work"
demo. With the app link now circulating in job applications, knowing who opens it
is worth having.

## Decisions (locked)

| Decision       | Choice                          | Rationale                                                                                                                                                                                                                                          |
| -------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity       | **Anonymous only**              | Geo/referrer/UTM/pageviews all work off PostHog's cookie id + `$ip`. No auth/tRPC changes. Nalu's client has no way to learn its own user id today (prod resolves it server-side from the cookie), so `identify` would mean new wiring — deferred. |
| Session replay | **Off**                         | Lightest + most private; no capture of learner chat/LLM content. One-line flip later if wanted.                                                                                                                                                    |
| Project        | **Reuse resumate's EU project** | PostHog free tier = 1 project/org; a 2nd project needs the $250/mo Boost add-on. Reuse resumate's project, separated by an `app: "nalu"` super-property + the natural `nalu.*` `$host`.                                                            |

## Approach

Port resumate's **client-only, reverse-proxied** PostHog setup (the reusable
parts of `resumate/lib/posthog-client.tsx` + its `next.config.ts` rewrites),
dropping its event registry, funnel hooks, and server SDK.

**Alternatives rejected:**

- **Direct-to-PostHog (no proxy):** simpler `next.config.ts`, but ad-blockers
  eat a meaningful share of events — undercuts the "know who visits" goal.
- **Server-side `posthog-node`** (capture in `proxy.ts`/tRPC from
  `x-vercel-ip-*` headers): more custom code, loses client referrer/UTM
  richness; the client SDK gets geo for free via `$ip`. Contradicts "not
  extensive."

The reverse proxy is the highest-leverage piece: it's the difference between
capturing most visitors vs. losing ad-blocked ones.

## Components

### 1. Dependency

`bun add posthog-js` (match resumate `^1.297.x`).

### 2. `next.config.ts` (modify)

Add alongside the existing `turbopack.root`:

- `async rewrites()`:
  - `/api/_lib/static/:path*` → `https://eu-assets.i.posthog.com/static/:path*`
  - `/api/_lib/:path*` → `https://eu.i.posthog.com/:path*`
- `skipTrailingSlashRedirect: true` (PostHog trailing-slash API requirement).

Verify both against `node_modules/next/dist/docs/` for Next 16.2 (AGENTS rule).
Rewrites are a Next-layer feature, orthogonal to Turbopack. Nalu's `proxy.ts`
matcher already excludes `/api`, so `/api/_lib/*` won't mint anonymous sessions —
no conflict.

### 3. `src/app/posthog-provider.tsx` (new client component)

Colocated with `providers.tsx`; a thin wrapper mirroring resumate's
`posthog-client.tsx` **minus** its event registry / `useTrackEvent` / funnel
hooks.

- **Init guard:** initialise only when `NEXT_PUBLIC_POSTHOG_KEY` is present
  **and** (`NODE_ENV === "production"` **or**
  `NEXT_PUBLIC_POSTHOG_ENABLE_DEV === "true"`). Otherwise render children
  untouched — no crash in dev/test (no key), and no dev noise into the shared
  resumate project.
- **Init config:**
  ```ts
  posthog.init(key, {
    api_host: "/api/_lib",
    ui_host: "https://eu.posthog.com",
    person_profiles: "identified_only",
    defaults: "2025-05-24",
    autocapture: false, // explicit signals only, no click/input noise
    capture_pageview: true,
    capture_pageleave: true,
  });
  posthog.register({ app: "nalu" }); // super-property on every event
  ```
- `identified_only` + never calling `identify` ⇒ purely anonymous events, no
  person profiles created, no merging with resumate's persons — yet
  geo/referrer/UTM still enrich each event.
- Wraps children in `PostHogProvider` from `posthog-js/react` when active.

### 4. `src/app/providers.tsx` (modify)

Wrap the existing tRPC/TanStack-Query tree in `<PostHogProvider>` — one
structural line.

### 5. `.env.local.example` (modify)

Document `NEXT_PUBLIC_POSTHOG_KEY=` (resumate's project public key, EU) and the
optional `NEXT_PUBLIC_POSTHOG_ENABLE_DEV`. **Not** added to `config.ts`'s server
Zod schema — it's a client-inlined `NEXT_PUBLIC_*` var, unused server-side.

## Data flow

Visitor loads page → `PostHogProvider` inits (prod) → `posthog-js` sends
`$pageview` / `$pageleave` (+ referrer, UTM, `app: "nalu"`) to `/api/_lib/*` →
Next rewrite → `eu.i.posthog.com` → PostHog GeoIP-enriches from `$ip`
(`$geoip_country_name`, `$geoip_city_name`, …). "Where from" = a
pageviews-by-country insight filtered on `app = "nalu"`.

## Out of scope (YAGNI)

resumate's `useTrackEvent`, event registries, funnel hooks, `posthog-node`,
session replay, and `identify`/Supabase-user linking. Each is a small additive
change if wanted later; linking is tracked in `TODO.md`.

## Testing / verification

- **Unit** — `src/app/posthog-provider.test.tsx` (RTL + jsdom, mock
  `posthog-js`): renders children when key absent (no `init` call); when key
  present + enabled, calls `init` with the expected config and
  `register({ app: "nalu" })`.
- **Gate** — `just check` (typecheck/lint/knip/format/unit) + `just build`
  (rewrites + client bundle compile clean).
- **Live smoke** — `NEXT_PUBLIC_POSTHOG_ENABLE_DEV=true just dev`, load `/`,
  confirm a `$pageview` POST hits `/api/_lib/` in the network tab and lands in
  PostHog with `app: "nalu"` + geo properties.
- **Cleanup** — tick off the `TODO.md` PostHog item.

## Key handoff (Ollie's side)

The public key is needed at **two** points — never during implementation (the
code guards on its absence):

1. **Local live smoke:** put resumate's `NEXT_PUBLIC_POSTHOG_KEY` into Nalu's
   `.env.local` before the `just dev` smoke.
2. **Production:** same value into Vercel's prod env before deploy.

## File manifest

- **New:** `src/app/posthog-provider.tsx`, `src/app/posthog-provider.test.tsx`
- **Modify:** `next.config.ts`, `src/app/providers.tsx`, `.env.local.example`,
  `package.json` / `bun.lock`, `TODO.md`

---

# Revision — 2026-07-03: server-side capture (supersedes everything above)

## Why the client approach was abandoned

The client-only design above was built and smoke-tested locally. The reverse
proxy worked (assets + a test event flowed through `/api/_lib` → PostHog EU,
`{"status":"Ok"}`), but two problems surfaced:

1. **GeoIP is wrong for 100% of visitors** — the whole point of the feature.
   With a reverse proxy, the request to PostHog originates from _our server_
   (Vercel), and **PostHog Cloud geolocates the TCP connection IP, ignoring
   `X-Forwarded-For`** (no "trusted proxies" config on Cloud). So every visitor
   appears to come from Vercel's datacenter, not their real location.
   - PostHog docs, [Next.js reverse proxy](https://posthog.com/docs/advanced/proxy/nextjs); community writeup [PostHog client IPs behind reverse proxies](https://simplyleen.com/posts/posthog-reverse-proxy-client-ip/) ("everyone visiting from my VPS in Frankfurt").
2. **Feature leakage from the shared project** — reusing resumate's project
   pulled its remote-config features (session replay recorder, surveys,
   dead-clicks) into Nalu; a resumate survey could render on Nalu. Fixable with
   `disable_*` flags, but a symptom of the shared-project + client-SDK coupling.

## Revised approach: server-side `$pageview` from `proxy.ts`

Capture one `$pageview` per navigation **server-side in `src/proxy.ts`**, which
already runs per page-load in production and already resolves the anonymous
Supabase user id. Pass the visitor's **real IP** as the event property `$ip` so
PostHog GeoIP resolves correctly.

**Why this is the best-practice fix (current docs, verified 2026-07-03):**

- **Correct geo for 100% of visitors, incl. ad-blocked** — capture is
  server-to-server, so no ad-blocker and no proxy-IP problem. PostHog:
  _"explicitly set the event property `$ip` and it will be used in preference to
  the server IP … which will also make the default GeoIP transformation work
  correctly."_
- **`proxy.ts` is the right seam** — Next.js 16.2 `node_modules/next/dist/docs`
  confirms Proxy **defaults to the Node.js runtime** and exposes
  `event.waitUntil(...)`, so we fire the capture without blocking the response.
- **Real client IP is available** — on Vercel, `x-forwarded-for` is _"the public
  IP address of the client"_ (Vercel request-headers doc, updated 2025-12-13);
  Vercel also injects `x-vercel-ip-country/city/...` if we ever want to bypass
  PostHog's GeoIP entirely (`$geoip_disable` + manual `$geoip_*` — documented
  fallback if `$ip` ever under-resolves).
- **Links session ↔ DB user for free** — `distinct_id` = the Supabase anon user
  id (right there in `proxy.ts`), achieving the originally-deferred join.
- **Leaner** — no `posthog-js`, no reverse-proxy rewrites, no client provider,
  no shared-project feature leakage.

**Trade-off:** no in-session client behavior (clicks, SPA analytics beyond
navigations that hit `proxy.ts`, session replay). That's explicitly out of scope
("not extensive"). Richer client analytics can be added later as direct (un-proxied)
`posthog-js` if wanted.

## Components (revised)

1. **`src/lib/analytics/buildPageviewEvent.ts`** (pure, TDD) — builds the PostHog
   capture payload: `event: "$pageview"`, `distinct_id`, `properties` incl.
   `$ip`, `$current_url`, `$pathname`, `$referrer` (+ `$referring_domain`),
   `$raw_user_agent` (PostHog derives browser/OS/device), parsed `utm_*`, and
   `app: "nalu"`.
2. **`src/lib/analytics/capturePageview.ts`** — extracts IP/referrer/UA from
   request headers, builds the event, `POST`s to
   `https://eu.i.posthog.com/i/v0/e/`. Best-effort; never throws.
3. **`src/proxy.ts`** — add `event?: NextFetchEvent` param; after resolving the
   user, `event.waitUntil(capturePageview(...))`, gated on `POSTHOG_KEY` present,
   a resolved `userId`, and **not a prefetch** (`Next-Router-Prefetch` /
   `purpose: prefetch` headers skipped).
4. **`src/lib/config.ts`** — add `POSTHOG_KEY: z.string().optional()` (server
   env now; capture is server-side, so no `NEXT_PUBLIC_` needed).
5. **`.env.local.example`** — `POSTHOG_KEY=phc_...` (resumate's EU project public
   key; used server-side).

## Testing / verification (revised)

- **Unit (TDD)** — `buildPageviewEvent.test.ts`: `$ip`/referrer/UA/UTM inclusion,
  `app:"nalu"`, `$pageview` shape, distinct_id. `capturePageview.test.ts`: builds
  - POSTs to the right URL, swallows fetch errors. `proxy.test.ts`: fires capture
    via `waitUntil` when key+user present & not prefetch; skips otherwise.
- **Gate** — `just check` + `just build`.
- **Live acceptance** — a real `POST` to `/i/v0/e/` returns `{"status":"Ok"}`
  (already confirmed during the client smoke).
- **Geo confirmation (Ollie, on first deploy)** — `proxy.ts` is prod-gated, so
  geo can only be validated on a real Vercel deploy where `x-forwarded-for` is a
  real visitor IP. After deploy, confirm PostHog shows the correct
  `$geoip_country_name` for a real visit. If geo is missing, switch to the
  documented fallback: set `$geoip_*` from the `x-vercel-ip-*` headers +
  `$geoip_disable: true`.

## Key handoff (revised)

`POSTHOG_KEY` (resumate's EU project public key) is needed only in **Vercel prod
env** (and `.env.local` if exercising the prod branch locally). Never needed to
build or unit-test.

## File manifest (revised)

- **New:** `src/lib/analytics/buildPageviewEvent.ts` (+ test),
  `src/lib/analytics/capturePageview.ts` (+ test)
- **Modify:** `src/proxy.ts` (+ `proxy.test.ts`), `src/lib/config.ts`,
  `.env.local.example`, `TODO.md`
- **Reverted:** `src/app/posthog-provider.tsx` (+ test) deleted,
  `next.config.ts` rewrites removed, `src/app/providers.tsx` restored,
  `posthog-js` removed.
