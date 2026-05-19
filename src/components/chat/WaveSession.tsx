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
 * Parallel to `Onboarding.tsx`. Reads turns/activeQuestionnaire/closeResult
 * from `useWaveState`; maps `Turn[]` to bubble JSX. The Composer enters
 * question mode whenever an open questionnaire is present; chat-text mode
 * otherwise; move-on mode once `closeResult` is set.
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
    isPending,
    submitChatText,
    submitQuestionnaireAnswers,
  } = useWaveState(courseId, waveNumber);

  const [composerValue, setComposerValue] = useState("");

  // Map Turn[] → scroll JSX. The switch is exhaustive over Turn's kinds so a
  // future variant addition becomes a compile-time error here.
  const scroll = turns.map((turn, idx) => renderTurn(turn, idx));

  // Move-on CTA appears once the close-turn result has landed. The Composer's
  // moveOn prop replaces the input row with a single advance button.
  const moveOn = closeResult
    ? {
        label: t<string>("moveOn.toWave").replace("{n}", String(closeResult.nextWaveNumber)),
        onAdvance: () => router.push(`/course/${courseId}/wave/${closeResult.nextWaveNumber}`),
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
