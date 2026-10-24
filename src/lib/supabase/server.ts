import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getEnv } from "@/lib/config";

/**
 * Supabase server client bound to the Next.js request cookie store.
 *
 * Used by `readRequestSession` and `resolveOrMintRequestUserId`
 * (`src/server/requestUser.ts`) in the API Route Handlers. There `setAll`
 * writes a freshly minted or refreshed session through `cookies()`, and Next
 * merges it into the handler's response. The `try/catch` tolerates the
 * read-only cookie store of a Server Component, so this client is safe to
 * construct anywhere on the server.
 *
 * `setAll`'s second argument, the `Cache-Control` headers @supabase/ssr asks
 * us to forward, is dropped: `cookies()` cannot set response headers. Safe on
 * Vercel: its CDN caches a function response only with `s-maxage`, and never
 * one carrying `Set-Cookie`. `src/proxy.ts` forwards the headers on page
 * responses.
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
            // Read-only cookie store (Server Component) — safe to ignore.
            // Only Route Handlers mint, and their store is writable; a page's
            // session refresh is the proxy's.
          }
        },
      },
    },
  );
}
