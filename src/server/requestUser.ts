import { isAuthSessionMissingError } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/**
 * Resolve the requesting learner's id, minting an anonymous one if the request
 * has no session. The one home of the mint rule (#232). Production: the
 * Supabase session cookie. Non-production: the `x-dev-user-id` dev-stub header,
 * so `just dev` and tests need no Supabase Auth. Shared by the tRPC context and
 * the streaming wave-turn route — one auth story, two transports.
 */
export async function resolveRequestUserId(req: Request): Promise<string | undefined> {
  if (process.env.NODE_ENV === "production") {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    if (data.user) return data.user.id;
    // Mint only when Supabase reports no session at all. A session that
    // failed to load (a network blip) is still the learner's; minting over it
    // would replace their cookie and orphan their courses.
    if (!isAuthSessionMissingError(error)) return undefined;
    // Mint lazily, here, not on page loads: only API requests reach this, so
    // crawlers and link unfurlers create no `auth.users` row. `setAll` writes
    // the new session cookies through Next's cookie store, and Next merges
    // them into this Route Handler's response.
    //
    // Known race (acceptable for MVP): two parallel cookieless API requests
    // each mint, and the losing cookie leaves a stray session-less
    // `auth.users` row. `httpBatchLink` folds same-tick tRPC calls into one
    // request, which makes this rare. Cleanup is issue #55.
    const minted = await supabase.auth.signInAnonymously();
    // A failed mint (Supabase's per-IP rate limit, anonymous sign-ins
    // disabled) throws, so it reaches the server log instead of hiding
    // behind an UNAUTHORIZED.
    if (minted.error) throw minted.error;
    return minted.data.user?.id;
  }
  return req.headers.get("x-dev-user-id") ?? undefined;
}
