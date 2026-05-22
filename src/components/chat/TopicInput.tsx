"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc";
import { ChatShell } from "./ChatShell";
import { Composer } from "./Composer";
import { EmptyState } from "./EmptyState";
import { MessageBubble, TypingBubble } from "./MessageBubble";
import { Splash } from "./Splash";

/**
 * Empty home screen: splash intro + greeting + suggestions + free-text
 * Composer. Submitting the topic calls `course.clarify` and routes to
 * `/course/{id}`. While the call is in flight the submitted topic renders
 * optimistically as a chat bubble + typing spinner — there is no course chat
 * to route into yet, so the home screen stands in.
 */
export function TopicInput() {
  const router = useRouter();
  const trpc = useTRPC();
  const [value, setValue] = useState("");
  // Shown on every visit to the home screen (TopicInput remounts on each "/").
  const [showSplash, setShowSplash] = useState(true);
  // The submitted topic — drives the optimistic view until the route changes.
  const [submittedTopic, setSubmittedTopic] = useState<string | null>(null);

  const clarify = useMutation(
    trpc.course.clarify.mutationOptions({
      onSuccess: (result) => {
        router.push(`/course/${result.courseId}`);
      },
      onError: (err) => {
        toast.error("Couldn't start your course", { description: err.message });
        // Submission failed — drop the optimistic view so the learner can retry.
        setSubmittedTopic(null);
      },
    }),
  );

  const send = (text?: string) => {
    // Guard against double-fire from repeated suggestion clicks or rapid Enter.
    if (clarify.isPending) return;
    const content = (text ?? value).trim();
    if (!content) return;
    setValue("");
    setSubmittedTopic(content);
    clarify.mutate({ topic: content });
  };

  return (
    <>
      {showSplash && <Splash onStart={() => setShowSplash(false)} />}
      <ChatShell
        onNew={() => {
          setValue("");
        }}
        composer={
          <Composer
            value={value}
            onChange={setValue}
            onSend={() => send()}
            disabled={clarify.isPending}
            isFirstMessage
          />
        }
      >
        {submittedTopic ? (
          <>
            <MessageBubble message={{ id: "pending", role: "user", content: submittedTopic }} />
            <TypingBubble />
          </>
        ) : (
          <EmptyState onPick={(topic) => send(topic)} />
        )}
      </ChatShell>
    </>
  );
}
