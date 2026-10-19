"use client";

import { useRouter } from "next/navigation";
import { ChatShell } from "./ChatShell";
import { Composer } from "./Composer";
import { MessageBubble } from "./MessageBubble";
import { t } from "@/i18n";

/** Composer handler for the input row the move-on CTA replaces; it never fires. */
const noop = () => {};

/**
 * The chat shown when `getState` finds nothing for this learner: a wrong URL,
 * or a course another browser started. `message` is Nalu's line, and the
 * move-on slot offers a fresh start at `/`. Onboarding passes the course copy.
 * WaveSession passes the lesson copy, because its NOT_FOUND also covers a Wave
 * number the learner's own course lacks (issue #230).
 */
export function CourseNotFound({ message }: { readonly message: string }) {
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
      <MessageBubble message={{ id: "not-found", role: "assistant", content: message }} />
    </ChatShell>
  );
}
