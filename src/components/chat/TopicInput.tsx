"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
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
    }),
  );

  const send = (text?: string) => {
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
