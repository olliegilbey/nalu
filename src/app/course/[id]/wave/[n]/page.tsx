import { notFound } from "next/navigation";
import { z } from "zod";
import { WaveSession } from "@/components/chat/WaveSession";

/**
 * `/course/[id]/wave/[n]` route — renders the wave teaching loop.
 *
 * `n` is the wave ordinal (1-indexed). A malformed id or ordinal would fail
 * `wave.getState` input validation (BAD_REQUEST), so the chat would retry,
 * then sit empty. We guard both here so a bad URL never reaches the hook.
 */
export default async function WavePage({
  params,
}: {
  readonly params: Promise<{ readonly id: string; readonly n: string }>;
}) {
  const { id, n } = await params;
  const waveNumber = Number.parseInt(n, 10);
  if (!z.uuid().safeParse(id).success || !Number.isInteger(waveNumber) || waveNumber < 1) {
    // `notFound()` throws — it never returns, so the route renders the
    // nearest `not-found` boundary with a real HTTP 404 instead of a
    // blank 200 page.
    notFound();
  }
  return <WaveSession courseId={id} waveNumber={waveNumber} />;
}
