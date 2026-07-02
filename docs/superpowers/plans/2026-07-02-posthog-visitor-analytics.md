# PostHog Visitor Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture Nalu visitor geo/referrer/UTM/pageviews in PostHog with the leanest clean wiring — anonymous only, no custom events.

**Architecture:** Client-only `posthog-js`, initialised in a thin `PostHogProvider` mounted in the app-shell providers, sending events through a same-origin Next.js reverse proxy (`/api/_lib/*` → PostHog EU) so ad-blockers don't drop them. Anonymous events (`identified_only`, never `identify`) still get GeoIP enrichment from `$ip`.

**Tech Stack:** Next.js 16.2 (App Router, Turbopack), `posthog-js` (`^1.297.x`), React 19, Vitest + `@testing-library/react` (jsdom).

**Spec:** `docs/superpowers/specs/2026-07-02-posthog-visitor-analytics-design.md`

## Global Constraints

- Reuse **resumate's existing EU PostHog project** — separation is via the `app: "nalu"` super-property + the `nalu.*` `$host`. Region host: `https://eu.i.posthog.com` (assets `https://eu-assets.i.posthog.com`), UI host `https://eu.posthog.com`.
- **Anonymous only:** never call `posthog.identify`. `person_profiles: "identified_only"`.
- **No session replay**, no `posthog-node`, no event registry / `useTrackEvent` — YAGNI per spec.
- **No `console.*`** in the provider (Nalu's Errors-tier gate bans stray `console.log`; keep the guard silent).
- Client env var `NEXT_PUBLIC_POSTHOG_KEY` is **not** added to `src/lib/config.ts`'s server Zod schema (client-inlined, unused server-side).
- Every export needs one-line TSDoc (warning-tier gate).
- Commit subjects must be lowercase (commitlint `subject-case`). End every commit message with the trailer `Claude-Session: https://claude.ai/code/session_01CPwPMLtj5WqPwryzkRQo33`.
- Never bypass git hooks (`--no-verify` forbidden). Pre-commit runs secret-scan → format → lint → typecheck → unit tests → knip; a red gate means fix the root cause.

---

## Task 1: PostHog provider component (anonymous, reverse-proxied)

Creates the client provider, installs the SDK, and wires it into the app shell in one commit — so `posthog-js` has a consumer (no dead-dependency) and `PostHogProvider` has a consumer (no dead-export) the instant it exists, keeping knip green.

**Files:**

- Create: `src/app/posthog-provider.tsx`
- Create: `src/app/posthog-provider.test.tsx`
- Modify: `src/app/providers.tsx`
- Modify: `package.json`, `bun.lock` (adds `posthog-js`)

**Interfaces:**

- Produces: `PostHogProvider({ children }: { readonly children: React.ReactNode }): React.JSX.Element` — named export from `src/app/posthog-provider.tsx`. No props beyond `children`. Reads env at runtime: `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_ENABLE_DEV`, `NODE_ENV`.
- Consumes (at runtime, delivered by Task 2): the `/api/_lib/*` reverse-proxy rewrite. Until Task 2 lands, the provider is inert in dev (guard off) and its unit test mocks `posthog-js`, so Task 1 is independently green.

- [ ] **Step 1: Install the SDK**

Run: `bun add posthog-js`
Expected: `package.json` gains `"posthog-js": "^1.297.x"` (or newer 1.x); `bun.lock` updated. Do **not** commit yet.

- [ ] **Step 2: Write the failing test**

Create `src/app/posthog-provider.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import posthog from "posthog-js";
import { PostHogProvider } from "./posthog-provider";

// Mock the SDK singleton — assert on init/register without a real network client.
vi.mock("posthog-js", () => ({
  default: { init: vi.fn(), register: vi.fn() },
}));
// Mock the React wrapper so it just renders children (no PostHog context needed).
vi.mock("posthog-js/react", () => ({
  PostHogProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const KEY = "NEXT_PUBLIC_POSTHOG_KEY";
const DEV = "NEXT_PUBLIC_POSTHOG_ENABLE_DEV";

describe("PostHogProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env[KEY];
    delete process.env[DEV];
  });

  it("renders children and does not initialise when the key is absent", () => {
    render(
      <PostHogProvider>
        <span>child</span>
      </PostHogProvider>,
    );
    // getByText throws if the child is missing — its return is the assertion.
    expect(screen.getByText("child").textContent).toBe("child");
    expect(posthog.init).not.toHaveBeenCalled();
  });

  it("does not initialise in dev without the opt-in flag", () => {
    process.env[KEY] = "phc_test";
    render(
      <PostHogProvider>
        <span>child</span>
      </PostHogProvider>,
    );
    expect(posthog.init).not.toHaveBeenCalled();
  });

  it("initialises reverse-proxied and registers app:nalu when enabled", () => {
    process.env[KEY] = "phc_test";
    process.env[DEV] = "true";
    render(
      <PostHogProvider>
        <span>child</span>
      </PostHogProvider>,
    );
    expect(posthog.init).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({
        api_host: "/api/_lib",
        ui_host: "https://eu.posthog.com",
        person_profiles: "identified_only",
        autocapture: false,
        capture_pageview: true,
        capture_pageleave: true,
      }),
    );
    expect(posthog.register).toHaveBeenCalledWith({ app: "nalu" });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun run test src/app/posthog-provider.test.tsx`
Expected: FAIL — cannot resolve `./posthog-provider` (module not yet created).

- [ ] **Step 4: Create the provider**

Create `src/app/posthog-provider.tsx`:

```tsx
"use client";

import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { useEffect } from "react";

/**
 * Initialises anonymous, reverse-proxied PostHog (via `/api/_lib`, see
 * `next.config.ts`) and wraps the tree so `usePostHog` works. Captures
 * pageviews/pageleaves + referrer/UTM; geo comes from server-side `$ip`
 * enrichment. Silent no-op when disabled — missing `NEXT_PUBLIC_POSTHOG_KEY`,
 * or dev without `NEXT_PUBLIC_POSTHOG_ENABLE_DEV=true` — so local/test runs
 * don't pollute the shared project. Never calls `identify` (anonymous only).
 */
export function PostHogProvider({ children }: { readonly children: React.ReactNode }) {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const enabled =
    Boolean(key) &&
    (process.env.NODE_ENV === "production" ||
      process.env.NEXT_PUBLIC_POSTHOG_ENABLE_DEV === "true");

  useEffect(() => {
    // `!key` also narrows `key` to string for `posthog.init`.
    if (!enabled || !key) return;
    posthog.init(key, {
      api_host: "/api/_lib", // same-origin proxy → PostHog EU (next.config rewrites)
      ui_host: "https://eu.posthog.com",
      person_profiles: "identified_only", // anonymous only — no person profiles created
      defaults: "2025-05-24",
      autocapture: false, // explicit signals only, no click/input noise
      capture_pageview: true,
      capture_pageleave: true,
    });
    // Super-property stamped on every event — separates Nalu from resumate in
    // the shared project (filter insights on `app = "nalu"`).
    posthog.register({ app: "nalu" });
  }, [enabled, key]);

  if (!enabled) return <>{children}</>;
  return <PHProvider client={posthog}>{children}</PHProvider>;
}
```

Note: `process.env.NEXT_PUBLIC_*` is read inside the component body / effect, which Next inlines at build the same as a top-level read, and which Vitest reads dynamically — so the tests can toggle env per case. If TypeScript rejects `defaults: "2025-05-24"`, check the installed `posthog-js` config type in `node_modules/posthog-js/` for the exact accepted literal and use it (resumate pins `^1.297.2` where this value is valid).

- [ ] **Step 5: Wire it into the app-shell providers**

Modify `src/app/providers.tsx` — add the import and wrap the existing tree (outermost, so capture is independent of tRPC):

```tsx
import { PostHogProvider } from "./posthog-provider";
```

Change the returned JSX from:

```tsx
return (
  <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  </TRPCProvider>
);
```

to:

```tsx
return (
  <PostHogProvider>
    <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </TRPCProvider>
  </PostHogProvider>
);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun run test src/app/posthog-provider.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 7: Typecheck + lint + knip**

Run: `just typecheck && just lint`
Expected: no errors. If knip runs in lint, confirm it does **not** flag `posthog-js` or `PostHogProvider` (both now consumed).

- [ ] **Step 8: Commit**

```bash
git add src/app/posthog-provider.tsx src/app/posthog-provider.test.tsx src/app/providers.tsx package.json bun.lock
git commit -m "feat(analytics): posthog provider, anonymous + reverse-proxied

Client-only posthog-js in a guarded PostHogProvider mounted in the app
shell. Silent no-op unless key present and prod (or dev opt-in). Registers
app:\"nalu\" so events separate cleanly inside resumate's shared EU project.

Claude-Session: https://claude.ai/code/session_01CPwPMLtj5WqPwryzkRQo33"
```

---

## Task 2: Reverse-proxy rewrites, env docs, TODO cleanup

Adds the runtime plumbing the provider's `api_host: "/api/_lib"` depends on, documents the env vars, and ticks the tracking TODO. Verified by a clean production build.

**Files:**

- Modify: `next.config.ts`
- Modify: `.env.local.example`
- Modify: `TODO.md`

**Interfaces:**

- Consumes: the provider from Task 1 (its `/api/_lib` `api_host`).
- Produces: same-origin rewrites `/api/_lib/:path*` → `eu.i.posthog.com`, `/api/_lib/static/:path*` → `eu-assets.i.posthog.com`.

- [ ] **Step 1: Verify the Next 16.2 rewrites API**

Read `node_modules/next/dist/docs/` for `rewrites` and `skipTrailingSlashRedirect` (AGENTS rule — 16.2 may differ from training data). Confirm `async rewrites()` returning an array of `{ source, destination }` is current, and that it coexists with `turbopack`. (Rewrites are Next-routing, not bundler — expected to be unchanged.)

- [ ] **Step 2: Add the rewrites**

Replace `next.config.ts` with:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the Turbopack workspace root to this project directory. The repo nests
  // git worktrees under `.claude/worktrees/`, so multiple `bun.lock` files can
  // exist up the directory tree; without this pin, Turbopack infers the
  // outermost lockfile's directory as the root and builds the wrong project's
  // files. See:
  // https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack#root-directory
  turbopack: {
    root: import.meta.dirname,
  },
  // Reverse-proxy PostHog through our own origin so ad-blockers (which block
  // requests to *.posthog.com) don't drop analytics. The client SDK points at
  // `/api/_lib` (src/app/posthog-provider.tsx); these rewrites forward it to
  // PostHog EU ingestion + its asset CDN. `src/proxy.ts` already excludes
  // `/api`, so this path never mints an anonymous session.
  async rewrites() {
    return [
      {
        source: "/api/_lib/static/:path*",
        destination: "https://eu-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/api/_lib/:path*",
        destination: "https://eu.i.posthog.com/:path*",
      },
    ];
  },
  // PostHog's ingestion API uses trailing-slash paths; without this Next would
  // 308-redirect them and break capture.
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
```

- [ ] **Step 3: Document the env vars**

Append to `.env.local.example`:

```bash

# PostHog analytics (client-only, anonymous). Reuses resumate's EU project —
# paste that project's public key here. Absent = analytics disabled (dev/test).
# Events carry app:"nalu"; filter on it in PostHog. Client-inlined NEXT_PUBLIC_
# var — not in src/lib/config.ts (server schema).
NEXT_PUBLIC_POSTHOG_KEY=phc_xxxxxxxxxxxxxxxxxxxxxxxx
# Set "true" to capture from a local `just dev` (otherwise only production
# initialises, keeping local noise out of the shared project).
NEXT_PUBLIC_POSTHOG_ENABLE_DEV=false
```

- [ ] **Step 4: Tick the TODO**

In `TODO.md`, under `### Wire PostHog for visitor attribution`, mark it done: change the heading to `### Wire PostHog for visitor attribution — DONE 2026-07-02` and add one line under it: `Implemented client-only anonymous capture (reverse-proxied, app:"nalu"). Spec: docs/superpowers/specs/2026-07-02-posthog-visitor-analytics-design.md. Deferred: Supabase-user identify (see below).` Leave the deferred `identify`/linking context in place.

- [ ] **Step 5: Full gate + production build**

Run: `just check && just build`
Expected: all checks pass; build compiles with the rewrites (no config error).

- [ ] **Step 6: Commit**

```bash
git add next.config.ts .env.local.example TODO.md
git commit -m "feat(analytics): reverse-proxy rewrites + env docs; tick TODO

/api/_lib/* -> PostHog EU so ad-blockers don't drop events. Documents
NEXT_PUBLIC_POSTHOG_KEY / _ENABLE_DEV. Marks the TODO done.

Claude-Session: https://claude.ai/code/session_01CPwPMLtj5WqPwryzkRQo33"
```

---

## Verification & rollout (needs Ollie's key — not a commit)

The public key is required only here, never during Tasks 1-2 (the code guards on its absence).

- [ ] **Live smoke (local):** Ollie adds resumate's `NEXT_PUBLIC_POSTHOG_KEY` to `.env.local`. Run `NEXT_PUBLIC_POSTHOG_ENABLE_DEV=true just dev`, load `/`. In the browser Network tab, confirm a POST to `/api/_lib/` (a `$pageview`); in PostHog (resumate's EU project → Activity) confirm the event with `app: "nalu"` and `$geoip_*` properties. If events don't arrive: check the rewrite (curl `http://localhost:3000/api/_lib/` should proxy, not 404) and that the key is the EU project's.
- [ ] **Production:** Ollie sets the same `NEXT_PUBLIC_POSTHOG_KEY` in Vercel's prod env (leave `NEXT_PUBLIC_POSTHOG_ENABLE_DEV` unset — prod initialises unconditionally when the key is present). Deploy; verify a real pageview lands with geo.
- [ ] **PR:** open against `main`; note reuse of resumate's project + the `app: "nalu"` filter in the description.

---

## Self-review

- **Spec coverage:** dependency (T1 S1) ✓; `next.config.ts` rewrites + trailing-slash (T2 S2) ✓; `posthog-provider.tsx` guard + init + `register` (T1 S4) ✓; `providers.tsx` wrap (T1 S5) ✓; `.env.local.example` (T2 S3) ✓; unit tests (T1 S2) ✓; `just check`/`just build` gate (T2 S5) ✓; live smoke + prod (Verification) ✓; TODO cleanup (T2 S4) ✓. No gaps.
- **Anonymous-only / no-identify / replay-off / no server SDK:** honored — provider never calls `identify`, no `posthog-node`, no replay config.
- **Type consistency:** `PostHogProvider({ children })` signature identical in provider, test, and `providers.tsx` import. `posthog.init`/`posthog.register` names match the mock and assertions.
- **Placeholder scan:** every code step has complete code; no TBD/TODO-in-plan.
