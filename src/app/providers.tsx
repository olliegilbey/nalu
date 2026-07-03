"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { useState } from "react";
import { TRPCProvider, getBaseUrl } from "@/lib/trpc";
import type { AppRouter } from "@/server/routers";

/** Fallback dev user UUID — matches the seeded row in seed.ts. */
const DEV_USER_FALLBACK = "a0000000-0000-4000-8000-000000000001";

/**
 * Root providers — wraps the app with tRPC + TanStack Query.
 * Dev-only: injects `x-dev-user-id` header so `protectedProcedure` resolves
 * a user without real auth. Swap for a Supabase session token when auth lands.
 */
export function Providers({ children }: { readonly children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [
        httpBatchLink({
          url: `${getBaseUrl()}/api/trpc`,
          // Dev-only: lets protectedProcedure resolve ctx.userId without real auth.
          // Gated on NODE_ENV so a production build can't leak the spoofable header
          // even if the server-side dev-stub auth seam is still in place.
          headers: () =>
            process.env.NODE_ENV === "development"
              ? { "x-dev-user-id": process.env.NEXT_PUBLIC_DEV_USER_ID ?? DEV_USER_FALLBACK }
              : {},
        }),
      ],
    }),
  );

  return (
    <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </TRPCProvider>
  );
}
