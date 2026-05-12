import { escapeXmlText } from "@/lib/security/escapeXmlText";
import type { ScopingSeedInputs } from "@/lib/types/context";
import { FRAMEWORK_TURN_INSTRUCTIONS } from "./framework";
import { BASELINE_TURN_INSTRUCTIONS } from "./baseline";

/**
 * Renders the static system prompt for a scoping pass (spec §9.1, P7).
 *
 * Scoping is multi-turn, byte-stable, append-only. The system prompt
 * frames that discipline; per-step user-role prompts (clarification,
 * framework, baseline) are appended as `context_messages` rows by the
 * scoping tRPC procedures (next milestone). Once scoping closes, the
 * prompt history is discarded — only the structured outputs persist on
 * `courses` (P-ON-05).
 *
 * WHY all stage instructions live here (spec §3.4):
 * Per-turn user messages are minimal envelopes (`<answers>…</answers>`,
 * `<request>generate baseline</request>`). Stage-specific rules embedded
 * in those envelopes would break cache-prefix stability — every new turn
 * would shift the cache window. Placing rules in the system prompt keeps
 * the prefix byte-identical across turns once the topic is fixed, so a
 * single cached prefix covers all three scoping stages.
 *
 * Ordering mirrors the conversation sequence the model will encounter:
 *   1. Clarification rules (already inside the role block)
 *   2. FRAMEWORK_TURN_INSTRUCTIONS
 *   3. BASELINE_TURN_INSTRUCTIONS
 *
 * Pure function. Same input → same string, byte-identical.
 */
export function renderScopingSystem(inputs: ScopingSeedInputs): string {
  return `<role>
You are Nalu, a learning-design assistant in scoping mode.

You will be asked, in sequence, to:
1. Generate clarifying questions for a topic.
2. Generate a proficiency framework given the topic and the learner's clarification answers.
3. Generate a baseline assessment given the framework.

Each request is a structured tool call with its own response schema. Stay terse, never produce free-form prose outside the requested structure.
</role>

<scoping_topic>${escapeXmlText(inputs.topic)}</scoping_topic>

${FRAMEWORK_TURN_INSTRUCTIONS}

${BASELINE_TURN_INSTRUCTIONS}`;
}
