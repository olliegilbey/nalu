"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useScopingState } from "@/hooks/useScopingState";
import { shapeBaselineAnswers } from "@/lib/course/shapeBaselineAnswers";
import { ChatShell } from "./ChatShell";
import { Composer } from "./Composer";
import { MessageBubble, TypingBubble, type ChatMessage } from "./MessageBubble";
import { FrameworkTierList } from "./FrameworkTierList";
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
    isPending,
    submitClarify,
    submitBaselineAnswers,
  } = useScopingState(courseId);

  const [composerValue, setComposerValue] = useState("");

  // Map Turn[] → array of <MessageBubble> / structured renderers.
  const scroll = turns.map((turn, idx) => {
    switch (turn.kind) {
      case "user-topic":
      case "user-clarify-answers":
      case "user-baseline-answers": {
        const msg: ChatMessage = { id: `t${idx}`, role: "user", content: turn.content };
        return <MessageBubble key={idx} message={msg} />;
      }
      case "llm-clarify-intro":
      case "llm-baseline-intro":
      case "llm-baseline-close": {
        const msg: ChatMessage = { id: `t${idx}`, role: "assistant", content: turn.content };
        return <MessageBubble key={idx} message={msg} />;
      }
      case "llm-framework": {
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
      title={null}
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
          questions={activeQuestionnaire ? [...activeQuestionnaire.questions] : null}
          persistKey={activeQuestionnaire?.persistKey}
          moveOn={moveOn}
          onComplete={(answers) => {
            if (!activeQuestionnaire) return;
            if (activeQuestionnaire.kind === "clarify") {
              submitClarify(
                answers.map((a) => ({ questionId: a.question.id, freetext: a.answer })),
              );
            } else {
              // Domain-shape lives in `src/lib/course/shapeBaselineAnswers` so this
              // component stays a thin rendering shell.
              submitBaselineAnswers(shapeBaselineAnswers(answers));
            }
          }}
        />
      }
    >
      {scroll}
      {isPending && <TypingBubble />}
    </ChatShell>
  );
}
