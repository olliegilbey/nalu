"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWaveState } from "@/hooks/useWaveState";
import { shapeQuestionnaireAnswers } from "@/lib/course/shapeQuestionnaireAnswers";
import { ChatShell } from "./ChatShell";
import { Composer } from "./Composer";
import { MessageBubble, TypingBubble, type ChatMessage } from "./MessageBubble";
import { FrameworkTierList } from "./FrameworkTierList";
import { formatComposerAnswers } from "@/lib/course/formatComposerAnswers";
import { t } from "@/i18n";
import type { ChatEntry } from "@/lib/types/chatEntry";

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
 */
export function WaveSession({
  courseId,
  waveNumber,
}: {
  readonly courseId: string;
  readonly waveNumber: number;
}) {
  const router = useRouter();
  const {
    chatEntries,
    activeQuestionnaire,
    closeResult,
    status,
    topic,
    currentTier,
    xp,
    xpPulseKey,
    xpGainAmount,
    awardMcXp,
    isPending,
    streamingText,
    streamingQuestions,
    submitChatText,
    submitQuestionnaireAnswers,
  } = useWaveState(courseId, waveNumber);

  const [composerValue, setComposerValue] = useState("");
  // Optimistic user message. `entryCountAtSubmit` is the `chatEntries.length`
  // captured at submit: the bubble shows while `chatEntries` has not grown past
  // it (server round-trip not yet landed, or it failed) and hides the instant
  // the real entry appears — so it never duplicates the real entry, and it
  // survives an error rather than vanishing with `isPending`.
  const [optimistic, setOptimistic] = useState<{
    readonly content: string;
    readonly entryCountAtSubmit: number;
  } | null>(null);
  // The questionnaire key just submitted — its question card is hidden from the
  // Composer immediately, rather than lingering until the server round-trip.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  // Map ChatEntry[] → scroll JSX. The switch is exhaustive over ChatEntry's
  // kinds so a future variant addition becomes a compile-time error here.
  const scroll = chatEntries.map((entry, idx) => renderChatEntry(entry, idx));

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
        label: t<string>("moveOn.toWave").replace("{n}", String(nextWaveNumber)),
        onAdvance: () => router.push(`/course/${courseId}/wave/${nextWaveNumber}`),
      }
    : undefined;

  return (
    <ChatShell
      title={topic}
      onNew={() => router.push("/")}
      xp={xp}
      xpPulseKey={xpPulseKey}
      xpGainAmount={xpGainAmount}
      showXp
      composer={
        <Composer
          value={composerValue}
          onChange={setComposerValue}
          onSend={() => {
            // Free-text send path: submit chat-text turn. Composer-side guard
            // already filters empty strings (it disables the send button).
            const text = composerValue.trim();
            if (text.length === 0) return;
            setOptimistic({ content: text, entryCountAtSubmit: chatEntries.length });
            submitChatText(text);
            setComposerValue("");
          }}
          disabled={isPending}
          questions={
            // Committed questionnaire (server-derived, interactive) wins;
            // while a turn streams, the tool-part preview renders the SAME
            // question ids so the Composer's internal state carries across
            // the swap (its identity key is the joined ids). The preview is
            // effectively read-only: isPending disables options + send until
            // the turn result lands and getState refetches.
            activeQuestionnaire && activeQuestionnaire.questionsKey !== dismissedKey
              ? [...activeQuestionnaire.questions]
              : streamingQuestions
                ? [...streamingQuestions]
                : null
          }
          persistKey={activeQuestionnaire?.persistKey}
          waveTier={currentTier ?? undefined}
          onCorrectAnswer={awardMcXp}
          moveOn={moveOn}
          onComplete={(answers) => {
            if (!activeQuestionnaire) return;
            // Optimistic bubble + dismiss the question card at once. Domain-shape
            // mapper lives in `src/lib/` so this component stays a thin shell.
            setOptimistic({
              content: formatComposerAnswers(answers),
              entryCountAtSubmit: chatEntries.length,
            });
            setDismissedKey(activeQuestionnaire.questionsKey);
            // On submit failure, un-dismiss the question card and drop the
            // optimistic bubble. The Composer restores the learner's answers
            // from its localStorage buffer, so they only re-do the final step.
            submitQuestionnaireAnswers(shapeQuestionnaireAnswers(answers), {
              onError: () => {
                setDismissedKey(null);
                setOptimistic(null);
              },
            });
          }}
        />
      }
    >
      {scroll}
      {optimistic && chatEntries.length === optimistic.entryCountAtSubmit && (
        <MessageBubble message={{ id: "pending", role: "user", content: optimistic.content }} />
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
    </ChatShell>
  );
}

/**
 * Render one ChatEntry as scroll JSX. Hoisted out so the switch is easy to scan
 * and the parent's render body stays compact. Exhaustive over ChatEntry's kinds.
 *
 * `assistant-text-with-framework` and `move-on-cta` are not emitted by
 * `deriveWaveChatEntries` in the current spec — they exist in the union for
 * surface symmetry with the scoping projection. The framework case has a
 * defensive render path; move-on is driven by the Composer's `moveOn` prop
 * (see WaveSession above) and renders nothing inline.
 */
function renderChatEntry(entry: ChatEntry, idx: number) {
  switch (entry.kind) {
    case "user-text":
    case "user-questionnaire-answers": {
      const msg: ChatMessage = { id: `t${idx}`, role: "user", content: entry.content };
      return <MessageBubble key={idx} message={msg} />;
    }
    case "assistant-text":
    case "assistant-text-with-questionnaire": {
      // The questionnaire itself is rendered via the Composer; the prose
      // body of this entry still renders inline as an assistant bubble.
      const msg: ChatMessage = { id: `t${idx}`, role: "assistant", content: entry.content };
      return <MessageBubble key={idx} message={msg} />;
    }
    case "assistant-text-with-framework": {
      const msg: ChatMessage = { id: `t${idx}`, role: "assistant", content: entry.userMessage };
      return (
        <div key={idx}>
          <MessageBubble message={msg} />
          <FrameworkTierList tiers={entry.tiers} />
        </div>
      );
    }
    case "move-on-cta":
      // CTA is rendered via the Composer's moveOn prop, not inline. Returning
      // null keeps the switch exhaustive.
      return null;
  }
}
