import { describe, it, expect, vi } from "vitest";

// The page only routes; stub the client component it mounts.
vi.mock("@/components/chat/WaveSession", () => ({ WaveSession: () => null }));

import WavePage from "./page";

const courseId = "3f2b8c1e-9d4a-4b7e-8c2f-1a2b3c4d5e6f";

/** Call the async page component with route params. */
const renderPage = (id: string, n: string) => WavePage({ params: Promise.resolve({ id, n }) });

/** The digest `notFound()` throws; Next renders the not-found boundary. */
const notFoundDigest = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };

describe("/course/[id]/wave/[n] page", () => {
  it("404s a malformed course id instead of mounting the chat", async () => {
    await expect(renderPage("not-a-uuid", "1")).rejects.toMatchObject(notFoundDigest);
  });

  it("404s a wave number that is not a positive integer", async () => {
    await expect(renderPage(courseId, "abc")).rejects.toMatchObject(notFoundDigest);
    await expect(renderPage(courseId, "0")).rejects.toMatchObject(notFoundDigest);
  });

  it("mounts the chat for a well-formed course id and wave number", async () => {
    const element = await renderPage(courseId, "2");
    expect(element.props).toEqual({ courseId, waveNumber: 2 });
  });
});
