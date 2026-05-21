"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWaveState } from "@/hooks/useWaveState";
import { shapeQuestionnaireAnswers } from "@/lib/course/shapeQuestionnaireAnswers";
import { ChatShell } from "./ChatShell";
import { Composer } from "./Composer";
import { MessageBubble, TypingBubble, type ChatMessage } from "./MessageBubble";
import { FrameworkTierList } from "./FrameworkTierList";
import { t } from "@/i18n";
import type { Turn } from "@/lib/types/turn";

/**
 * Drives the wave teaching chat scroll + Composer mode (spec §7).
 *
 * Parallel to `Onboarding.tsx`. Reads turns/activeQuestionnaire/closeResult/
 * status from `useWaveState`; maps `Turn[]` to bubble JSX. The Composer enters
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
    turns,
    activeQuestionnaire,
    closeResult,
    status,
    isPending,
    submitChatText,
    submitQuestionnaireAnswers,
  } = useWaveState(courseId, waveNumber);

  const [composerValue, setComposerValue] = useState("");

  // Map Turn[] → scroll JSX. The switch is exhaustive over Turn's kinds so a
  // future variant addition becomes a compile-time error here.
  const scroll = turns.map((turn, idx) => renderTurn(turn, idx));

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
      title={null}
      onNew={() => router.push("/")}
      composer={
        <Composer
          value={composerValue}
          onChange={setComposerValue}
          onSend={() => {
            // Free-text send path: submit chat-text turn. Composer-side guard
            // already filters empty strings (it disables the send button).
            const text = composerValue.trim();
            if (text.length === 0) return;
            submitChatText(text);
            setComposerValue("");
          }}
          disabled={isPending}
          questions={activeQuestionnaire ? [...activeQuestionnaire.questions] : null}
          persistKey={activeQuestionnaire?.persistKey}
          moveOn={moveOn}
          onComplete={(answers) => {
            if (!activeQuestionnaire) return;
            // Domain-shape mapper lives in `src/lib/` so this component stays
            // a thin rendering shell.
            submitQuestionnaireAnswers(shapeQuestionnaireAnswers(answers));
          }}
        />
      }
    >
      {scroll}
      {isPending && <TypingBubble />}
    </ChatShell>
  );
}

/**
 * Render one Turn as scroll JSX. Hoisted out so the switch is easy to scan
 * and the parent's render body stays compact. Exhaustive over Turn's kinds.
 *
 * `assistant-text-with-framework` and `move-on-cta` are not emitted by
 * `deriveWaveTurns` in the current spec — they exist in the union for
 * surface symmetry with the scoping projection. The framework case has a
 * defensive render path; move-on is driven by the Composer's `moveOn` prop
 * (see WaveSession above) and renders nothing inline.
 */
function renderTurn(turn: Turn, idx: number) {
  switch (turn.kind) {
    case "user-text":
    case "user-questionnaire-answers": {
      const msg: ChatMessage = { id: `t${idx}`, role: "user", content: turn.content };
      return <MessageBubble key={idx} message={msg} />;
    }
    case "assistant-text":
    case "assistant-text-with-questionnaire": {
      // The questionnaire itself is rendered via the Composer; the prose
      // body of this turn still renders inline as an assistant bubble.
      const msg: ChatMessage = { id: `t${idx}`, role: "assistant", content: turn.content };
      return <MessageBubble key={idx} message={msg} />;
    }
    case "assistant-text-with-framework": {
      const msg: ChatMessage = { id: `t${idx}`, role: "assistant", content: turn.userMessage };
      return (
        <div key={idx}>
          <MessageBubble message={msg} />
          <FrameworkTierList tiers={turn.tiers} />
        </div>
      );
    }
    case "move-on-cta":
      // CTA is rendered via the Composer's moveOn prop, not inline. Returning
      // null keeps the switch exhaustive.
      return null;
  }
}
