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

  try {
    const { data } = await supabase.auth.getUser();
    if (!data.user) {
      // No session yet — mint an anonymous account. `signInAnonymously`
      // triggers `setAll`, writing the new session cookies onto `response`.
      //
      // Known race (acceptable for MVP): two near-simultaneous first visits
      // — e.g. a prefetched <Link> load racing the real navigation — can each
      // see "no user" and mint their own account; the losing cookie is
      // discarded, leaving a stray session-less `auth.users` row. Harmless
      // (the surviving cookie wins, `ensureUserProfile` is idempotent). See
      // TODO.md for the periodic-cleanup follow-up.
      await supabase.auth.signInAnonymously();
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

  return response;
}

export const config = {
  // Run on page routes only. Exclude API routes (the tRPC route reads the
  // cookie read-only), Next internals, and the root metadata files
  // (`favicon.ico`, `icon.png`, `apple-icon.png` — see `src/app/`). Serving
  // those never needs a session; matching them would mint a throwaway
  // anonymous user on every crawler/browser asset fetch.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|icon.png|apple-icon.png).*)"],
};
