import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest, type NextFetchEvent } from "next/server";
import { getEnv } from "@/lib/config";
import { capturePageview } from "@/lib/analytics/capturePageview";

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
    const { data } = await supabase.auth.getUser();
    userId = data.user?.id;
    if (!data.user) {
      // No session yet — mint an anonymous account. `signInAnonymously`
      // triggers `setAll`, writing the new session cookies onto `response`.
      //
      // Known race (acceptable for MVP): two near-simultaneous first visits
      // — e.g. parallel document and RSC fetches on a cold load — can each
      // see "no user" and mint their own account; the losing cookie is
      // discarded, leaving a stray session-less `auth.users` row. Harmless
      // (the surviving cookie wins, `ensureUserProfile` is idempotent). See
      // TODO.md for the periodic-cleanup follow-up.
      const signIn = await supabase.auth.signInAnonymously();
      userId = signIn?.data?.user?.id ?? undefined;
    }
  } catch (error) {
    // Fail open: never brick a page load on a transient auth error. Log it so
    // a *persistent* failure — bad publishable key, anonymous sign-ins not
    // enabled in the Supabase dashboard, auth host unreachable — surfaces as
    // a greppable server log instead of every visitor silently degrading to
    // `UNAUTHORIZED` with no signal.
    console.error("[proxy] Supabase auth failed; serving page without session", error);
    return NextResponse.next();
  }

  // Server-side pageview: `distinct_id` is the anon user id (joins PostHog
  // sessions to DB courses), `$ip` is the real client IP for correct GeoIP.
  // `waitUntil` runs it past the response so it never adds latency. Prefetches
  // never reach here — the matcher's `missing` conditions exclude them (see
  // `config` below; a runtime header check can't work, Next strips them).
  if (env.POSTHOG_KEY && userId && event) {
    event.waitUntil(
      capturePageview({
        apiKey: env.POSTHOG_KEY,
        distinctId: userId,
        url: request.nextUrl.href,
        headers: request.headers,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  return response;
}

export const config = {
  // Run on page routes only. Exclude API routes (the tRPC route reads the
  // cookie read-only), Next internals, and any dotted path — static assets
  // (`favicon.ico`, `nalu-logo.svg`, everything in `/public`) all contain a
  // `.` and no app route does. Serving assets never needs a session; matching
  // them would mint a throwaway anonymous user on every crawler/browser asset
  // fetch and count file requests as `$pageview`s (live preview showed
  // `/nalu-logo.svg` firing one).
  //
  // The `missing` conditions skip prefetches entirely. This MUST live in the
  // matcher: Next strips internal Flight headers (`next-router-prefetch`,
  // `rsc`, …) from `request.headers` before proxy code runs ("RSC requests
  // and rewrites", proxy docs), so a runtime header check silently never
  // fires. A prefetch is not a real visit — matching it would both inflate
  // `$pageview` counts and mint anonymous users for hover-prefetches.
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
