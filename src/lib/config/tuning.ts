import type { QualityScore } from "@/lib/types/spaced-repetition";

/**
 * Single source of truth for every algorithm tunable in Nalu.
 *
 * If you want to adjust learning difficulty, XP rewards, spaced repetition
 * aggressiveness, or tier advancement strictness — this is the only file
 * you edit. Nothing else in the codebase should hardcode these values.
 *
 * Each export documents the source of its defaults so tweaks can be made
 * with full context.
 */

/**
 * SM-2 spaced repetition parameters.
 *
 * Source: SuperMemo SM-2 (Woźniak 1987). The EF adjustment formula is
 *   EF' = EF + (efDelta.a - (5 - q) * (efDelta.b + (5 - q) * efDelta.c))
 * clamped below at `easinessFactorFloor`.
 *
 * Intervals (in days) grow per the three-stage schedule:
 *   rep 0 → firstSuccessInterval
 *   rep 1 → secondSuccessInterval
 *   rep 2+ → round(previousInterval × oldEF)
 *
 * On failure the repetition count resets to 0 and the interval collapses
 * to `failureInterval`.
 *
 * The `concepts` schema reads `initialEasinessFactor` (column default) and
 * `easinessFactorFloor` (CHECK bound). Retuning either changes the schema:
 * run `just db-generate <name>` and commit the migration.
 * `src/db/schemaMigrationDrift.test.ts` fails until you do.
 */
export const SM2 = {
  // SM-2 canonical default EF (Woźniak 1987). Starting memory stability
  // for a never-reviewed card. The DB applies it as the column default.
  initialEasinessFactor: 2.5,
  // SM-2 canonical EF floor. Prevents EF collapse under repeated failure,
  // which would otherwise lock a concept into daily reviews forever.
  // `sm2.ts` clamps to it, and the DB CHECK enforces the same bound.
  easinessFactorFloor: 1.3,
  // Stage-1 interval after first success: reinforce the next day.
  firstSuccessInterval: 1,
  // Stage-2 interval after second success. SM-2 canonical jump to a week.
  secondSuccessInterval: 6,
  // On failure the schedule collapses to tomorrow. Retention-focused; also
  // anti-gaming — a learner can't "skip" a card by bombing it once.
  failureInterval: 1,
  // Coefficients in the SM-2 EF-adjustment formula. Changing these tunes
  // how aggressively EF reacts to quality. Source: SM-2 spec.
  efDelta: { a: 0.1, b: 0.08, c: 0.02 },
} as const;

/**
 * XP reward configuration. Deterministic and hidden from the LLM — this is
 * the anti-gaming boundary. XP = round(tier × basePerTier × qualityMultiplier).
 *
 * Quality multipliers reward depth of understanding, not just correctness.
 * The 0-for-q1 rule punishes confident wrong answers more than silence.
 */
export const XP = {
  // PRD baseline. XP per tier is linear (tier × basePerTier) so progression
  // rewards stay predictable and auditable by the learner.
  basePerTier: 10,
  // Multiplier table per quality score. Q1 floors XP to 0 to deny rewards
  // for confident wrong answers (anti-gaming). Q5 pays 1.5x to reward
  // teach-level understanding without being so generous it distorts
  // progression velocity.
  qualityMultipliers: {
    0: 0, // no engagement / nonsensical — no reward
    1: 0, // wrong with clear misunderstanding — no reward (anti-gaming)
    2: 0.25, // partial understanding — token reward
    3: 0.75, // correct but uncertain — standard reward (minimum pass)
    4: 1, // correct and clear — full reward
    5: 1.5, // could teach it — bonus, but bounded
  },
  // MC correct = equivalent to free-text q=4 (correct and clear). Q=5 stays
  // reserved for free-text answers where the learner can demonstrate teach-
  // level depth that a click cannot. Wrong MC clicks still pay 0 via the
  // q=1 multiplier (BASELINE.mcIncorrectQuality = 1); this multiplier only
  // applies to the `correct === true` branch in `calculateMcXp`.
  mcCorrectMultiplier: 1,
} as const satisfies {
  readonly basePerTier: number;
  readonly qualityMultipliers: Readonly<Record<QualityScore, number>>;
  readonly mcCorrectMultiplier: number;
};

/**
 * Tier advancement rules. Both conditions must be satisfied to unlock the
 * next tier. The minimum concept count is an anti-gaming measure — it
 * prevents a learner (or a broken LLM) from rushing through a tier with
 * only one or two easy concepts.
 */
export const PROGRESSION = {
  // Q>=3 is the "passing" boundary (see qualityScoreSchema docs). Concepts
  // at 2 or below count as unmastered for tier advancement purposes.
  passingQualityScore: 3,
  // Anti-gaming: a learner cannot advance a tier on 1-2 lucky concepts.
  // Forces breadth before progression.
  minimumConceptsPerTier: 5,
  // 80% mastery required. Balances "don't advance half-cooked" against
  // "don't trap learners on one stubborn concept." PRD-tunable.
  passingRatio: 0.8,
} as const;

/**
 * Scoping flow tunables: bounds for input validation and the retry policy on
 * the clarify → framework → baseline pipeline.
 *
 * `maxParseRetries` is *retries* after the first attempt — total = retries + 1.
 * Low by design: with well-authored ValidationGateFailure messages, recovery
 * lands on attempt 2 or fails fast. `maxTopicLength` caps pathological pastes
 * that would blow out the cache-key system prefix. `maxClarifyAnswers` must
 * match the questionnaire upper bound in `src/lib/prompts/questionnaire.ts`.
 */
export const SCOPING = {
  maxParseRetries: 2,
  maxTopicLength: 500,
  // Lower bound for the clarify questionnaire (P-ON-01).
  minClarifyAnswers: 2,
  maxClarifyAnswers: 4,
} as const;

/**
 * Learner profile tunables.
 *
 * `maxCustomInstructionsLength` caps the learner's custom instructions, counted
 * after trim. 1,000 characters leaves room for several preferences at about
 * 250 tokens. The text rides once in each Wave's system prompt and stays
 * cached across that Wave's Turns, so the cost is paid once per Wave.
 * `SCOPING.maxTopicLength` (500) is the prior art. The settings sheet's text
 * area reads the same cap, so the client and server never disagree.
 */
export const PROFILE = {
  maxCustomInstructionsLength: 1000,
} as const;

/**
 * Proficiency-framework generation bounds. Consumed by
 * `src/lib/prompts/framework.ts` (prompt instructions + Zod schema) so the
 * two never drift. Tier counts are PRD-sourced.
 */
export const FRAMEWORK = {
  // PRD §2.1: "3-8 tiers generated per topic (flexible by breadth)".
  minTiers: 3,
  maxTiers: 8,
  // PRD §4.1: each tier carries example concepts; baseline generation
  // (next flow) uses these to spread 7–9 questions across tiers. 4–7
  // gives baseline enough seeds without bloating the stored framework.
  minExampleConceptsPerTier: 4,
  maxExampleConceptsPerTier: 7,
  // P-ON-02: baseline scope is narrow, not broad. Framework generation
  // emits `[estimate-1, estimate, estimate+1]` clamped to the produced
  // tier range, so the natural upper bound is 3. The schema enforces it
  // so an over-eager model cannot widen scope to the whole framework.
  maxBaselineScopeSize: 3,
} as const;

/**
 * Baseline-assessment bounds. Consumed by `src/lib/prompts/baseline.ts`
 * (generation), `src/lib/course/submitBaseline.ts` (mechanical MC
 * scoring + batch grading via the close turn), and
 * `src/lib/scoring/startingTier.ts` (placement). Keeping
 * the numbers in one place means prompt text, Zod schemas, and grading
 * code can't drift.
 *
 * Question counts follow PRD §4.1: 7–9 baseline questions total. The
 * per-tier count derives from the scope size in `baseline.ts`:
 * max(questionsPerTier, ceil(minQuestions / |scope|)), so 1 tier → 7,
 * 2 → 4 each (8), 3 → 3 each (9). A 1- or 2-tier scope is legitimate
 * (a learner placed at the first or last tier), and a flat 3 per tier
 * gave 6 there, below the floor (issue #129). Every scope size from 1 to
 * `FRAMEWORK.maxBaselineScopeSize` must total within [minQuestions,
 * maxQuestions]; `baseline.test.ts` checks each one.
 *
 * Mechanical MC quality scores (q=4 correct, q=1 incorrect) encode what
 * a correct click tells us and what a wrong click tells us — a correct
 * MC is "correct and clear" but not the teach-level q=5 a free-text
 * answer can earn; an incorrect MC is "wrong with clear misunderstanding"
 * (q=1) rather than q=0 non-engagement, because clicking is engagement.
 * The XP multiplier table in `XP.qualityMultipliers` floors q=1 to 0,
 * so wrong MC clicks still earn nothing — anti-gaming holds.
 */
export const BASELINE = {
  // PRD §4.1: "baseline assessment — 7-9 questions". Floor/ceiling enforced
  // by the Zod schema. The rendered rule asks for an exact total inside them.
  minQuestions: 7,
  maxQuestions: 9,
  // Three probes per in-scope tier give enough signal to detect friction
  // without fatiguing the learner before teaching even begins. This is the
  // per-tier minimum; small scopes ask more per tier to reach minQuestions.
  questionsPerTier: 3,
  // Mechanical MC scoring. A correct click maps to q=4 ("correct
  // and clear") — reserve q=5 for free-text answers where the learner has
  // room to demonstrate teach-level depth. An incorrect click maps to q=1
  // ("wrong with clear misunderstanding"): clicking is engagement, so not
  // q=0, but the XP multiplier table still floors q=1 rewards to zero.
  // Mid-Wave MC grading (`applyAssessmentGrading`) reads these too.
  mcCorrectQuality: 4,
  mcIncorrectQuality: 1,
  // Starting-tier placement (`determineStartingTier`, issue #94). A tier
  // counts as mastered when at least this share of its baseline answers
  // are correct (quality 4-5). Wave 1 starts at the first in-scope tier
  // not mastered. Only the 0.8 ratio matches `PROGRESSION.passingRatio`;
  // the evidence rules differ. Advancement passes a concept at quality 3+
  // and needs `minimumConceptsPerTier` concepts. Placement counts only
  // quality 4-5 and has no minimum count.
  // With 3-4 questions per tier, one wrong answer keeps the learner on
  // that tier. That is deliberate: starting a little too easy costs a few
  // brisk turns, while starting too hard loses the learner. A strict bar
  // also stops lucky MC guesses (1 in 4 each) from skipping a tier.
  tierMasteryRatio: 0.8,
} as const;

/**
 * Rules shared by every graded questionnaire: the baseline and Wave quizzes.
 *
 * - `rubricMinChars`: floor for a graded free-text rubric (issue #22). A
 *   rubric states what a correct answer contains; under ~four words it
 *   cannot, so "n/a"-style stubs fail. `isPlaceholderRubric`
 *   (`src/lib/prompts/questionnaire.ts`) applies it, and both stages'
 *   wire descriptions render it so the model meets it first time.
 */
export const QUESTIONNAIRE = {
  rubricMinChars: 20,
} as const;

/**
 * LLM transport defaults. Applied in `src/lib/llm/generate.ts` to every
 * structured and chat call unless an explicit override is passed.
 * `defaultTemperature` favours consistency over creativity; raise per-flow
 * only where variety aids learning. `maxRetries` bounds transient-failure
 * retries — the AI SDK handles JSON-parse repair internally and applies
 * exponential backoff between attempts (≈2s, 4s, 8s, 16s, 32s, 64s).
 *
 * `maxRetries: 6`: sized to absorb a Cerebras free-tier 5-RPM rate-limit
 * stall during smoke runs (4 scoping calls × 3 topics + 11 wave calls,
 * paced ~13s apart by the rate limiter — roughly 5 min of quasi-serial
 * traffic). With 6 attempts the total backoff window is ~2 minutes — long
 * enough for the 5-RPM bucket to refill several slots, short enough to fail
 * fast on a genuine outage. Production traffic is bursty but single-user;
 * this ceiling is for the smoke suite.
 *
 * `slowLaneSpacingMs: 13000`: minimum gap (dispatch-to-dispatch) between
 * consecutive Cerebras API calls AFTER a user has consumed their fast-lane
 * window, enforced at the `generateChat` call site by
 * `src/lib/llm/cerebrasRateLimit.ts`. The Cerebras FREE tier caps at
 * 5 requests/min — a 12.0s exact floor (60s ÷ 5). 13s adds ~1s margin so a
 * strict server-side sliding window can't trip on clock skew or
 * response-time variance. We're on the paid tier now, but the slow-lane
 * value is sized for the free-tier floor — it's the deterrent that kicks
 * in after `fastLaneCallsPerUser` calls, not a budget mechanism.
 *
 * `fastLaneSpacingMs: 200`: spacing applied while a user is still inside
 * their fast-lane window. Paid tier supports 1000 RPM (60ms floor); 200ms
 * is a conservative cushion that absorbs `executeTurn` retry bursts
 * without measurable user-visible latency (200ms × 6 worst-case retries
 * ≈ 1.2s, vs 78s at the slow-lane floor).
 *
 * `fastLaneCallsPerUser: 45`: per-user count of fast-lane calls before
 * the slow-lane floor kicks in. Raised 30 → 45 when mid-turns gained
 * lookup tools (agent-loop Task 4, cost gate:
 * docs/status/2026-07-08-agent-loop-cost-gate.md): each lookup adds one
 * full loop step, so a 10-turn Wave at 3 calls/turn hit 30 exactly at
 * wave end — any retry or 4-step turn tipped mid-wave turns onto the 13s
 * cliff. The paid-tier key allows 1000 RPM with no daily token cap, and
 * 200ms spacing already caps a process at ≤300 calls/min — the raise
 * changes pacing, not spend (+~10-15 calls/wave at ~0.01¢ each). Counter
 * is in-memory (module-level Map keyed by userId); resets on lambda cold
 * start, which is generous to the user and does not affect wallet
 * exposure (~$0.10/session regardless).
 *
 * `lowTokenBudgetThreshold: 10000`: if a prior response's
 * `x-ratelimit-remaining-tokens-minute` header drops below this, the limiter
 * waits for the per-minute token bucket to reset before the next call. The
 * Cerebras free tier allows 30,000 tokens/min; a single large teaching turn
 * (full Wave context + a verbose structured reply) can consume several
 * thousand tokens. 10000 leaves comfortable headroom for one such turn
 * without tripping a mid-turn 429. The same Cerebras API key is shared with
 * another workload, so the remaining-tokens header reports the
 * account-wide budget — this backoff absorbs that contention automatically.
 *
 * `maxToolSteps: 4`: tool-loop step ceiling (`streamText` `stopWhen`) for
 * tool-calling turns. 4 = grade + quiz + closing prose + one in-loop
 * self-correction; the reliability probe's median loop depth was 2
 * (docs/status/2026-07-06-tool-call-probe-verdict.md). Every step is one
 * rate-limiter-paced Cerebras call, so raising this raises worst-case
 * turn latency (~+13s per extra step on the slow lane).
 *
 * `maxToolStepOutputTokens: 16384`: output ceiling for ONE tool-loop Step,
 * sent as `max_tokens`. Cerebras counts reasoning tokens against it. It
 * bounds a runaway: a `presentQuestionnaire` call once ran to ~40k tokens
 * (issue #181). Sized from 238 Steps in seven local `just smoke` logs
 * (2026-10-13/14). Wave tool-loop Steps peaked at 4,751 output tokens (p99
 * 4,215). The longest high-effort reasoning in any stage was 10,796 tokens,
 * in a baseline call. 16,384 holds that reasoning plus the largest tool call
 * and prose seen in a Step (1,557) with a third to spare. That is 3.4× the
 * longest Wave Step. A Step that hits the cap fails its attempt, and the
 * attempt retries (`executeToolTurnStream`), so a false cut costs one retry.
 * Structured calls (`generateChat`) carry no cap. Their Steps run longer
 * (11,720 max), and a cut inside reasoning leaves no text: the SDK then
 * throws `NoOutputGeneratedError`, and the Turn fails with no retry.
 */
export const LLM = {
  defaultTemperature: 0.3,
  // Reasoning depth for gpt-oss-120b ("low" | "medium" | "high"). Cerebras
  // defaults to "medium" when unset; we pin "high" after the 2026-07-18
  // Japanese-course transcript showed medium-effort failures: baseline took
  // 3 attempts (question-count miss, then tier-scope violation, then a
  // relabel-not-rethink "fix"), and questions ignored the learner's stated
  // can't-read-characters profile. Each schema retry is a full extra LLM
  // call, so high effort is partly self-funding. Sent via providerOptions
  // by `llmProviderOptions(promptCacheKey)` (src/lib/llm/provider.ts).
  reasoningEffort: "high",
  maxRetries: 6,
  slowLaneSpacingMs: 13_000,
  fastLaneSpacingMs: 200,
  fastLaneCallsPerUser: 45,
  lowTokenBudgetThreshold: 10_000,
  maxToolSteps: 4,
  maxToolStepOutputTokens: 16_384,
} as const;

/**
 * Cerebras token pricing, in USD per MILLION tokens. Consumed only by
 * `src/lib/llm/usageCost.ts` to turn the provider-reported `usage` object
 * into a per-run "≈ $X" readout. Never influences scoring, XP, or the LLM
 * (it never sees cost) — it is a pure observability tunable.
 *
 * Rates are for `gpt-oss-120b`, the default `LLM_MODEL`. Change the model,
 * change these. Nalu runs on the Cerebras paid tier (since 2026-07-16).
 *
 * Source: Cerebras model docs, "$0.35 / M tokens" input and
 * "$0.75 / M tokens" output, https://inference-docs.cerebras.ai/models/openai-oss
 * (checked 2026-10-12).
 *
 * ⚠️ Caching is NOT a discount on Cerebras: cached input tokens bill at the
 * FULL input rate. Source: "billed at the standard input token rate",
 * https://inference-docs.cerebras.ai/capabilities/prompt-caching
 * (checked 2026-10-12). `usage.cachedInputTokens` /
 * `inputTokenDetails.cacheReadTokens` are surfaced for DISPLAY only and MUST
 * NOT reduce the computed cost — see the explicit cached-not-discounted test
 * in `src/lib/llm/usageCost.test.ts`.
 *
 * Reasoning tokens bill as OUTPUT. The AI SDK already folds reasoning into
 * `usage.outputTokens` (`outputTokenDetails.reasoningTokens` is a subset),
 * so charging `outputTokens × outputRate` captures reasoning automatically.
 */
export const CEREBRAS_PRICING = {
  inputUsdPerMillionTokens: 0.35,
  outputUsdPerMillionTokens: 0.75,
} as const;

/**
 * Agent lookup-tool caps (agent-loop plan Task 3): every lookup returns a
 * bounded projection so a tool result can never blow the rendered context.
 * - `dueConceptsLimit`: max concepts per getDueConcepts call (soonest
 *   first). Only `"hint"` due-review mode offers that tool (`WAVE`).
 * - `historyAttemptsLimit`: max attempts per getConceptHistory call
 *   (most recent first).
 */
export const AGENT_LOOKUP = {
  dueConceptsLimit: 10,
  historyAttemptsLimit: 5,
} as const;

/**
 * Wave-loop tunables.
 * - `turnCount`: fixed length of every teaching Wave (mid-turns 1…turnCount-1,
 *   close turn at turnsRemaining===0).
 * - `tierCheckInterval`: gates the close-turn tier-advancement check; smaller
 *   = more frequent advancement checks. MVP value 2 keeps integration tests
 *   fast.
 *   TODO(pre-launch): raise to ~5 once tier-progression UX is validated.
 * - `completionXp`: flat bonus on Wave close. Motivates finishing a Wave
 *   without inflating per-question XP scaling — sized at roughly a tier-5
 *   medium-quality free-text answer, so the per-Wave commitment payoff is
 *   visible without dwarfing in-Wave grading.
 * - `dueReviewInjection` (agent-loop plan Task 5): how the Wave system
 *   prompt surfaces due concepts. `"full"` injects the whole
 *   `<due_for_review>` list, and the mid-turn agent gets no getDueConcepts
 *   tool: the call would only repeat the list (audit F4).
 *   `"hint"` replaces it with a one-line nudge to call getDueConcepts,
 *   which shrinks the static prompt. Default stays
 *   "full": the 2026-07-11 live A/B (docs/status/) showed the model does
 *   not call the lookup unprompted.
 * - `quizMaxQuestions`: upper bound on one mid-Wave `presentQuestionnaire`
 *   call. A quiz is a quick concept check inside a teaching turn, not a
 *   test; three questions keep it short. The tool's input schema enforces
 *   it, and its descriptions render it as "1-3" (issue #63).
 */
export const WAVE = {
  turnCount: 10,
  tierCheckInterval: 2,
  completionXp: 50,
  dueReviewInjection: "full" as WaveDueReviewInjection,
  quizMaxQuestions: 3,
} as const;

/** Due-review injection mode for the Wave system prompt — see `WAVE` docs. */
export type WaveDueReviewInjection = "full" | "hint";
