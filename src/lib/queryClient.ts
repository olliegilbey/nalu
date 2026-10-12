import { QueryClient } from "@tanstack/react-query";
import { isNotFoundError } from "./errors";

/** Retries for a failed query. Matches TanStack's own default. */
const QUERY_RETRY_COUNT = 3;

/**
 * The app's TanStack QueryClient, built once in `providers.tsx`.
 *
 * A NOT_FOUND query never retries: a missing row stays missing, so the page
 * can show its not-found state at once. Other failures retry as usual.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, err) => !isNotFoundError(err) && failureCount < QUERY_RETRY_COUNT,
      },
    },
  });
}
