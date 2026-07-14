# Due-review injection A/B: KEEP "full" (hint mode does not trigger lookups)

Decision record for `docs/superpowers/plans/2026-06-10-agent-loop-scoping.md`
Task 5. Method: `streamWaveTurn.live.test.ts` (paid-tier Cerebras,
gpt-oss-120b), one wave seeded with ONE genuinely due concept ("ownership",
SM-2 review date in the past, `lastQuality 3`) both in the DB and in
`dueConceptsSnapshot`, learner input "teach me one small idea, then quiz me
with one multiple-choice question" (does NOT mention review). Flag flipped in
the working tree between runs.

## Runs (2026-07-11)

| Run | Injection | getDueConcepts called? | Questionnaire concept | dueCovered | Loop steps | Tokens (in/out) |
| --- | --------- | ---------------------- | --------------------- | ---------- | ---------- | --------------- |
| A   | full      | YES (redundant)        | ownership             | true       | 3          | 6039 / 779      |
| B1  | hint      | **NO**                 | ownership             | true\*     | 2          | 4050 / 617      |
| B2  | hint      | **NO**                 | ownership             | true\*     | 2          | 4069 / 681      |

\* CONFOUNDED: "ownership" is also the blueprint's planned concept and a tier
example, so the model covers it without knowing it is due. The coverage
signal that matters — the model PULLING the due list on demand — failed in
2/2 hint runs, despite the hint text explicitly instructing "Call
getDueConcepts for the current list before choosing review material."

## Verdict

**Default stays `"full"`** (`WAVE.dueReviewInjection`, tuning.ts).

- Under "hint", gpt-oss-120b does not spontaneously call getDueConcepts on an
  unprompted teaching turn; in waves where due concepts do NOT overlap the
  blueprint, review awareness would silently vanish.
- Hint mode's win is real but small at MVP scale: ~2k input tokens/turn
  (~0.02¢) and one loop step saved. Not worth the silent coverage risk.
- The lookup tools still pay regardless (plan's prediction): in the Task-4
  live browser turn (2026-07-10, dev deployment) a learner-initiated
  "what should I review?" made the model call BOTH getDueConcepts AND
  getConceptHistory — on-demand pulling works when the conversation calls
  for it; it just doesn't replace the static wave-boundary injection.
- Interesting: under "full" the model ALSO called getDueConcepts (run A),
  re-fetching a list it already had. Harmless (read-only, one paced step)
  but suggests tool availability invites redundant calls; worth watching in
  Phase 5 observability.

Re-test trigger: a stronger model on the same key (llama scoring gains,
Cerebras catalog change) or prompt-side reinforcement of the hint (e.g.
moving the nudge into the per-turn envelope rather than the static system
prompt).
