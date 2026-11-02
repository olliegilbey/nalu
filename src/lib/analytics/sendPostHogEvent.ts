/**
 * The one PostHog send. Every server-side capture posts through here, so the
 * endpoint, the timeout and the failure log live in one place. Callers build
 * the event body with a pure `build*Event` and hand it over.
 */

import { errorLogLine } from "@/lib/security/errorLogLine";

/** PostHog EU single-event capture endpoint. */
const CAPTURE_URL = "https://eu.i.posthog.com/i/v0/e/";

/** Abort a hung capture. It runs after the response (`waitUntil` or `after`),
 * so an unbounded request would keep the invocation alive for best-effort
 * analytics. */
const CAPTURE_TIMEOUT_MS = 5_000;

/** POST one capture-API event body to PostHog EU. Best-effort; never throws. */
export async function sendPostHogEvent(event: { readonly event: string }): Promise<void> {
  try {
    const response = await fetch(CAPTURE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
    });
    // `fetch` only rejects on network errors. A bad key or a PostHog outage
    // returns 4xx/5xx "successfully". Log it (greppable, like the proxy's
    // auth-failure log) so production analytics can't die silently. The line
    // names the event only, never its properties.
    if (!response.ok) {
      console.error(`[posthog] ${event.event} capture failed: HTTP ${response.status}`);
    }
  } catch (error) {
    // A network error or the timeout. Log it and go on: a failed analytics
    // call must never surface to the learner. `errorLogLine` keeps the error's
    // class name (e.g. `TimeoutError`) and never its message.
    console.error(errorLogLine(`[posthog] ${event.event} capture failed`, {}, error));
  }
}
