import type { ContextMessage } from "@/db/schema";
import type { SeedInputs } from "@/lib/types/context";
import { renderTeachingSystem } from "@/lib/prompts/teaching";
import { renderScopingSystem } from "@/lib/prompts/scoping";

/**
 * Pure renderer that turns structured seed inputs + an ordered list of
 * `context_messages` rows into the LLM API payload (spec §9.1).
 *
 * Determinism: same inputs → byte-identical output across calls.
 *
 * Cache-prefix invariant: appending a row at the end never changes the
 * rendered prefix for prior rows. Tests assert both invariants.
 *
 * Same-role coalescing — IMPORTANT PRECONDITION: this function concatenates
 * consecutive same-role rows into one LLM message (e.g. a `user_message`
 * row immediately followed by a `harness_turn_counter` row collapses into
 * one user-role API message). This is a deliberate cache-key optimisation
 * for OpenAI-compatible providers; flat over the row list.
 *
 * The cache-prefix invariant only holds when role transitions are stable
 * across appends: an append that introduces a NEW user row immediately
 * after the prior user row will *change* what the prior turn rendered to
 * (the two rows now coalesce). The harness loop guarantees strict
 * user↔assistant alternation per turn, so cross-turn coalescing cannot
 * occur in practice. If a future caller produces non-alternating sequences,
 * either they accept the coalescing (within-turn injection) or they must
 * insert a delimiter row.
 */
export interface LlmRenderedMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
}

export interface RenderedContext {
  readonly system: string;
  readonly messages: readonly LlmRenderedMessage[];
}

export function renderContext(
  seed: SeedInputs,
  messages: readonly ContextMessage[],
): RenderedContext {
  const system = seed.kind === "wave" ? renderTeachingSystem(seed) : renderScopingSystem(seed);

  // Coalesce consecutive same-role rows into one LLM message via a fold,
  // so the result builds immutably (no array mutation in the loop body).
  const out = messages.reduce<readonly LlmRenderedMessage[]>((acc, row) => {
    // Defensive: schema CHECK already excludes 'system'. If somehow seen, skip.
    if (row.role === "system") return acc;
    const last = acc[acc.length - 1];
    if (last && last.role === row.role) {
      return [...acc.slice(0, -1), { role: last.role, content: `${last.content}\n${row.content}` }];
    }
    return [...acc, { role: row.role as LlmRenderedMessage["role"], content: row.content }];
  }, []);

  return { system, messages: out };
}
