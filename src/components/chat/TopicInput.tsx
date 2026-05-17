"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc";
import { ChatShell } from "./ChatShell";
import { Composer } from "./Composer";
import { EmptyState } from "./EmptyState";

/**
 * Empty home screen: greeting + suggestions + free-text Composer.
 * Submitting the topic calls `course.clarify` and routes to `/course/{id}`.
 */
export function TopicInput() {
  const router = useRouter();
  const trpc = useTRPC();
  const [value, setValue] = useState("");

  const clarify = useMutation(
    trpc.course.clarify.mutationOptions({
      onSuccess: (result) => {
        router.push(`/course/${result.courseId}`);
      },
      // Surface failures (env misconfig, server errors, validation) so the
      // submit doesn't silently swallow them and leave the user staring at
      // an empty input.
      onError: (err) => {
        toast.error("Couldn't start your course", { description: err.message });
      },
    }),
  );

  const send = (text?: string) => {
    // Guard against double-fire from repeated suggestion clicks or rapid Enter
    // — otherwise we'd create two courses and race the resulting redirects.
    if (clarify.isPending) return;
    const content = (text ?? value).trim();
    if (!content) return;
    setValue("");
    clarify.mutate({ topic: content });
  };

  return (
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
      <EmptyState onPick={(topic) => send(topic)} />
    </ChatShell>
  );
}
