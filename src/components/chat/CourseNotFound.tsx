"use client";

import { useRouter } from "next/navigation";
import { ChatShell } from "./ChatShell";
import { Composer } from "./Composer";
import { MessageBubble } from "./MessageBubble";
import { t } from "@/i18n";

/** Composer handler for the input row the move-on CTA replaces; it never fires. */
const noop = () => {};

/**
 * The chat shown when `getState` finds no course for this learner: a wrong URL,
 * or a course another browser started. A Nalu message says so, and the move-on
 * slot offers a fresh start at `/`. Onboarding and WaveSession both render it.
 */
export function CourseNotFound() {
  const router = useRouter();
  const startNewCourse = () => router.push("/");
  return (
    <ChatShell
      onNew={startNewCourse}
      composer={
        // `moveOn` replaces the Composer's input row, so its text handlers stay unused.
        <Composer
          value=""
          onChange={noop}
          onSend={noop}
          moveOn={{ label: t<string>("courseNotFound.action"), onAdvance: startNewCourse }}
        />
      }
    >
      <MessageBubble
        message={{
          id: "not-found",
          role: "assistant",
          content: t<string>("courseNotFound.message"),
        }}
      />
    </ChatShell>
  );
}
