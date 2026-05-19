import { WaveSession } from "@/components/chat/WaveSession";

/**
 * `/course/[id]/wave/[n]` route — renders the wave teaching loop.
 *
 * `n` is the wave ordinal (1-indexed). Invalid path params surface as
 * NOT_FOUND from `wave.getState` server-side; we guard the parse here so
 * a non-integer URL segment doesn't reach the hook at all.
 */
export default async function WavePage({
  params,
}: {
  readonly params: Promise<{ readonly id: string; readonly n: string }>;
}) {
  const { id, n } = await params;
  const waveNumber = Number.parseInt(n, 10);
  if (!Number.isInteger(waveNumber) || waveNumber < 1) {
    return null;
  }
  return <WaveSession courseId={id} waveNumber={waveNumber} />;
}
