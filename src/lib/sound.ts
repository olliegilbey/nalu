/* eslint-disable functional/no-let, functional/immutable-data --
 * Parity-locked port from kanagawa-whispers. Module-level singletons (WebAudio
 * context + mute flag) are intentional. See spec §6.
 */
// Tiny client-side sound + mute manager. No assets — uses WebAudio oscillators
// to synthesize a friendly ping (correct) and a sad ping (wrong).

let muted = false;
const listeners = new Set<(m: boolean) => void>();

export const isMuted = () => muted;
export const setMuted = (v: boolean) => {
  muted = v;
  listeners.forEach((l) => l(v));
};
export const subscribeMute = (cb: (m: boolean) => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

let ctx: AudioContext | null = null;
function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  return ctx;
}

function tone(
  c: AudioContext,
  freq: number,
  when: number,
  dur: number,
  type: OscillatorType = "sine",
  peak = 0.18,
) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, when);
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(peak, when + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  o.connect(g).connect(c.destination);
  o.start(when);
  o.stop(when + dur + 0.05);
}

/** Bright ascending arpeggio — C5 → E5 → G5. */
export function playCorrect() {
  if (muted) return;
  const c = getCtx();
  if (!c) return;
  if (c.state === "suspended") c.resume().catch(() => {});
  const t0 = c.currentTime;
  [523.25, 659.25, 783.99].forEach((f, i) => tone(c, f, t0 + i * 0.07, 0.22, "sine", 0.16));
}

/** Soft descending two-tone — A4 → F4. */
export function playWrong() {
  if (muted) return;
  const c = getCtx();
  if (!c) return;
  if (c.state === "suspended") c.resume().catch(() => {});
  const t0 = c.currentTime;
  tone(c, 392.0, t0, 0.22, "triangle", 0.14);
  tone(c, 311.13, t0 + 0.12, 0.32, "triangle", 0.14);
}
