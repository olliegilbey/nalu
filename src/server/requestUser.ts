import { isAuthSessionMissingError } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { errorLogLine } from "@/lib/security/errorLogLine";

/**
 * What one request's session says about its learner. `none` is a caller with
 * no session. `failed` is a session that failed to load, such as a Supabase
 * network blip. It is still a learner's, so callers answer UNAUTHORIZED and
 * never mint over it: a mint would replace their cookie and orphan their
 * courses.
 */
export type RequestSession =
  | { readonly kind: "learner"; readonly userId: string }
  | { readonly kind: "none" }
  | { readonly kind: "failed" };

/**
 * Read the requesting learner from an existing session; never mint. The tRPC
 * context and the streaming wave-turn route both call it, so a read creates
 * no `auth.users` row (#246). Production: the Supabase session cookie.
 * Non-production: the `x-dev-user-id` dev-stub header, so `just dev` and
 * tests need no Supabase Auth.
 */
export async function readRequestSession(req: Request): Promise<RequestSession> {
  if (process.env.NODE_ENV !== "production") {
    const userId = req.headers.get("x-dev-user-id");
    return userId ? { kind: "learner", userId } : { kind: "none" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (data.user) return { kind: "learner", userId: data.user.id };
  if (isAuthSessionMissingError(error)) return { kind: "none" };
  // Log a failed load as one content-free line, so a persistent failure
  // shows up as more than a silent UNAUTHORIZED.
  process.stderr.write(`${errorLogLine("[auth] session failed to load", {}, error)}\n`);
  return { kind: "failed" };
}

/**
 * Mint an anonymous learner and return their id: the one home of the mint
 * (#232). Only `mintingProcedure` reaches it, through the tRPC context's
 * per-request `mintUserId`, after `readRequestSession` found no session
 * (#246). The context refuses a session that failed to load before any
 * procedure runs, so a mint never replaces a learner's cookie. Outside
 * production it never mints: the dev stub has no Supabase Auth, so a request
 * without the `x-dev-user-id` header gets no learner.
 */
export async function mintAnonymousLearner(): Promise<string | undefined> {
  if (process.env.NODE_ENV !== "production") return undefined;
  const supabase = await createClient();
  // `setAll` writes the new session cookies through Next's cookie store, and
  // Next merges them into this Route Handler's response.
  //
  // Known race (acceptable for MVP): two parallel cookieless API requests
  // each mint, and the losing cookie leaves a stray session-less
  // `auth.users` row. `httpBatchLink` folds same-tick tRPC calls into one
  // request, and the context memoises its mint, which makes this rare.
  // Cleanup is issue #55.
  const minted = await supabase.auth.signInAnonymously();
  // A failed mint (Supabase's per-IP rate limit, anonymous sign-ins
  // disabled) throws, so it reaches the server log instead of hiding
  // behind an UNAUTHORIZED.
  if (minted.error) throw minted.error;
  return minted.data.user?.id;
}
