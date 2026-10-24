import { createServerClient } from "@supabase/ssr";
import { isAuthSessionMissingError } from "@supabase/supabase-js";
import { NextResponse, type NextRequest, type NextFetchEvent } from "next/server";
import { getEnv } from "@/lib/config";
import { capturePageview } from "@/lib/analytics/capturePageview";
import { errorLogLine } from "@/lib/security/errorLogLine";

/**
 * Next.js proxy (formerly `middleware`) — keeps a returning visitor's Supabase
 * session fresh on page loads.
 *
 * It never mints. A visitor with no session cookie leaves without one, so
 * crawlers, link unfurlers and uptime checks create no `auth.users` row
 * (#232). The first API request that needs a learner mints the anonymous
 * session instead (`src/server/requestUser.ts`). A returning visitor's
 * `getUser()` validates the cookie and refreshes it via the `setAll` adapter.
 *
 * Gated on `NODE_ENV === "production"`: in dev/test this is a passthrough so
 * the `x-dev-user-id` stub seam (see `src/server/trpc.ts`) is untouched.
 *
 * Fails open — a Supabase auth error is logged and the page still serves;
 * the subsequent tRPC call degrades to `UNAUTHORIZED`, which the UI already
 * handles.
 *
 * Also fires a best-effort server-side PostHog `$pageview` (via `waitUntil`)
 * with the visitor's real IP as `$ip`, so PostHog Cloud geolocates the visitor
 * rather than our server — the reason we capture here instead of client-side.
 */
export async function proxy(request: NextRequest, event?: NextFetchEvent): Promise<NextResponse> {
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.next();
  }

  // `response` is reassigned by `setAll` when Supabase writes cookies.
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
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
          // Forward the cache-control headers `@supabase/ssr` passes alongside
          // auth cookies (`Cache-Control: private, no-store…`, `Expires: 0`,
          // `Pragma: no-cache`). Without them a CDN or reverse proxy could
          // cache a `Set-Cookie` response and replay one visitor's session
          // token to another — a session-isolation bug. Required by the
          // cookie-adapter contract (see @supabase/ssr `SetAllCookies` type).
          Object.entries(headers).forEach(([key, value]) => {
            response.headers.set(key, value);
          });
        },
      },
    },
  );

  let userId: string | undefined;
  try {
    // Refresh only. `getUser` validates an existing session and, when its
    // access token has expired, refreshes it through `setAll`. A visitor with
    // no session leaves with none: page loads never mint (#232).
    const { data, error } = await supabase.auth.getUser();
    userId = data.user?.id;
    // auth-js returns an auth failure (bad publishable key, auth host
    // unreachable) as `error`; it does not throw. Log it so a *persistent*
    // failure surfaces as a greppable line, not visitors silently degrading
    // to `UNAUTHORIZED`. A missing session is the normal cookieless visit.
    // Serve the page anyway: `response` may carry the cookie clear auth-js
    // writes for a dead session.
    if (error && !isAuthSessionMissingError(error)) {
      process.stderr.write(`${errorLogLine("[proxy] Supabase auth failed", {}, error)}\n`);
    }
  } catch (error) {
    // auth-js rethrows only an error that is not an AuthError. Fail open:
    // never brick a page load on it, and log it the same way.
    process.stderr.write(`${errorLogLine("[proxy] Supabase auth failed", {}, error)}\n`);
    return NextResponse.next();
  }

  // Server-side pageview: `distinct_id` is the anon user id (joins PostHog
  // sessions to DB courses), `$ip` is the real client IP for correct GeoIP.
  // A visitor with no session yet gets a fresh random id instead. Their
  // landing pageview, with its referrer and UTM tags, still lands; it just
  // does not join to the course they may start later (match on `client_ip`).
  // `waitUntil` runs it past the response so it never adds latency. Prefetches
  // never reach here — the matcher's `missing` conditions exclude them (see
  // `config` below; a runtime header check can't work, Next strips them).
  if (env.POSTHOG_KEY && event) {
    event.waitUntil(
      capturePageview({
        apiKey: env.POSTHOG_KEY,
        distinctId: userId ?? crypto.randomUUID(),
        url: request.nextUrl.href,
        headers: request.headers,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  return response;
}

export const config = {
  // Run on page routes only. Exclude API routes (each resolves, and if need
  // be mints, its own learner via `src/server/requestUser.ts`), Next
  // internals, and any dotted path — static assets (`favicon.ico`,
  // `nalu-logo.svg`, everything in `/public`) all contain a `.` and no app
  // route does. Serving assets never needs a session; matching them would
  // count file requests as `$pageview`s (live preview showed `/nalu-logo.svg`
  // firing one).
  //
  // The `missing` conditions skip prefetches entirely. This MUST live in the
  // matcher: Next strips internal Flight headers (`next-router-prefetch`,
  // `rsc`, …) from `request.headers` before proxy code runs ("RSC requests
  // and rewrites", proxy docs), so a runtime header check silently never
  // fires. A prefetch is not a real visit — matching it would inflate
  // `$pageview` counts.
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|.*\\..*).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
