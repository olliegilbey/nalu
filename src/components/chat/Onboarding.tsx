"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useScopingState } from "@/hooks/useScopingState";
import { useCourseXp } from "@/hooks/useCourseXp";
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
 * Reads chatEntries/active questionnaire/result from `useScopingState`; maps
 * ChatEntry[] to bubble JSX (with FrameworkTierList for the framework entry);
 * selects Composer mode (free-text idle / question / move-on) from derived state.
 */
export function Onboarding({ courseId }: { readonly courseId: string }) {
  const router = useRouter();
  const {
    chatEntries,
    activeQuestionnaire,
    scopingResult,
    topic,
    isPending,
    failedStep,
    submitClarify,
    submitBaselineAnswers,
  } = useScopingState(courseId);
  // Per-course XP display counter — surfaces the header XP badge during
  // scoping so learners feel the reward loop from their first correct baseline
  // answer. localStorage-backed and keyed by courseId, so the running total
  // carries into the wave flow (whose `useWaveState` reads the same counter).
  const courseXp = useCourseXp(courseId);

  const [composerValue, setComposerValue] = useState("");
  // Optimistic user message. `entryCountAtSubmit` is the `chatEntries.length`
  // captured at submit: the bubble shows while `chatEntries` has not grown past
  // it (server round-trip not yet landed, or it failed) and hides the instant
  // the real entry appears. This prevents a duplicate during the
  // framework→baseline gap (the real entry lands while baseline is still
  // dispatching) and keeps the bubble visible on error.
  const [optimistic, setOptimistic] = useState<{
    readonly content: string;
    readonly entryCountAtSubmit: number;
  } | null>(null);
  // The questionnaire key just submitted — its question card is hidden from the
  // Composer immediately, rather than lingering until the server round-trip.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  // Map ChatEntry[] → array of <MessageBubble> / structured renderers.
  // The scoping flow never emits `assistant-text-with-questionnaire` (that's a
  // wave-only variant) — we keep the case for exhaustiveness and fall through
  // to the plain assistant-text rendering so a misplaced row stays renderable.
  const scroll = chatEntries.map((entry, idx) => {
    switch (entry.kind) {
      case "user-text":
      case "user-questionnaire-answers": {
        const msg: ChatMessage = { id: `t${idx}`, role: "user", content: entry.content };
        return <MessageBubble key={idx} message={msg} />;
      }
      case "assistant-text":
      case "assistant-text-with-questionnaire": {
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
      xp={courseXp.xp}
      xpPulseKey={courseXp.pulseKey}
      xpGainAmount={courseXp.gainAmount}
      showXp
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
          onCorrectAnswer={courseXp.addXp}
          moveOn={moveOn}
          onComplete={(answers) => {
            if (!activeQuestionnaire) return;
            // Render the submitted answers optimistically before the server
            // round-trip lands, and dismiss the question card from the Composer
            // at once. Domain-shape mappers live in `src/lib/course/` so this
            // component stays a thin rendering shell.
            setOptimistic({
              content: formatComposerAnswers(answers),
              entryCountAtSubmit: chatEntries.length,
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
              submitBaselineAnswers(shapeQuestionnaireAnswers(answers), {
                onError,
                // Free-text baseline answers are graded server-side; pop the
                // header badge with that subtotal on success. MC XP is already
                // counted instantly via `onCorrectAnswer`, so the subtotal
                // deliberately excludes it (no double-count).
                onSuccess: (result) => courseXp.addXp(result.freeTextXpAwarded),
              });
            }
          }}
        />
      }
    >
      {scroll}
      {optimistic && chatEntries.length === optimistic.entryCountAtSubmit && (
        <MessageBubble message={{ id: "pending", role: "user", content: optimistic.content }} />
      )}
      {isPending && <TypingBubble />}
      {/* Inline Retry affordance (issue #16): when a scoping step fails, sit a
          persistent row where the next assistant bubble would appear so the
          learner can re-dispatch the failed step. The toast still announces the
          error; this row is the durable recovery path. Rendered only when idle
          (a fresh attempt sets isPending, showing the TypingBubble instead). */}
      {failedStep && !isPending && (
        <div className="w-full animate-message-in">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="h-1 w-1 rounded-full" style={{ background: "var(--wave-red)" }} />
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fuji-gray">
              {t<string>("app.name")}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[15px] leading-relaxed text-foreground/90">
              {t<string>("retry.message")}
            </span>
            <button
              onClick={failedStep.retry}
              className="inline-flex items-center justify-center rounded-full bg-wave-blue-2 text-foreground px-3.5 py-1.5 text-[13px] font-medium transition active:scale-[0.99] hover:brightness-110"
            >
              {t<string>("retry.action")}
            </button>
          </div>
        </div>
      )}
    </ChatShell>
  );
}
