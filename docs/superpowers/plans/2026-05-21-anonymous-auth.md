# Anonymous Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every production visitor a real, friction-free account via Supabase anonymous sign-in, so `nalu.ollie.gg` works without a login screen.

**Architecture:** A Next.js `proxy.ts` mints a Supabase anonymous session (cookie) on first visit. The tRPC context reads that session to resolve `userId`. A `user_profiles` row is provisioned on demand by an idempotent upsert in `protectedProcedure`. All Supabase code is server-side and gated on `NODE_ENV === "production"` — local dev and the test suite keep the existing `x-dev-user-id` stub untouched.

**Tech Stack:** Next.js 16.2 (`proxy.ts`), `@supabase/ssr`, `@supabase/supabase-js`, tRPC v11, Drizzle, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-21-anonymous-auth-design.md`

---

## File map

- **Create:** `src/lib/supabase/server.ts` — Supabase server client bound to the Next request cookie store.
- **Create:** `src/proxy.ts` — Next 16 proxy; mints the anonymous session.
- **Create:** `src/server/trpc.test.ts` — unit test for `createTRPCContext` resolution.
- **Create:** `src/proxy.test.ts` — unit test for the proxy dev-mode gate.
- **Modify:** `src/db/queries/userProfiles.ts` — add `ensureUserProfile`.
- **Modify:** `src/db/queries/userProfiles.integration.test.ts` — test for `ensureUserProfile`.
- **Modify:** `src/server/trpc.ts` — Supabase resolution in `createTRPCContext`; `ensureUserProfile` in `protectedProcedure`.
- **Modify:** `package.json` + `bun.lock` — new dependencies.

---

## Task 1: Add Supabase dependencies

**Files:**

- Modify: `package.json`, `bun.lock`

- [ ] **Step 1: Install the two packages**

Run:

```bash
bun add @supabase/ssr @supabase/supabase-js
```

Expected: both packages added to `dependencies` in `package.json`; `bun.lock` updated.

- [ ] **Step 2: Verify typecheck still passes**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: add @supabase/ssr and @supabase/supabase-js"
```

---

## Task 2: `ensureUserProfile` query

A freshly signed-in anonymous user has an `auth.users` row but no `user_profiles` row. `courses.user_id` has a foreign key to `user_profiles.id`, so the profile must exist before any course write. This query provisions it idempotently.

**Files:**

- Modify: `src/db/queries/userProfiles.ts`
- Test: `src/db/queries/userProfiles.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Add this `it` block inside the existing `describe("userProfiles queries", ...)` in `src/db/queries/userProfiles.integration.test.ts`:

```typescript
it("ensureUserProfile creates a row and is idempotent", async () => {
  await withTestDb(async (db) => {
    const { ensureUserProfile } = await import("./userProfiles");
    await ensureUserProfile(ID);
    // Second call must not throw or duplicate — first-write-wins.
    await ensureUserProfile(ID);
    const rows = await db.select().from(userProfiles).where(eq(userProfiles.id, ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.displayName).toBe("Learner");
  });
});
```

(`ID`, `withTestDb`, `userProfiles`, `eq`, `expect`, `it` are already imported at the top of the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:integration -- userProfiles`
Expected: FAIL — `ensureUserProfile` is not an exported member of `./userProfiles`.

- [ ] **Step 3: Implement `ensureUserProfile`**

Append to `src/db/queries/userProfiles.ts` (after `incrementUserXp`):

```typescript
/**
 * Insert a `user_profiles` row for an authenticated user if one does not
 * already exist.
 *
 * Called from `protectedProcedure` on every authenticated request. A visitor
 * who just signed in anonymously (see `src/proxy.ts`) has an `auth.users` row
 * but no `user_profiles` row yet — and `courses.user_id` references
 * `user_profiles.id`. `onConflictDoNothing` makes repeated calls cheap and
 * race-safe: first write wins, later calls are no-ops.
 *
 * `displayName` is `NOT NULL`; anonymous users have no name, so it defaults
 * to `"Learner"`.
 */
export async function ensureUserProfile(userId: string): Promise<void> {
  await db
    .insert(userProfiles)
    .values({ id: userId, displayName: "Learner" })
    .onConflictDoNothing({ target: userProfiles.id });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:integration -- userProfiles`
Expected: PASS — all `userProfiles queries` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/db/queries/userProfiles.ts src/db/queries/userProfiles.integration.test.ts
git commit -m "feat(db): add ensureUserProfile for on-demand profile provisioning"
```

---

## Task 3: Supabase session resolution in the tRPC context

Creates the Supabase server client and wires it into `createTRPCContext`. In production, identity comes from the Supabase session cookie; otherwise the existing `x-dev-user-id` stub is kept untouched. `protectedProcedure` gains the `ensureUserProfile` call.

**Files:**

- Create: `src/lib/supabase/server.ts`
- Modify: `src/server/trpc.ts`
- Test: `src/server/trpc.test.ts`

- [ ] **Step 1: Create the Supabase server client**

Create `src/lib/supabase/server.ts`:

```typescript
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getEnv } from "@/lib/config";

/**
 * Supabase server client bound to the Next.js request cookie store.
 *
 * Used by `createTRPCContext` (server-side only) to read the anonymous
 * session that `src/proxy.ts` mints. Session refresh and cookie writes are
 * owned by the proxy; the `setAll` handler here tolerates the read-only
 * cookie store of a Server Component (the `try/catch`), so this client is
 * safe to construct anywhere on the server.
 *
 * `cookies()` is async in Next 16 — hence this factory is async.
 */
export async function createClient() {
  const cookieStore = await cookies();
  const env = getEnv();
  return createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Read-only cookie store (Server Component) — safe to ignore;
            // the proxy owns session refresh.
          }
        },
      },
    },
  );
}
```

- [ ] **Step 2: Write the failing test for `createTRPCContext`**

Create `src/server/trpc.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";

// Mock the Supabase server client. `getUserMock` is referenced lazily
// inside the factory, so it is initialised by the time the mock runs
// (mirrors the vi.mock pattern in src/lib/llm/generate.test.ts).
const getUserMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: getUserMock } }),
}));

import { createTRPCContext } from "./trpc";

/** Minimal stand-in for tRPC's FetchCreateContextFnOptions — only `req` is read. */
function fakeOpts(headers: Record<string, string> = {}) {
  return {
    req: new Request("http://localhost/api/trpc", { headers }),
  } as unknown as Parameters<typeof createTRPCContext>[0];
}

afterEach(() => {
  vi.unstubAllEnvs();
  getUserMock.mockReset();
});

describe("createTRPCContext", () => {
  it("non-production: resolves userId from the x-dev-user-id header", async () => {
    const ctx = await createTRPCContext(fakeOpts({ "x-dev-user-id": "dev-1" }));
    expect(ctx.userId).toBe("dev-1");
  });

  it("production: resolves userId from the Supabase session", async () => {
    vi.stubEnv("NODE_ENV", "production");
    getUserMock.mockResolvedValueOnce({ data: { user: { id: "anon-uuid" } } });
    const ctx = await createTRPCContext(fakeOpts());
    expect(ctx.userId).toBe("anon-uuid");
  });

  it("production: userId is undefined when there is no session", async () => {
    vi.stubEnv("NODE_ENV", "production");
    getUserMock.mockResolvedValueOnce({ data: { user: null } });
    const ctx = await createTRPCContext(fakeOpts());
    expect(ctx.userId).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun run test -- trpc`
Expected: FAIL — the production tests fail because `createTRPCContext` does not yet read Supabase claims.

- [ ] **Step 4: Modify `src/server/trpc.ts`**

Add these imports below the existing imports at the top of `src/server/trpc.ts`:

```typescript
import { createClient } from "@/lib/supabase/server";
import { ensureUserProfile } from "@/db/queries/userProfiles";
```

Replace the existing `createTRPCContext` function body:

```typescript
export const createTRPCContext = async (opts: FetchCreateContextFnOptions) => {
  // Production: identity comes from the Supabase session cookie that
  // `src/proxy.ts` mints for every visitor. Non-production keeps the
  // `x-dev-user-id` dev-stub seam so `just dev` and the test suite need
  // no Supabase Auth.
  if (process.env.NODE_ENV === "production") {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    return { userId: data.user?.id };
  }
  // headers.get is the Web Fetch API surface — lowercase keys.
  const devUserId = opts.req.headers.get("x-dev-user-id") ?? undefined;
  return { userId: devUserId };
};
```

Replace the existing `protectedProcedure` definition:

```typescript
/**
 * Authenticated procedure. In production `ctx.userId` is the Supabase
 * anonymous user's id; in dev it is the `x-dev-user-id` stub. Either way,
 * `ensureUserProfile` provisions the `user_profiles` row on demand — a
 * freshly signed-in anonymous user has an `auth.users` row but no profile
 * row, and `courses.user_id` references `user_profiles.id`.
 */
export const protectedProcedure = t.procedure.use(mapNotFound).use(async ({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "no authenticated user" });
  }
  await ensureUserProfile(ctx.userId);
  return next({ ctx: { ...ctx, userId: ctx.userId } });
});
```

- [ ] **Step 5: Run the unit test to verify it passes**

Run: `bun run test -- trpc`
Expected: PASS — all three `createTRPCContext` tests green.

- [ ] **Step 6: Run the full integration suite — `protectedProcedure` regression check**

Run: `bun run test:integration`
Expected: PASS — every existing router/course test still green. This confirms the new `ensureUserProfile` call in `protectedProcedure` (idempotent insert) breaks nothing.

- [ ] **Step 7: Lint and typecheck**

Run: `bun run lint && bun run typecheck`
Expected: no errors. If `functional/immutable-data` flags `cookieStore.set(...)` in `server.ts`, add this exact directive on the line above the `cookieStore.set` call:
`// eslint-disable-next-line functional/immutable-data -- third-party Supabase cookie adapter requires mutation`

- [ ] **Step 8: Commit**

```bash
git add src/lib/supabase/server.ts src/server/trpc.ts src/server/trpc.test.ts
git commit -m "feat(auth): resolve userId from Supabase session in production"
```

---

## Task 4: `proxy.ts` — mint the anonymous session

The Next 16 proxy runs on page routes. On first visit it finds no session and calls `signInAnonymously()`, which writes the session cookies onto the response. Gated on `NODE_ENV === "production"` — a no-op everywhere else.

**Files:**

- Create: `src/proxy.ts`
- Test: `src/proxy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/proxy.test.ts`:

```typescript
// @vitest-environment node
import { describe, it, expect, afterEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { proxy } from "./proxy";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("proxy", () => {
  it("non-production: passes through without touching Supabase", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const res = await proxy(new NextRequest("http://localhost/"));
    expect(res).toBeInstanceOf(NextResponse);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- proxy`
Expected: FAIL — `src/proxy.ts` does not exist.

- [ ] **Step 3: Create `src/proxy.ts`**

```typescript
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getEnv } from "@/lib/config";

/**
 * Next.js proxy (formerly `middleware`) — establishes a Supabase anonymous
 * session for every visitor.
 *
 * On a request with no session cookie it calls `signInAnonymously()`, which
 * creates a real `auth.users` row and writes the session cookies onto the
 * response via the `setAll` adapter. Returning visitors already have the
 * cookie; `getUser()` validates (and refreshes) it.
 *
 * Gated on `NODE_ENV === "production"`: in dev/test this is a passthrough so
 * the `x-dev-user-id` stub seam (see `src/server/trpc.ts`) is untouched.
 *
 * Fails open — a transient Supabase error returns `NextResponse.next()`
 * rather than bricking the page; the subsequent tRPC call degrades to
 * `UNAUTHORIZED`, which the UI already handles.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.next();
  }

  // `response` is reassigned by `setAll` when Supabase writes cookies.
  // eslint-disable-next-line functional/no-let -- @supabase/ssr cookie adapter contract
  let response = NextResponse.next({ request });

  const env = getEnv();
  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    },
  );

  try {
    const { data } = await supabase.auth.getUser();
    if (!data.user) {
      // No session yet — mint an anonymous account. `signInAnonymously`
      // triggers `setAll`, writing the new session cookies onto `response`.
      await supabase.auth.signInAnonymously();
    }
  } catch {
    // Fail open: never brick a page load on a transient auth error.
    return NextResponse.next();
  }

  return response;
}

export const config = {
  // Run on page routes only. Exclude API routes (the tRPC route reads the
  // cookie read-only) and static assets.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- proxy`
Expected: PASS — the non-production passthrough test is green.

- [ ] **Step 5: Lint and typecheck**

Run: `bun run lint && bun run typecheck`
Expected: no errors. If `functional/immutable-data` flags `request.cookies.set` / `response.cookies.set`, add on the line above each:
`// eslint-disable-next-line functional/immutable-data -- @supabase/ssr cookie adapter requires mutation`

- [ ] **Step 6: Commit**

```bash
git add src/proxy.ts src/proxy.test.ts
git commit -m "feat(auth): add proxy to mint Supabase anonymous sessions"
```

---

## Task 5: Full check + manual verification

Code is unit/integration tested; the live Supabase interaction is verified by a manual production smoke. No subagent can do this part — it needs the real Supabase project.

- [ ] **Step 1: Full local check**

Run: `just check`
Expected: format, lint, typecheck, unit tests, integration tests, deadcode — all pass.

- [ ] **Step 2: Supabase dashboard config (one-time, manual)**

In the Supabase project: **Project Settings → Authentication → User Signups** → enable **Allow anonymous sign-ins**.

- [ ] **Step 3: Confirm env vars**

`.env.local` must hold the new-format keys (validated by `src/lib/config.ts`):

- `NEXT_PUBLIC_SUPABASE_URL` — the project URL
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — starts `sb_publishable_`
- `SUPABASE_SECRET_KEY` — starts `sb_secret_`

- [ ] **Step 4: Production smoke**

Run a production build locally, pointed at the cloud Supabase project:

```bash
bun run build && bun run start
```

In a browser, open `http://localhost:3000`:

- **First load:** a `sb-…-auth-token` cookie appears (DevTools → Application → Cookies).
- Start scoping a topic — a course is created; no `UNAUTHORIZED` errors in the console.
- **Reload the page:** the same course list is still there (same anonymous user).
- In the Supabase dashboard, **Authentication → Users** shows one anonymous user; the database has a matching `user_profiles` row.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin feat/anonymous-auth
gh pr create --base main --title "feat: anonymous auth for production" --body "Implements docs/superpowers/specs/2026-05-21-anonymous-auth-design.md"
```

Note: after PR #12 merges, rebase this branch — `git fetch origin && git rebase origin/main`.

---

## Notes for the implementer

- **Database schema must exist in the cloud Supabase project** before the production smoke (Step 4) works — the `user_profiles` / `courses` / etc. tables. That is a separate deploy task (`drizzle-kit migrate` against the cloud `DIRECT_URL`), not part of this plan.
- **No new environment variables.** All three Supabase vars are already declared in `src/lib/config.ts` and `.env.local.example`.
- The proxy's production Supabase path has no automated test by design (it needs a live auth server) — Step 4's manual smoke is its coverage. Everything else is unit/integration tested.
