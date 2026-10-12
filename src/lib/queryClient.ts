import { QueryClient, type Query } from "@tanstack/react-query";
import { isNotFoundError } from "./errors";

/** Retries for a failed query. Matches TanStack's own default. */
const QUERY_RETRY_COUNT = 3;

/**
 * Refetch a stale query on tab focus or reconnect, unless it last failed with
 * NOT_FOUND. A refetch of a query that never had data clears its error until
 * the reply lands, so a not-found page would flicker back to a spinner.
 */
const refetchUnlessNotFound = (query: Query): boolean => !isNotFoundError(query.state.error);

/**
 * The app's TanStack QueryClient, built once in `providers.tsx`.
 *
 * A NOT_FOUND query is final: a missing row stays missing. It never retries,
 * and tab focus or a reconnect does not refetch it, so the page shows its
 * not-found state at once and keeps it. Other failures retry as usual.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, err) => !isNotFoundError(err) && failureCount < QUERY_RETRY_COUNT,
        refetchOnWindowFocus: refetchUnlessNotFound,
        refetchOnReconnect: refetchUnlessNotFound,
      },
    },
  });
}
