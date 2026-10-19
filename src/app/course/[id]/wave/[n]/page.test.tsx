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

  it("404s a wave number that is not plain digits", async () => {
    // `parseInt` read each of these as a valid Wave and mounted it.
    for (const n of ["2abc", "1.5", "01", "+2", "1e3"]) {
      await expect(renderPage(courseId, n), n).rejects.toMatchObject(notFoundDigest);
    }
  });

  it("404s a wave number past the wave_number column's range", async () => {
    // Postgres `integer` tops out at 2147483647. A larger ordinal would fail
    // the DB query with a 500, not a NOT_FOUND.
    await expect(renderPage(courseId, "2147483648")).rejects.toMatchObject(notFoundDigest);
    await expect(renderPage(courseId, "99999999999999999999")).rejects.toMatchObject(
      notFoundDigest,
    );
  });

  it("mounts the chat for a well-formed course id and wave number", async () => {
    const element = await renderPage(courseId, "2");
    expect(element.props).toEqual({ courseId, waveNumber: 2 });
  });

  it("mounts the largest wave number the column holds", async () => {
    const element = await renderPage(courseId, "2147483647");
    expect(element.props).toEqual({ courseId, waveNumber: 2147483647 });
  });
});
