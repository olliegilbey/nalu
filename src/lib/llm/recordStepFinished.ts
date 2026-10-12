import type { LlmUsage } from "@/lib/types/llm";
import { recordCerebrasRateLimitHeaders } from "./cerebrasRateLimit";
import { recordUsage } from "./runUsageTally";

/**
 * The one bookkeeping call after every Step: feed the `x-ratelimit-*`
 * headers to the pacing limiter, and the token usage to the cost tally.
 * Call it on every path where the provider answered, including a Step
 * whose output then failed validation; Cerebras bills that Step too.
 * Either argument may be missing when the provider exposed none.
 */
export function recordStepFinished(
  headers: Readonly<Record<string, string>> | undefined,
  usage: LlmUsage | undefined,
): void {
  recordCerebrasRateLimitHeaders(headers);
  if (usage !== undefined) recordUsage(usage);
}
