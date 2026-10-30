import { MessageBubble, type ChatMessage } from "./MessageBubble";
import { FrameworkTierList } from "./FrameworkTierList";
import type { ChatEntry } from "@/lib/types/chatEntry";

/**
 * Render one ChatEntry as scroll JSX, keyed by its index. Onboarding and
 * WaveSession share it. Exhaustive over ChatEntry's kinds, so a new kind is a
 * compile-time error here.
 *
 * Each flow emits only some kinds; the rest render defensively. Scoping never
 * emits `assistant-text-with-questionnaire`, so a misplaced row falls through
 * to a plain assistant bubble. `deriveWaveChatEntries` never emits
 * `assistant-text-with-framework`. Neither flow renders `move-on-cta` inline:
 * the Composer's `moveOn` prop shows it.
 */
export function renderChatEntry(entry: ChatEntry, idx: number) {
  switch (entry.kind) {
    case "user-text":
    case "user-questionnaire-answers": {
      const msg: ChatMessage = { id: `t${idx}`, role: "user", content: entry.content };
      return <MessageBubble key={idx} message={msg} />;
    }
    case "assistant-text":
    case "assistant-text-with-questionnaire": {
      // The questionnaire itself is rendered via the Composer; the prose
      // body of this entry still renders inline as an assistant bubble.
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
      // The Composer's moveOn prop renders the CTA. Returning null keeps the
      // switch exhaustive.
      return null;
  }
}
