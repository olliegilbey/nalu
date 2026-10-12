import { describe, it, expect, vi } from "vitest";

// The page only routes; stub the client component it mounts.
vi.mock("@/components/chat/Onboarding", () => ({ Onboarding: () => null }));

import CoursePage from "./page";

/** Call the async page component with a route param. */
const renderPage = (id: string) => CoursePage({ params: Promise.resolve({ id }) });

describe("/course/[id] page", () => {
  it("404s a malformed course id instead of mounting the chat", async () => {
    // `notFound()` throws this digest; Next renders the not-found boundary.
    await expect(renderPage("not-a-uuid")).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
  });

  it("mounts the chat for a well-formed course id", async () => {
    const id = "3f2b8c1e-9d4a-4b7e-8c2f-1a2b3c4d5e6f";
    const element = await renderPage(id);
    expect(element.props).toEqual({ courseId: id });
  });
});
