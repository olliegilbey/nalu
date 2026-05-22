"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useScopingState } from "@/hooks/useScopingState";
import { shapeQuestionnaireAnswers } from "@/lib/course/shapeQuestionnaireAnswers";
import { shapeClarifyAnswers } from "@/lib/course/shapeClarifyAnswers";
import { ChatShell } from "./ChatShell";
import { Composer } from "./Composer";
import { MessageBubble, TypingBubble, type ChatMessage } from "./MessageBubble";
import { FrameworkTierList } from "./FrameworkTierList";
import { formatComposerAnswers } from "@/lib/course/formatComposerAnswers";
import { t } from "@/i18n";

/**
 * Drives the chat scroll + Composer mode for a given courseId.
 *
 * Reads turns/active questionnaire/result from `useScopingState`; maps Turn[]
 * to bubble JSX (with FrameworkTierList for the framework turn); selects
 * Composer mode (free-text idle / question / move-on) based on derived state.
 */
export function Onboarding({ courseId }: { readonly courseId: string }) {
  const router = useRouter();
  const {
    turns,
    activeQuestionnaire,
    scopingResult,
    topic,
    isPending,
    submitClarify,
    submitBaselineAnswers,
  } = useScopingState(courseId);

  const [composerValue, setComposerValue] = useState("");
  // Optimistic user message. `turnCountAtSubmit` is the `turns.length` captured
  // at submit: the bubble shows while `turns` has not grown past it (server
  // round-trip not yet landed, or it failed) and hides the instant the real
  // turn appears. This prevents a duplicate during the framework→baseline gap
  // (the real turn lands while baseline is still dispatching) and keeps the
  // bubble visible on error.
  const [optimistic, setOptimistic] = useState<{
    readonly content: string;
    readonly turnCountAtSubmit: number;
  } | null>(null);
  // The questionnaire key just submitted — its question card is hidden from the
  // Composer immediately, rather than lingering until the server round-trip.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  // Map Turn[] → array of <MessageBubble> / structured renderers.
  // The scoping flow never emits `assistant-text-with-questionnaire` (that's a
  // wave-only variant) — we keep the case for exhaustiveness and fall through
  // to the plain assistant-text rendering so a misplaced row stays renderable.
  const scroll = turns.map((turn, idx) => {
    switch (turn.kind) {
      case "user-text":
      case "user-questionnaire-answers": {
        const msg: ChatMessage = { id: `t${idx}`, role: "user", content: turn.content };
        return <MessageBubble key={idx} message={msg} />;
      }
      case "assistant-text":
      case "assistant-text-with-questionnaire": {
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
        return null;
    }
  });

  // Compute composer mode.
  const moveOn = scopingResult
    ? {
        label: t<string>("moveOn.toWave").replace("{n}", "1"),
        onAdvance: () => router.push(`/course/${courseId}/wave/1`),
      }
    : undefined;

  return (
    <ChatShell
      title={topic}
      onNew={() => router.push("/")}
      composer={
        <Composer
          value={composerValue}
          onChange={setComposerValue}
          onSend={() => {
            // Free-text-only submit path is unused on this screen for MVP — the
            // Composer enters question mode whenever activeQuestionnaire is set,
            // and Move-on mode otherwise. A plain text send falls through here.
            setComposerValue("");
          }}
          disabled={isPending}
          questions={
            activeQuestionnaire && activeQuestionnaire.questionsKey !== dismissedKey
              ? [...activeQuestionnaire.questions]
              : null
          }
          persistKey={activeQuestionnaire?.persistKey}
          moveOn={moveOn}
          onComplete={(answers) => {
            if (!activeQuestionnaire) return;
            // Render the submitted answers optimistically before the server
            // round-trip lands, and dismiss the question card from the Composer
            // at once. Domain-shape mappers live in `src/lib/course/` so this
            // component stays a thin rendering shell.
            setOptimistic({
              content: formatComposerAnswers(answers),
              turnCountAtSubmit: turns.length,
            });
            setDismissedKey(activeQuestionnaire.questionsKey);
            // On submit failure, un-dismiss the question card and drop the
            // optimistic bubble. The Composer restores the learner's answers
            // from its localStorage buffer, so they only re-do the final step.
            const onError = () => {
              setDismissedKey(null);
              setOptimistic(null);
            };
            if (activeQuestionnaire.kind === "clarify") {
              submitClarify(shapeClarifyAnswers(answers), { onError });
            } else {
              submitBaselineAnswers(shapeQuestionnaireAnswers(answers), { onError });
            }
          }}
        />
      }
    >
      {scroll}
      {optimistic && turns.length === optimistic.turnCountAtSubmit && (
        <MessageBubble message={{ id: "pending", role: "user", content: optimistic.content }} />
      )}
      {isPending && <TypingBubble />}
    </ChatShell>
  );
}
