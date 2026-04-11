import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { AppRouter } from "@/server/routers";

/**
 * tRPC React context — provides typed hooks for calling tRPC procedures.
 * TRPCProvider wraps the app; useTRPC gives access to typed query options.
 */
export const { TRPCProvider, useTRPC, useTRPCClient } =
  createTRPCContext<AppRouter>();

/** Base URL helper for tRPC client link configuration */
export function getBaseUrl(): string {
  if (typeof window !== "undefined") return "";
  return `http://localhost:${process.env.PORT ?? 3000}`;
}
