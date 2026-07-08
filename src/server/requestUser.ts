import { createClient } from "@/lib/supabase/server";

/**
 * Resolve the requesting user's id. Production: Supabase session cookie
 * (minted by `src/proxy.ts`). Non-production: the `x-dev-user-id` dev-stub
 * header so `just dev` and tests need no Supabase Auth. Shared by the tRPC
 * context and the streaming wave-turn route — one auth story, two transports.
 */
export async function resolveRequestUserId(req: Request): Promise<string | undefined> {
  if (process.env.NODE_ENV === "production") {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    return data.user?.id;
  }
  return req.headers.get("x-dev-user-id") ?? undefined;
}
