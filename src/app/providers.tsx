"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { useState } from "react";
import { TRPCProvider, getBaseUrl, devUserHeaders } from "@/lib/trpc";
import type { AppRouter } from "@/server/routers";

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
          // Gated on NODE_ENV (inside devUserHeaders) so a production build can't
          // leak the spoofable header even if the server-side stub seam remains.
          headers: devUserHeaders,
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
