"use client";

import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { useEffect } from "react";

/**
 * Initialises anonymous, reverse-proxied PostHog (via `/api/_lib`, see
 * `next.config.ts`) and wraps the tree so `usePostHog` works. Captures
 * pageviews (incl. App Router history-change navigations) + referrer/UTM; geo
 * comes from server-side `$ip` enrichment. Silent no-op when disabled — missing
 * `NEXT_PUBLIC_POSTHOG_KEY`, or dev without `NEXT_PUBLIC_POSTHOG_ENABLE_DEV=true`
 * — so local/test runs don't pollute the shared project. Never calls `identify`
 * (anonymous only).
 */
export function PostHogProvider({ children }: { readonly children: React.ReactNode }) {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const enabled =
    Boolean(key) &&
    (process.env.NODE_ENV === "production" ||
      process.env.NEXT_PUBLIC_POSTHOG_ENABLE_DEV === "true");

  useEffect(() => {
    // `!key` also narrows `key` to string for `posthog.init`.
    if (!enabled || !key) return;
    posthog.init(key, {
      api_host: "/api/_lib", // same-origin proxy → PostHog EU (next.config rewrites)
      ui_host: "https://eu.posthog.com",
      person_profiles: "identified_only", // anonymous only — no person profiles created
      defaults: "2025-05-24",
      autocapture: false, // explicit signals only, no click/input noise
      capture_pageview: "history_change", // initial load + client-side route changes
      capture_pageleave: true,
    });
    // Super-property stamped on every event — separates Nalu from resumate in
    // the shared project (filter insights on `app = "nalu"`).
    posthog.register({ app: "nalu" });
  }, [enabled, key]);

  if (!enabled) return <>{children}</>;
  return <PHProvider client={posthog}>{children}</PHProvider>;
}
