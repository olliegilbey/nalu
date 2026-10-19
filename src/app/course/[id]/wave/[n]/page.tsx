import { notFound } from "next/navigation";
import { z } from "zod";
import { WaveSession } from "@/components/chat/WaveSession";

/**
 * Largest Wave ordinal the page accepts: the Postgres `integer` maximum, the
 * type of `waves.wave_number`. A larger ordinal can never exist, and the DB
 * query would fail with a 500 rather than return NOT_FOUND.
 */
const MAX_WAVE_NUMBER = 2_147_483_647;

/** A canonical Wave ordinal: digits only, no sign, no leading zero. */
const WAVE_NUMBER_PATTERN = /^[1-9]\d*$/;

/**
 * `/course/[id]/wave/[n]` route — renders the wave teaching loop.
 *
 * `n` is the wave ordinal (1-indexed). A malformed id or ordinal would fail
 * `wave.getState` input validation (BAD_REQUEST), so the chat would retry,
 * then sit empty. We guard both here so a bad URL never reaches the hook.
 * The ordinal check is strict: `parseInt` once read "2abc" as Wave 2.
 */
export default async function WavePage({
  params,
}: {
  readonly params: Promise<{ readonly id: string; readonly n: string }>;
}) {
  const { id, n } = await params;
  const waveNumber = WAVE_NUMBER_PATTERN.test(n) ? Number(n) : null;
  if (!z.uuid().safeParse(id).success || waveNumber === null || waveNumber > MAX_WAVE_NUMBER) {
    // `notFound()` throws — it never returns, so the route renders the
    // nearest `not-found` boundary with a real HTTP 404 instead of a
    // blank 200 page.
    notFound();
  }
  return <WaveSession courseId={id} waveNumber={waveNumber} />;
}
