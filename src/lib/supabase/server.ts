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
