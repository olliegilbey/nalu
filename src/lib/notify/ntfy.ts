/**
 * ntfy.sh fire-and-forget notifier.
 *
 * Posts a single HTTP message to `NTFY_TOPIC_URL` (e.g. `https://ntfy.sh/<topic>`).
 * No-op when the env var is unset, so dev/test/CI stay silent by default.
 *
 * Intentionally swallows all errors: a notification failure must never break
 * the calling flow (e.g. a course start). Logs to console.warn so failures
 * are still visible in server logs.
 */

/** Payload for {@link notifyEvent}. */
export interface NotifyParams {
  /** Notification title (rendered prominently on the device). */
  readonly title: string;
  /** Notification body (free-form text shown beneath the title). */
  readonly message: string;
}

/**
 * Fire-and-forget POST to the configured ntfy.sh topic.
 *
 * Returns immediately; the network call happens asynchronously and any error
 * is logged and swallowed so the calling flow can never be blocked or broken
 * by a notification failure.
 *
 * @param params - Title and body for the notification.
 */
export function notifyEvent(params: NotifyParams): void {
  const url = process.env.NTFY_TOPIC_URL;
  if (!url) return;

  // Fire-and-forget: we deliberately don't await. The caller's response path
  // must not wait on ntfy.sh (free best-effort service, occasional latency).
  void fetch(url, {
    method: "POST",
    headers: { Title: params.title },
    body: params.message,
  }).catch((err: unknown) => {
    // Best-effort logging; never throw upward.
    console.warn("[notify] ntfy POST failed:", err);
  });
}
