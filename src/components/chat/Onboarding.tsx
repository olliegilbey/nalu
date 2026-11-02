"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useScopingState } from "@/hooks/useScopingState";
import { useXpBadge } from "@/hooks/useXpBadge";
import { holdsTypedAnswer } from "@/lib/course/deriveXpTick";
import { shapeQuestionnaireAnswers } from "@/lib/course/shapeQuestionnaireAnswers";
import { shapeClarifyAnswers } from "@/lib/course/shapeClarifyAnswers";
import { ChatShell } from "./ChatShell";
import { Composer } from "./Composer";
import { CourseNotFound } from "./CourseNotFound";
import { MessageBubble, TypingBubble } from "./MessageBubble";
import { RetryRow } from "./RetryRow";
import { renderChatEntry } from "./renderChatEntry";
import { formatComposerAnswers } from "@/lib/course/formatComposerAnswers";
import { t, tFill } from "@/i18n";

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
    totalXp,
    isPending,
    failedTurn,
    courseNotFound,
    submitClarify,
    submitBaselineAnswers,
  } = useScopingState(courseId);
  // The header badge shows the server's course total from getState. The
  // scoping close's refetch carries the baseline XP, so the badge ticks then.
  const badge = useXpBadge(totalXp);

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

  // getState found no course for this learner: a wrong URL, or a course
  // another browser started. Say so, rather than show an empty chat.
  if (courseNotFound) return <CourseNotFound message={t<string>("courseNotFound.message")} />;

  // Map ChatEntry[] → bubbles, with FrameworkTierList for the framework entry.
  const scroll = chatEntries.map((entry, idx) => renderChatEntry(entry, idx));

  // Compute composer mode.
  const moveOn = scopingResult
    ? {
        label: tFill("moveOn.toWave", { n: 1 }),
        onAdvance: () => router.push(`/course/${courseId}/wave/1`),
      }
    : undefined;

  // The question card the Composer shows, or null once it is submitted.
  const cardQuestions =
    activeQuestionnaire && activeQuestionnaire.questionsKey !== dismissedKey
      ? [...activeQuestionnaire.questions]
      : null;

  return (
    <ChatShell
      title={topic}
      onNew={() => router.push("/")}
      xp={badge.xp}
      xpPulseKey={badge.pulseKey}
      xpGainAmount={badge.gainAmount}
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
          questions={cardQuestions}
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
              const shaped = shapeQuestionnaireAnswers(answers);
              // One sound per answer. The close returns no per-answer
              // grading, so a typed answer sounds on the close's tick. An
              // all-MC card ticks silently: each pick sounded at confirm.
              badge.soundOnNextRise(holdsTypedAnswer(shaped));
              submitBaselineAnswers(shaped, { onError });
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
      {/* When a scoping Turn fails, the toast announces it and fades. This row
          stays, so the learner can re-send the failed Turn. While the failed
          Turn's question card is restored, the card's own submit is the retry,
          so the row hides: one affordance, and edited answers are what gets
          sent. The guard and `disabled` block a second send while one is in
          flight, matching TopicInput. */}
      {failedTurn && !cardQuestions && (
        <RetryRow
          disabled={isPending}
          onRetry={() => {
            if (isPending) return;
            failedTurn.retry();
          }}
        />
      )}
    </ChatShell>
  );
}
