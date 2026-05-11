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
 *
 * Per-turn retry filter — IMPORTANT: rows are grouped by `turn_index`
 * before coalescing. Within each group: if any row is `assistant_response`,
 * `failed_assistant_response` + `harness_retry_directive` rows in that
 * group are dropped (they were intermediate retry exhaust; the LLM doesn't
 * need to see them once the turn recovered). Terminal-exhaust groups
 * (no `assistant_response`) keep every row so the model can see the
 * failure context on re-attempt. This filter preserves cache-prefix
 * stability across successful turns: a recovered turn always renders to
 * the same bytes as a non-retry turn would have.
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

  // Per-turn bucketing filter (spec §4.3):
  //   group rows by turn_index; if a group contains assistant_response,
  //   drop failed_assistant_response + harness_retry_directive within
  //   that group. Terminal-exhaust groups keep everything.
  //
  // First-pass: collect the ordered list of turn_indexes as they're first
  // seen. Rows are pre-sorted by (turn_index, seq) at the query layer, so
  // de-duplicated insertion order equals the natural turn order.
  const turnIndexesInOrder: readonly number[] = messages.reduce<readonly number[]>(
    (acc, row) => (acc.includes(row.turnIndex) ? acc : [...acc, row.turnIndex]),
    [],
  );

  // Second-pass: for each turn_index, slice out its rows and apply the
  // per-group filter. Using filter() keeps the fold pure and avoids
  // mutating a Map (which would trip functional/immutable-data).
  const filtered: readonly ContextMessage[] = turnIndexesInOrder.flatMap((turnIndex) => {
    const group = messages.filter((r) => r.turnIndex === turnIndex);
    const hasSuccess = group.some((r) => r.kind === "assistant_response");
    if (!hasSuccess) return group;
    return group.filter(
      (r) => r.kind !== "failed_assistant_response" && r.kind !== "harness_retry_directive",
    );
  });

  // Same-role coalescing fold (unchanged from prior version).
  const out = filtered.reduce<readonly LlmRenderedMessage[]>((acc, row) => {
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
