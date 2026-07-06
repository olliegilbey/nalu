import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { AppRouter } from "@/server/routers";

/**
 * tRPC React context — provides typed hooks for calling tRPC procedures.
 * TRPCProvider wraps the app; useTRPC gives access to typed query options.
 */
export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

/** Base URL helper for tRPC client link configuration */
export function getBaseUrl(): string {
  if (typeof window !== "undefined") return "";
  return `http://localhost:${process.env.PORT ?? 3000}`;
}

/** Fallback dev user UUID — matches the seeded row in seed.ts. */
const DEV_USER_FALLBACK = "a0000000-0000-4000-8000-000000000001";

/**
 * Dev-only auth-stub headers, shared by BOTH client transports (tRPC
 * httpBatchLink and the streaming wave-turn DefaultChatTransport) so the
 * server's `resolveRequestUserId` sees one auth story. Empty in production
 * builds: the spoofable header must never ship — prod auth is the Supabase
 * session cookie, which fetch sends automatically.
 */
export function devUserHeaders(): Record<string, string> {
  return process.env.NODE_ENV === "development"
    ? { "x-dev-user-id": process.env.NEXT_PUBLIC_DEV_USER_ID ?? DEV_USER_FALLBACK }
    : {};
}
