"use client";

import { useRouter } from "next/navigation";
import { useWaveState } from "@/hooks/useWaveState";
import { useWaveComposer } from "@/hooks/useWaveComposer";
import { ChatShell } from "./ChatShell";
import { Composer } from "./Composer";
import { CourseNotFound } from "./CourseNotFound";
import { MessageBubble, TypingBubble } from "./MessageBubble";
import { RetryRow } from "./RetryRow";
import { renderChatEntry } from "./renderChatEntry";
import { selectComposerQuestionnaire } from "@/lib/course/selectComposerQuestionnaire";
import { deriveWaveProgress } from "@/lib/course/deriveWaveProgress";
import { WaveProgressBar } from "./WaveProgressBar";
import { t, tFill } from "@/i18n";

/**
 * Drives the wave teaching chat scroll + Composer mode (spec §7).
 *
 * Parallel to `Onboarding.tsx`. Reads chatEntries/activeQuestionnaire/closeResult/
 * status from `useWaveState`; maps `ChatEntry[]` to bubble JSX. The Composer enters
 * question mode whenever an open questionnaire is present; chat-text mode
 * otherwise; move-on mode whenever the wave is closed (either the transient
 * `closeResult` from this tab's close-turn, or a server-reported
 * `status === "closed"` after a reload). The move-on branch replaces the input
 * row entirely, so a finished wave never presents a live-but-dead composer.
 * A failed chat-text send puts its text back in the Composer, and a failed
 * Turn the server saved gets a Retry row (issue #231).
 */
export function WaveSession({
  courseId,
  waveNumber,
}: {
  readonly courseId: string;
  readonly waveNumber: number;
}) {
  const router = useRouter();
  const wave = useWaveState(courseId, waveNumber);
  const {
    chatEntries,
    activeQuestionnaire,
    closeResult,
    status,
    topic,
    turnsRemaining,
    turnBudget,
    xp,
    xpPulseKey,
    xpGainAmount,
    isPending,
    failedTurn,
    waveNotFound,
    streamingText,
    streamingQuestions,
  } = wave;
  // Composer text, the optimistic bubble, and the send and Retry handlers.
  const composer = useWaveComposer(wave);

  // getState found no such Wave for this learner: a wrong URL, a course
  // another browser started, or a Wave number this course lacks. One NOT_FOUND
  // covers all three, so the copy says "lesson", which is true of each (#230).
  if (waveNotFound) return <CourseNotFound message={t<string>("waveNotFound.message")} />;

  // Map ChatEntry[] → scroll JSX. `renderChatEntry` is shared with Onboarding.
  const scroll = chatEntries.map((entry, idx) => renderChatEntry(entry, idx));

  // The answer card the Composer shows, with its own buffer key.
  const card = selectComposerQuestionnaire(
    activeQuestionnaire,
    composer.dismissedKey,
    streamingQuestions,
  );

  // Move-on CTA: shown whenever the wave is finished, NOT only when the
  // transient `closeResult` is present. `closeResult` is component-local state
  // seeded solely by the close-turn mutation in *this* tab — it is gone after a
  // reload. The server-authoritative `status` survives reloads, so a learner
  // who revisits a finished wave (Cmd+R, tab restore, browser-back) still gets
  // a working path to the next wave.
  //
  // Target wave number: prefer `closeResult.nextWaveNumber` (the real id the
  // close-turn computed); on a reloaded closed wave that's unavailable, so fall
  // back to the ordinal `waveNumber + 1` — waves are 1-indexed consecutively
  // and the `/course/[id]/wave/[n]` route resolves by ordinal.
  const nextWaveNumber = closeResult?.nextWaveNumber ?? waveNumber + 1;
  const isClosed = closeResult !== null || status === "closed";
  const moveOn = isClosed
    ? {
        label: tFill("moveOn.toWave", { n: nextWaveNumber }),
        onAdvance: () => router.push(`/course/${courseId}/wave/${nextWaveNumber}`),
      }
    : undefined;

  // Progress strip: the server's turn counts, refetched after each landed
  // Turn. It flips to complete with the move-on CTA, on the same `isClosed`.
  // Null, so no strip, until the state query resolves.
  const progress = deriveWaveProgress({ turnsRemaining, turnBudget, isClosed });

  return (
    <ChatShell
      title={topic}
      onNew={() => router.push("/")}
      xp={xp}
      xpPulseKey={xpPulseKey}
      xpGainAmount={xpGainAmount}
      showXp
      subheader={progress && <WaveProgressBar progress={progress} />}
      composer={
        <Composer
          value={composer.composerValue}
          onChange={composer.setComposerValue}
          onSend={composer.sendChatText}
          disabled={isPending}
          // Committed questionnaire (server-derived, interactive) wins;
          // while a turn streams, the tool-part preview shows instead. The
          // preview is read-only: isPending disables options + send until
          // the turn result lands and getState refetches, and the Composer
          // locks a keyless card's textarea and prev/next.
          // Questions and buffer key come as one pair. A preview has no key,
          // so it never reads or writes another questionnaire's buffer; the
          // Composer re-inits when the committed key arrives (issue #118).
          questions={card ? [...card.questions] : null}
          persistKey={card?.persistKey}
          moveOn={moveOn}
          onComplete={composer.completeQuestionnaire}
        />
      }
    >
      {scroll}
      {composer.optimisticContent !== null && (
        <MessageBubble
          message={{ id: "pending", role: "user", content: composer.optimisticContent }}
        />
      )}
      {/* Streaming bubble: teaching prose arrives token-by-token from the
          in-flight turn (useChat). Markup matches committed assistant bubbles
          so the swap to the canonical server-derived turn on invalidation is
          visually seamless. Typing indicator covers the pre-first-token gap. */}
      {streamingText.length > 0 ? (
        <MessageBubble message={{ id: "streaming", role: "assistant", content: streamingText }} />
      ) : (
        isPending && <TypingBubble />
      )}
      {/* A failed Turn whose entry the server saved. Retry re-sends the same
          payload, so the server reuses that entry. No card can be open here:
          the saved entry is a `text` entry, or answers that close the
          questionnaire. */}
      {failedTurn && <RetryRow disabled={isPending} onRetry={composer.retryFailedTurn} />}
    </ChatShell>
  );
}
