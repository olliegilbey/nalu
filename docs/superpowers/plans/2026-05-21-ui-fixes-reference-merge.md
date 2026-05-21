# UI Fixes + kanagawa-whispers Reference Merge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port four UI features from the `../kanagawa-whispers` reference repo (splash screen, questionnaire step-lock, XP badge, course title) and fix two Nalu bugs (no optimistic submit, duplicated "or type your own answer").

**Architecture:** All changes are UI-layer (`src/components/chat/`, `src/hooks/`, `src/i18n/`, `src/app/globals.css`) plus two read-only server-side wire projections (`tier` and `topic`). The XP badge is a client-side, localStorage-backed per-course display counter — MC XP computed exactly via the existing pure `calculateMcXp`, free-text/completion XP taken from server grading. Optimistic submit uses component-local pending-message state.

**Tech Stack:** Next.js 16.2 (App Router, client components), TypeScript strict, tRPC v11 + TanStack Query, Tailwind v4, Vitest 4 (`@testing-library/react`), Zod.

**Source of truth for ports:** the reference repo at `../kanagawa-whispers`, branch `origin/main` (HEAD `6f9de2e` after Task 1). Relevant files: `src/components/chat/Splash.tsx`, `src/components/chat/ChatHeader.tsx`, `src/components/chat/Composer.tsx`, `src/styles.css`.

**Conventions:**

- Commit after every task. Conventional commits; **subject must be lowercase** (commitlint rejects upper-case/sentence-case subjects).
- Never bypass git hooks (`--no-verify` is forbidden). The pre-commit hook auto-formats with Prettier, then runs lint/typecheck/tests on staged TS/JS.
- `bun`, not npm. Targeted test run: `bun run test <path-substring>`. Full unit suite: `just test`. Also: `just lint`, `just typecheck`, `just build`.
- The project has **no chat-component unit tests** — only hooks and pure functions are unit-tested. Component changes (Composer, ChatHeader, ChatShell, Splash, WaveSession, Onboarding, TopicInput) are verified by `just typecheck` + `just lint` + `just build` and the manual checklist in Task 16. A Composer test harness is deliberately not added — it would be a larger new pattern than these changes warrant.

---

## Task 1: Fast-forward the kanagawa-whispers reference repo

The reference repo's working tree is 13 commits behind `origin/main`. Fast-forward it so the ported source matches and future re-syncs diff cleanly. This touches only `../kanagawa-whispers` — no Nalu commit.

**Files:** none in Nalu.

- [ ] **Step 1: Fast-forward the reference repo**

```bash
git -C ../kanagawa-whispers fetch origin
git -C ../kanagawa-whispers merge --ff-only origin/main
```

- [ ] **Step 2: Verify HEAD**

Run: `git -C ../kanagawa-whispers rev-parse --short HEAD`
Expected: `6f9de2e`

If the working tree is not clean and the fast-forward is refused, stop and report — do not force anything.

---

## Task 2: Add CSS animations to globals.css

**Files:**

- Modify: `src/app/globals.css` — append three animations inside the existing `@layer utilities` block.

- [ ] **Step 1: Add the keyframes**

In `src/app/globals.css`, find the end of the `@layer utilities` block — the last rule is `.wave-spin { ... }` followed by the layer's closing `}`. Insert the following **after the `.wave-spin` rule and before the closing `}` of the layer**:

```css
/* Splash overlay fade-in (Nalu has no tw-animate-css). */
@keyframes fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.animate-fade-in {
  animation: fade-in 0.5s ease-out both;
}

/* XP badge pop — bubble scales up, picks up a green glow, then settles. */
@keyframes xp-badge-pop {
  0% {
    transform: scale(1);
    box-shadow: 0 0 0 0 color-mix(in oklab, var(--spring-green) 0%, transparent);
    border-color: var(--sumi-ink-4);
  }
  35% {
    transform: scale(1.22);
    box-shadow:
      0 0 0 6px color-mix(in oklab, var(--spring-green) 35%, transparent),
      0 6px 18px -4px color-mix(in oklab, var(--spring-green) 45%, transparent);
    border-color: var(--spring-green);
  }
  60% {
    transform: scale(0.96);
  }
  80% {
    transform: scale(1.04);
  }
  100% {
    transform: scale(1);
    box-shadow: 0 0 0 0 color-mix(in oklab, var(--spring-green) 0%, transparent);
    border-color: var(--sumi-ink-4);
  }
}
.xp-badge-pop {
  animation: xp-badge-pop 0.9s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

/* "+N XP" floater — rises and fades above the badge. */
@keyframes xp-gain-float {
  0% {
    opacity: 0;
    transform: translate(-50%, 6px) scale(0.85);
  }
  20% {
    opacity: 1;
    transform: translate(-50%, -10px) scale(1.05);
  }
  65% {
    opacity: 1;
    transform: translate(-50%, -22px) scale(1);
  }
  100% {
    opacity: 0;
    transform: translate(-50%, -32px) scale(0.95);
  }
}
.xp-gain-float {
  animation: xp-gain-float 0.85s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
```

- [ ] **Step 2: Verify the build compiles the CSS**

Run: `just build`
Expected: build succeeds with no CSS errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/globals.css
git commit -m "feat(ui): add splash fade-in and XP badge keyframes"
```

---

## Task 3: Project per-question `tier` to the client wire

`v3Question` already carries an optional `tier` field; it just is not projected to the client. Add it to the two client-question types and the adapter so the Composer can compute exact MC XP.

**Files:**

- Modify: `src/lib/course/redactWaveChatLog.ts` — `WaveQuestionForClient` (both variants) + projection.
- Modify: `src/lib/course/redactQuestionnaire.ts` — `OpenQuestionForClient` (both variants).
- Modify: `src/lib/course/adaptQuestionnaire.ts` — `ChoiceQuestion` + `adaptOpenQuestion`.
- Test: `src/lib/course/redactWaveChatLog.test.ts`, `src/lib/course/adaptQuestionnaire.test.ts`.

- [ ] **Step 1: Write the failing tests**

In `src/lib/course/redactWaveChatLog.test.ts`, add this `it` block inside the existing top-level `describe`:

```ts
it("projects the optional per-question tier onto the client question", () => {
  const result = redactWaveChatLog([
    {
      role: "assistant",
      kind: "text_with_questionnaire",
      questionnaireId: "q1",
      content: "Try this:",
      questions: [
        {
          id: "qa",
          type: "multiple_choice",
          prompt: "?",
          options: { A: "1", B: "2", C: "3", D: "4" },
          correct: "A",
          freetextRubric: "n/a",
          tier: 3,
        },
      ],
    },
  ]);
  const entry = result[0];
  if (entry?.role !== "assistant" || entry.kind !== "text_with_questionnaire") {
    throw new Error("expected a text_with_questionnaire entry");
  }
  expect(entry.questions[0]?.tier).toBe(3);
});
```

In `src/lib/course/adaptQuestionnaire.test.ts`, add this `it` block inside the existing top-level `describe` (a malformed `correctEnc` is fine — `decodeCorrect` returns `null` and the test only asserts `tier`):

```ts
it("adaptOpenQuestion carries the optional tier through", () => {
  const adapted = adaptOpenQuestion({
    id: "q1",
    type: "multiple_choice",
    prompt: "?",
    options: { A: "1", B: "2", C: "3", D: "4" },
    correctEnc: "unused",
    freetextRubric: "n/a",
    tier: 2,
  });
  expect(adapted.tier).toBe(2);
});
```

If `adaptOpenQuestion` is not already imported in that test file, add it to the existing import from `./adaptQuestionnaire`.

- [ ] **Step 2: Run the tests — verify they fail**

Run: `bun run test src/lib/course/redactWaveChatLog.test.ts src/lib/course/adaptQuestionnaire.test.ts`
Expected: FAIL — `tier` is `undefined` (not yet projected) / type error on the `tier` literal.

- [ ] **Step 3: Add `tier` to `WaveQuestionForClient` and project it**

In `src/lib/course/redactWaveChatLog.ts`, add `readonly tier?: number;` to **both** variants of `WaveQuestionForClient`:

```ts
export type WaveQuestionForClient =
  | {
      readonly id: string;
      readonly type: "multiple_choice";
      readonly prompt: string;
      readonly options: {
        readonly A: string;
        readonly B: string;
        readonly C: string;
        readonly D: string;
      };
      /** Base64-obfuscated correct index, bound to `id`. NOT cryptographic. */
      readonly correctEnc: string;
      readonly freetextRubric: string;
      /** Concept tier — drives client-side `calculateMcXp`. Optional on the source. */
      readonly tier?: number;
    }
  | {
      readonly id: string;
      readonly type: "free_text";
      readonly prompt: string;
      readonly freetextRubric: string;
      /** Concept tier — present for symmetry; free-text XP is server-graded. */
      readonly tier?: number;
    };
```

In the `redactWaveChatLog` map body, add `tier: q.tier` to **both** returned question objects:

```ts
if (q.type === "multiple_choice") {
  if (q.correct === undefined) {
    throw new Error(`redactWaveChatLog: MC question id=${q.id} missing correct key`);
  }
  return {
    id: q.id,
    type: "multiple_choice",
    prompt: q.prompt,
    options: q.options,
    correctEnc: encodeCorrect(q.id, KEY_TO_INDEX[q.correct]),
    freetextRubric: q.freetextRubric,
    tier: q.tier,
  };
}
return {
  id: q.id,
  type: "free_text",
  prompt: q.prompt,
  freetextRubric: q.freetextRubric,
  tier: q.tier,
};
```

- [ ] **Step 4: Add `tier` to `OpenQuestionForClient`**

In `src/lib/course/redactQuestionnaire.ts`, add `readonly tier?: number;` to **both** variants of `OpenQuestionForClient` (mirror the comments above).

- [ ] **Step 5: Add `tier` to `ChoiceQuestion` and `adaptOpenQuestion`**

In `src/lib/course/adaptQuestionnaire.ts`, add the field to `ChoiceQuestion`:

```ts
export interface ChoiceQuestion {
  readonly id: string;
  readonly prompt: string;
  /** Empty array means free-text-only. */
  readonly options: readonly string[];
  readonly correctIndex?: number;
  /** Concept tier — drives client-side `calculateMcXp` for correct MC answers. */
  readonly tier?: number;
}
```

In `adaptOpenQuestion`, add `tier: q.tier` to **both** returned objects:

```ts
export function adaptOpenQuestion(q: OpenQuestionForClient): ChoiceQuestion {
  if (q.type === "multiple_choice") {
    const decoded = decodeCorrect(q.id, q.correctEnc);
    return {
      id: q.id,
      prompt: q.prompt,
      options: [q.options.A, q.options.B, q.options.C, q.options.D],
      correctIndex: decoded ?? undefined,
      tier: q.tier,
    };
  }
  return { id: q.id, prompt: q.prompt, options: [], tier: q.tier };
}
```

Leave `adaptQuestionnaire` (the scoping adapter) unchanged — scoping questions earn no XP, and its input type does not carry `tier`.

- [ ] **Step 6: Run the tests — verify they pass**

Run: `bun run test src/lib/course/redactWaveChatLog.test.ts src/lib/course/adaptQuestionnaire.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `just typecheck`
Expected: passes.

- [ ] **Step 8: Commit**

```bash
git add src/lib/course/redactWaveChatLog.ts src/lib/course/redactQuestionnaire.ts src/lib/course/adaptQuestionnaire.ts src/lib/course/redactWaveChatLog.test.ts src/lib/course/adaptQuestionnaire.test.ts
git commit -m "feat(course): project per-question tier to the client wire"
```

---

## Task 4: Expose course `topic` on `WaveState`

`WaveState` does not carry the course topic; `getWaveState` already fetches the course row for the ownership check but discards it. Capture it and project `topic`.

**Files:**

- Modify: `src/lib/course/getWaveState.ts` — `WaveState` interface + the ownership check + the return object.

- [ ] **Step 1: Add `topic` to the `WaveState` interface**

In `src/lib/course/getWaveState.ts`, add to the `WaveState` interface (after `courseId`):

```ts
  readonly courseId: string;
  /** Course topic — populates the wave header title. */
  readonly topic: string;
  readonly waveId: string;
```

- [ ] **Step 2: Capture the course row in the ownership check**

Replace the existing ownership-check `try { await getCourseById(...) } catch { ... }` block (step 2 in `getWaveState`) with this — it keeps the same NOT_FOUND translation but retains the course row:

```ts
// (2) Ownership check. `getCourseById` throws `NotFoundError` on a missing
// row OR a userId mismatch (existence is not disclosed across owners). The
// course row is retained — its `topic` populates the wave header title.
const course = await getCourseById(params.courseId, params.userId).catch((err: unknown): never => {
  if (err instanceof NotFoundError) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `wave ${params.waveNumber} not found for course ${params.courseId}`,
    });
  }
  throw err;
});
```

- [ ] **Step 3: Add `topic` to the returned object**

In the `return { ... }` at the end of `getWaveState`, add `topic`:

```ts
return {
  courseId: wave.courseId,
  topic: course.topic,
  waveId: wave.id,
  waveNumber: wave.waveNumber,
  currentTier: wave.tier,
  status: wireStatus,
  turnsRemaining,
  chatLog,
  closeResult: null,
};
```

- [ ] **Step 4: Typecheck**

Run: `just typecheck`
Expected: passes. (`getWaveState` has no unit test — it is DB-coupled; `wave.getState`'s tRPC output type is inferred from this return.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/course/getWaveState.ts
git commit -m "feat(course): expose course topic on wave state"
```

---

## Task 5: `useCourseXp` hook

A localStorage-backed, per-course XP display counter for the header badge.

**Files:**

- Create: `src/hooks/useCourseXp.ts`
- Test: `src/hooks/useCourseXp.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/hooks/useCourseXp.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCourseXp } from "./useCourseXp";

beforeEach(() => {
  window.localStorage.clear();
});

describe("useCourseXp", () => {
  it("starts at zero for a fresh course", () => {
    const { result } = renderHook(() => useCourseXp("c1"));
    expect(result.current.xp).toBe(0);
    expect(result.current.pulseKey).toBe(0);
  });

  it("accumulates XP and bumps the pulse key on addXp", () => {
    const { result } = renderHook(() => useCourseXp("c1"));
    act(() => result.current.addXp(10));
    expect(result.current.xp).toBe(10);
    expect(result.current.gainAmount).toBe(10);
    expect(result.current.pulseKey).toBe(1);
    act(() => result.current.addXp(20));
    expect(result.current.xp).toBe(30);
    expect(result.current.gainAmount).toBe(20);
    expect(result.current.pulseKey).toBe(2);
  });

  it("ignores non-positive amounts", () => {
    const { result } = renderHook(() => useCourseXp("c1"));
    act(() => result.current.addXp(0));
    act(() => result.current.addXp(-5));
    expect(result.current.xp).toBe(0);
    expect(result.current.pulseKey).toBe(0);
  });

  it("persists the total to localStorage and rehydrates it", () => {
    const first = renderHook(() => useCourseXp("c1"));
    act(() => first.result.current.addXp(40));
    expect(window.localStorage.getItem("nalu:course:c1:xp")).toBe("40");
    const second = renderHook(() => useCourseXp("c1"));
    expect(second.result.current.xp).toBe(40);
  });

  it("scopes the counter per courseId", () => {
    const { result } = renderHook(() => useCourseXp("c1"));
    act(() => result.current.addXp(15));
    const other = renderHook(() => useCourseXp("c2"));
    expect(other.result.current.xp).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `bun run test src/hooks/useCourseXp.test.ts`
Expected: FAIL — `Cannot find module './useCourseXp'`.

- [ ] **Step 3: Implement the hook**

Create `src/hooks/useCourseXp.ts`:

```ts
"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Per-course XP counter, backed by localStorage.
 *
 * Nalu's authoritative XP lives server-side; this hook is a *display* counter
 * for the header badge. It accumulates XP gained during the session — exact
 * `calculateMcXp` amounts for correct MC answers (client-side) plus
 * server-graded free-text / wave-completion XP — and persists the running
 * total per course so it survives wave-to-wave navigation and reload.
 *
 * It is NOT a source of truth and may drift from the server's totals.
 */
export interface UseCourseXpResult {
  /** Running XP total for the course. */
  readonly xp: number;
  /** Bumped on every `addXp` — feeds the badge pop animation's reset key. */
  readonly pulseKey: number;
  /** Amount of the most recent gain — shown in the "+N XP" floater. */
  readonly gainAmount: number;
  /** Add XP. Non-positive / non-finite amounts are ignored (no pulse, no write). */
  readonly addXp: (amount: number) => void;
}

/** localStorage key for a course's running XP total. */
const keyFor = (courseId: string): string => `nalu:course:${courseId}:xp`;

/** Read the persisted total. SSR-safe; returns 0 off the browser or on error. */
function readStored(courseId: string): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(keyFor(courseId));
    if (raw === null) return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * @param courseId - Course the counter is scoped to.
 */
export function useCourseXp(courseId: string): UseCourseXpResult {
  const [xp, setXp] = useState(0);
  const [pulseKey, setPulseKey] = useState(0);
  const [gainAmount, setGainAmount] = useState(0);

  // Hydrate from localStorage after mount. `useState(0)` keeps SSR and the
  // first client render identical (no hydration mismatch); the effect then
  // swaps in the stored value. Mirrors the localStorage-hydration pattern in
  // `EmptyState.tsx` / `Composer.tsx`.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: client-only localStorage hydration
    setXp(readStored(courseId));
  }, [courseId]);

  const addXp = useCallback(
    (amount: number) => {
      if (!Number.isFinite(amount) || amount <= 0) return;
      const rounded = Math.round(amount);
      setXp((prev) => {
        const next = prev + rounded;
        if (typeof window !== "undefined") {
          try {
            window.localStorage.setItem(keyFor(courseId), String(next));
          } catch {
            /* quota / disabled — ignore */
          }
        }
        return next;
      });
      setGainAmount(rounded);
      setPulseKey((k) => k + 1);
    },
    [courseId],
  );

  return { xp, pulseKey, gainAmount, addXp };
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `bun run test src/hooks/useCourseXp.test.ts`
Expected: PASS (5 tests).

If `just lint` later flags the `react-hooks/set-state-in-effect` disable as _unused_, remove that comment line. If it flags the rule as _violated_, the comment is correct as written.

- [ ] **Step 5: Lint + commit**

Run: `just lint`
Expected: passes.

```bash
git add src/hooks/useCourseXp.ts src/hooks/useCourseXp.test.ts
git commit -m "feat(hooks): add useCourseXp localStorage-backed counter"
```

---

## Task 6: `formatComposerAnswers` helper

A pure helper that formats Composer-emitted answers identically to `formatAnswers` (`deriveTurns.ts`) — so the optimistic user-answers bubble (Tasks 13–14) is byte-identical to the refetched turn and never visibly swaps.

**Files:**

- Create: `src/lib/course/formatComposerAnswers.ts`
- Test: `src/lib/course/formatComposerAnswers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/course/formatComposerAnswers.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatComposerAnswers } from "./formatComposerAnswers";

describe("formatComposerAnswers", () => {
  it("formats answers as a numbered prose list", () => {
    expect(
      formatComposerAnswers([
        {
          question: { id: "q1", prompt: "Capital of France?", options: ["Paris"] },
          answer: "Paris",
        },
        { question: { id: "q2", prompt: "2 + 2?", options: [] }, answer: "4" },
      ]),
    ).toBe("1. Capital of France? — Paris\n2. 2 + 2? — 4");
  });

  it("returns an empty string for no answers", () => {
    expect(formatComposerAnswers([])).toBe("");
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `bun run test src/lib/course/formatComposerAnswers.test.ts`
Expected: FAIL — `Cannot find module './formatComposerAnswers'`.

- [ ] **Step 3: Implement the helper**

Create `src/lib/course/formatComposerAnswers.ts`:

```ts
import type { RawComposerAnswer } from "./shapeQuestionnaireAnswers";

/**
 * Format Composer-emitted `{ question, answer }` pairs as the same numbered
 * prose list that `formatAnswers` (`deriveTurns.ts`) produces from persisted
 * responses: `"{n}. {prompt} — {answer}"` joined by newlines.
 *
 * Used to render the *optimistic* user-answers bubble the instant a
 * questionnaire is submitted, before the server round-trip lands. Matching the
 * persisted formatter exactly keeps the optimistic text identical to the
 * refetched turn, so there is no visible swap when real data arrives.
 */
export function formatComposerAnswers(answers: readonly RawComposerAnswer[]): string {
  return answers.map((a, i) => `${i + 1}. ${a.question.prompt} — ${a.answer}`).join("\n");
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `bun run test src/lib/course/formatComposerAnswers.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/course/formatComposerAnswers.ts src/lib/course/formatComposerAnswers.test.ts
git commit -m "feat(course): add formatComposerAnswers for optimistic bubbles"
```

---

## Task 7: Composer — remove the duplicated "or type your own answer"

The phrase shows twice during a questionnaire: above the input (the `chooseLabel`, and the free-text fallback `<p>`) and inside the input (the textarea placeholder). Keep only the textarea placeholder, and make it dynamic per interaction type.

**Files:**

- Modify: `src/i18n/en.json`
- Modify: `src/components/chat/Composer.tsx`

- [ ] **Step 1: Update i18n strings**

In `src/i18n/en.json`, in the `"composer"` object: change `chooseLabel` and add `placeholderAnswerFree`:

```json
  "composer": {
    "placeholderFirst": "What do you want to learn…",
    "placeholderContinue": "Reply to nalu…",
    "placeholderAnswering": "Or type your own answer…",
    "placeholderAnswerFree": "Type your answer…",
    "chooseLabel": "choose one",
    "questionCounter": "{current} / {total}",
    "prev": "Previous question",
    "next": "Next question",
    "confirm": "Confirm",
    "escapeHatch": "I'd rather pick from options"
  },
```

- [ ] **Step 2: Make the placeholder dynamic and move `current`/`total` above it**

In `src/components/chat/Composer.tsx`, find this block:

```tsx
const placeholder = hasQuestions
  ? t<string>("composer.placeholderAnswering")
  : isFirstMessage
    ? t<string>("composer.placeholderFirst")
    : t<string>("composer.placeholderContinue");

const current = hasQuestions ? questions![step] : null;
const total = hasQuestions ? questions!.length : 0;
```

Replace it with (`current`/`total` move above `placeholder` so the placeholder can read `current`):

```tsx
const current = hasQuestions ? questions![step] : null;
const total = hasQuestions ? questions!.length : 0;

// Placeholder is dynamic by interaction type: an MC question keeps "or type
// your own answer" (options exist to pick instead); a free-text question
// uses a plain "type your answer"; otherwise it is the first-message or
// continue prompt.
const placeholder = hasQuestions
  ? current && current.options.length > 0
    ? t<string>("composer.placeholderAnswering")
    : t<string>("composer.placeholderAnswerFree")
  : isFirstMessage
    ? t<string>("composer.placeholderFirst")
    : t<string>("composer.placeholderContinue");
```

- [ ] **Step 3: Make the `chooseLabel` header conditional on MC**

In `Composer.tsx`, find the question-card header's left side:

```tsx
<div className="flex items-center gap-2">
  <span className="h-1 w-1 rounded-full" style={{ background: "var(--carp-yellow)" }} />
  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fuji-gray">
    {t<string>("composer.chooseLabel")}
  </span>
</div>
```

Replace it with — the label shows only for MC questions; an empty `<div />` keeps the counter/chevrons right-aligned for free-text questions:

```tsx
{
  current.options.length > 0 ? (
    <div className="flex items-center gap-2">
      <span className="h-1 w-1 rounded-full" style={{ background: "var(--carp-yellow)" }} />
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fuji-gray">
        {t<string>("composer.chooseLabel")}
      </span>
    </div>
  ) : (
    <div />
  );
}
```

- [ ] **Step 4: Remove the free-text fallback `<p>`**

In `Composer.tsx`, find the options-grid block with its free-text fallback:

```tsx
              {current.options.length > 0 ? (
                <div className="grid grid-cols-1 gap-1.5">
                  {current.options.map((opt, i) => {
```

…continuing to the fallback at the end of that ternary:

```tsx
                </div>
              ) : (
                <p className="px-1 text-[12px] text-fuji-gray italic">
                  {t<string>("composer.placeholderAnswering")}
                </p>
              )}
```

Change the wrapping ternary to a plain `&&` so a free-text question renders **no** body below the prompt (the textarea placeholder is the single source). Keep the `.map(...)` contents exactly as they are. The block becomes:

```tsx
{
  current.options.length > 0 && (
    <div className="grid grid-cols-1 gap-1.5">
      {current.options.map((opt, i) => {
        /* ...unchanged option-button mapping... */
      })}
    </div>
  );
}
```

- [ ] **Step 5: Typecheck, lint, build**

Run: `just typecheck && just lint && just build`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/i18n/en.json src/components/chat/Composer.tsx
git commit -m 'fix(composer): remove duplicated "or type your own" prompt'
```

---

## Task 8: Composer — lock answered questionnaire steps

Port the reference's `58631bd` quiz-UX delta: once a step has a recorded answer it cannot be changed or resubmitted.

**Files:**

- Modify: `src/components/chat/Composer.tsx`

- [ ] **Step 1: Add `stepLocked` and gate `confirmMode`**

In `Composer.tsx`, find:

```tsx
const canSend = value.trim().length > 0 && !disabled;
const currentPending = hasQuestions ? (pending[step] ?? null) : null;
const hasPending = currentPending != null;
// "Confirm" mode: question is active, user picked an option, no free text.
const confirmMode = hasQuestions && hasPending && value.trim().length === 0;
```

Replace with:

```tsx
const canSend = value.trim().length > 0 && !disabled;
const currentPending = hasQuestions ? (pending[step] ?? null) : null;
const hasPending = currentPending != null;
// A step is locked once it has a recorded answer — its option can no longer
// be changed and no answer can be resubmitted for it.
const stepLocked = hasQuestions && answers[step] != null;
// "Confirm" mode: question is active, user picked an option, no free text,
// and the step is not already locked.
const confirmMode = hasQuestions && hasPending && !stepLocked && value.trim().length === 0;
```

- [ ] **Step 2: Guard `selectOption` and `clearPending`**

In `selectOption`, add the lock guard after the existing `if (!hasQuestions || locked) return;`:

```tsx
const selectOption = (i: number) => {
  if (!hasQuestions || locked) return;
  // Once an answer is locked in for this step, it cannot be changed.
  if (answers[step] != null) return;
  const next = [...pending];
  next[step] = i;
  setPending(next);
};
```

In `clearPending`, add the lock guard after the existing `if (!hasQuestions) return;`:

```tsx
const clearPending = () => {
  if (!hasQuestions) return;
  // Don't clear a locked-in answer.
  if (answers[step] != null) return;
  if (pending[step] == null) return;
  const next = [...pending];
  next[step] = null;
  setPending(next);
};
```

- [ ] **Step 3: Disable + dim locked option buttons**

In the option-button `.map(...)`, find:

```tsx
                  {current.options.map((opt, i) => {
                    const isPending = currentPending === i;
                    const fb = feedback[step];
                    const pulseClass =
```

Add `isLockedAnswer`:

```tsx
                  {current.options.map((opt, i) => {
                    const isPending = currentPending === i;
                    const fb = feedback[step];
                    const isLockedAnswer = answers[step] != null;
                    const pulseClass =
```

Then find the option `<button>` opening tag:

```tsx
                      <button
                        key={i}
                        onClick={() => selectOption(i)}
                        disabled={disabled || locked}
                        className={
                          "group flex items-center gap-2.5 text-left rounded-xl px-3 py-2.5 text-[14px] leading-snug transition-all active:scale-[0.99] disabled:opacity-60 border " +
                          (isPending
```

Replace those lines with (adds `isLockedAnswer` to `disabled`, swaps `disabled:opacity-60` for `disabled:cursor-not-allowed`, dims non-selected options on a locked step):

```tsx
                      <button
                        key={i}
                        onClick={() => selectOption(i)}
                        disabled={disabled || locked || isLockedAnswer}
                        className={
                          "group flex items-center gap-2.5 text-left rounded-xl px-3 py-2.5 text-[14px] leading-snug transition-all active:scale-[0.99] border disabled:cursor-not-allowed " +
                          (isLockedAnswer && !isPending ? "opacity-40 " : "") +
                          (isPending
```

- [ ] **Step 4: Disable the textarea on a locked step**

In `Composer.tsx`, find the `<textarea`:

```tsx
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => {
```

Add `disabled={stepLocked}`:

```tsx
        <textarea
          ref={ref}
          rows={1}
          value={value}
          disabled={stepLocked}
          onChange={(e) => {
```

- [ ] **Step 5: Typecheck, lint, build**

Run: `just typecheck && just lint && just build`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/components/chat/Composer.tsx
git commit -m "feat(composer): lock answered questionnaire steps"
```

---

## Task 9: Composer — award exact MC XP on a correct answer

Replace the Composer's `toast.success("10 XP Gained")` placeholder with an `onCorrectAnswer` callback carrying the exact `calculateMcXp` amount.

**Files:**

- Modify: `src/components/chat/Composer.tsx`

- [ ] **Step 1: Swap the `toast` import for `calculateMcXp`**

In `Composer.tsx`, find:

```tsx
import { ArrowUp, Check, ChevronLeft, ChevronRight, Mic, Plus } from "lucide-react";
import { toast } from "sonner";
import { t } from "@/i18n";
import { playCorrect, playWrong } from "@/lib/sound";
```

Replace with (remove `sonner`, add `calculateMcXp`):

```tsx
import { ArrowUp, Check, ChevronLeft, ChevronRight, Mic, Plus } from "lucide-react";
import { t } from "@/i18n";
import { playCorrect, playWrong } from "@/lib/sound";
import { calculateMcXp } from "@/lib/scoring/xp";
```

- [ ] **Step 2: Add the `onCorrectAnswer` and `waveTier` props**

In the `Composer` function's destructured params, add `onCorrectAnswer` and `waveTier`:

```tsx
export function Composer({
  value,
  onChange,
  onSend,
  disabled,
  questions,
  onComplete,
  isFirstMessage,
  persistKey,
  moveOn,
  onCorrectAnswer,
  waveTier,
}: {
```

In the props type object, add (after the `moveOn` prop type):

```tsx
  /** When set, replaces the input row with a single advance button. */
  moveOn?: { readonly label: string; readonly onAdvance: () => void };
  /** Called with exact XP when the learner confirms a correct MC answer. */
  onCorrectAnswer?: (amount: number) => void;
  /** Wave tier — fallback for MC XP when a question carries no per-question tier. */
  waveTier?: number;
}) {
```

- [ ] **Step 3: Compute exact XP in `confirmSelection`**

In `confirmSelection`, find:

```tsx
if (isCorrect) {
  playCorrect();
  toast.success("10 XP Gained", { duration: 1500 });
} else playWrong();
```

Replace with:

```tsx
if (isCorrect) {
  playCorrect();
  // Exact XP for a correct MC, computed client-side from the question's
  // tier — the designated `calculateMcXp` instant path. Falls back to the
  // wave tier, then to tier 1, when no per-question tier is present.
  onCorrectAnswer?.(calculateMcXp(current.tier ?? waveTier ?? 1, true));
} else playWrong();
```

- [ ] **Step 4: Typecheck, lint, build**

Run: `just typecheck && just lint && just build`
Expected: all pass. (`toast` is no longer referenced in `Composer.tsx` — the removed import must not leave an unused-import error; if it does, a stray `toast` usage remains — search for it.)

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/Composer.tsx
git commit -m "feat(composer): award exact MC XP via calculateMcXp"
```

---

## Task 10: XP badge in `ChatHeader` + `ChatShell` pass-through

**Files:**

- Modify: `src/components/chat/ChatHeader.tsx` — full rewrite (adds `XpBadge`).
- Modify: `src/components/chat/ChatShell.tsx` — add XP pass-through props.

- [ ] **Step 1: Rewrite `ChatHeader.tsx`**

Replace the entire contents of `src/components/chat/ChatHeader.tsx` with:

```tsx
"use client";

import { Menu, SquarePen, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { t } from "@/i18n";

export function ChatHeader({
  onNew,
  onMenu,
  title,
  xp = 0,
  xpPulseKey = 0,
  xpGainAmount = 10,
  showXp = false,
}: {
  onNew?: () => void;
  onMenu?: () => void;
  /** When omitted, shows the app wordmark. When set, shows the conversation title. */
  title?: string | null;
  /** Accumulated XP for the current course. */
  xp?: number;
  /** Incremented on each XP gain to trigger the badge animation. */
  xpPulseKey?: number;
  /** Amount gained on the most recent pulse (shown in the "+N XP" floater). */
  xpGainAmount?: number;
  /** When true, the XP badge is rendered even at 0 XP. */
  showXp?: boolean;
}) {
  const showTitle = !!title;
  const renderXp = showXp || xp > 0 || xpPulseKey > 0;
  return (
    <header className="relative z-20 flex items-center justify-between px-4 h-14 border-b border-sumi-4/60 bg-sumi-1/70 backdrop-blur-xl">
      <button
        onClick={onMenu}
        aria-label={t("header.menu")}
        className="h-9 w-9 -ml-2 grid place-items-center rounded-lg text-fuji-gray hover:text-foreground hover:bg-sumi-3 transition-colors"
      >
        <Menu className="h-[18px] w-[18px]" strokeWidth={1.75} />
      </button>

      {showTitle ? (
        <div className="flex items-center gap-2 min-w-0 px-2">
          <span className="h-1.5 w-1.5 rounded-full bg-sakura-pink shrink-0" />
          <p className="text-[14px] font-medium tracking-tight truncate max-w-[60vw]">{title}</p>
        </div>
      ) : (
        <div className="flex items-center gap-2.5">
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-spring-green">
            <span className="absolute inset-0 rounded-full bg-spring-green/60 animate-ping" />
          </span>
          <p className="font-mono text-[13px] tracking-tight">
            <span className="text-foreground">{t<string>("app.name")}</span>
            <span className="text-fuji-gray">/v1</span>
          </p>
        </div>
      )}

      <div className="flex items-center gap-1 -mr-2">
        {renderXp && <XpBadge xp={xp} pulseKey={xpPulseKey} gain={xpGainAmount} />}
        <button
          onClick={onNew}
          aria-label={t("header.newChat")}
          className="h-9 w-9 grid place-items-center rounded-lg text-fuji-gray hover:text-foreground hover:bg-sumi-3 transition-colors"
        >
          <SquarePen className="h-[17px] w-[17px]" strokeWidth={1.75} />
        </button>
      </div>
    </header>
  );
}

/**
 * Animated XP pill. Shows the pre-gain total during the pop animation, then
 * snaps to the new total as the "+N XP" floater fades — so the floater appears
 * to "land". Timings must match the `xp-badge-pop` / `xp-gain-float` keyframes.
 */
function XpBadge({ xp, pulseKey, gain }: { xp: number; pulseKey: number; gain: number }) {
  const [displayed, setDisplayed] = useState(xp);
  const [pulsing, setPulsing] = useState(false);
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      setDisplayed(xp);
      return;
    }
    if (pulseKey === 0) return;
    setPulsing(true);
    const landAt = 520;
    const endAt = 900;
    const t1 = window.setTimeout(() => setDisplayed(xp), landAt);
    const t2 = window.setTimeout(() => setPulsing(false), endAt);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pulseKey]);

  return (
    <div className="relative">
      <div
        className={
          "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border bg-sumi-3 border-sumi-4 will-change-transform " +
          (pulsing ? "xp-badge-pop" : "")
        }
        style={{ color: "var(--spring-green)" }}
        aria-live="polite"
        aria-label={`${displayed} XP`}
      >
        <Sparkles className="h-3 w-3" strokeWidth={2.25} />
        <span className="font-mono text-[11px] tabular-nums tracking-wide text-foreground">
          {displayed}
        </span>
        <span className="font-mono text-[9px] tracking-[0.16em] uppercase text-fuji-gray">XP</span>
      </div>
      {pulsing && (
        <span
          key={pulseKey}
          className="xp-gain-float pointer-events-none absolute left-1/2 -translate-x-1/2 -top-1 font-mono text-[11px] font-semibold tracking-wide"
          style={{ color: "var(--spring-green)" }}
        >
          +{gain} XP
        </span>
      )}
    </div>
  );
}
```

> If `just lint` reports `react-hooks/set-state-in-effect` on the `XpBadge` effect, change the disable line to `// eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect`.

- [ ] **Step 2: Add XP pass-through props to `ChatShell.tsx`**

In `src/components/chat/ChatShell.tsx`, update the `ChatShell` props and the `<ChatHeader>` call. Change the destructured params + type to:

```tsx
export function ChatShell({
  title,
  children,
  composer,
  onNew,
  xp,
  xpPulseKey,
  xpGainAmount,
  showXp,
}: {
  readonly title?: string | null;
  readonly children: ReactNode;
  readonly composer: ReactNode;
  readonly onNew: () => void;
  readonly xp?: number;
  readonly xpPulseKey?: number;
  readonly xpGainAmount?: number;
  readonly showXp?: boolean;
}) {
```

And the `<ChatHeader>` element:

```tsx
<ChatHeader
  title={title ?? null}
  onMenu={() => setMenuOpen(true)}
  onNew={onNew}
  xp={xp}
  xpPulseKey={xpPulseKey}
  xpGainAmount={xpGainAmount}
  showXp={showXp}
/>
```

- [ ] **Step 3: Typecheck, lint, build**

Run: `just typecheck && just lint && just build`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/chat/ChatHeader.tsx src/components/chat/ChatShell.tsx
git commit -m "feat(ui): add animated XP badge to the chat header"
```

---

## Task 11: `Splash` component

Port the reference's `Splash.tsx`, adapted to the Nalu stack (no shadcn `Button`, no tw-animate-css). Component only — mounted in Task 15.

**Files:**

- Create: `src/components/chat/Splash.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/chat/Splash.tsx`:

```tsx
"use client";

import { Sparkles } from "lucide-react";

/**
 * Full-screen intro overlay shown on every visit to the home screen. Ported
 * from the kanagawa-whispers reference UI. The reference's shadcn `<Button>` is
 * replaced with a plain button (Nalu has no `ui/button`); `animate-in fade-in`
 * is replaced with the `.animate-fade-in` utility added in `globals.css`.
 */
export function Splash({ onStart }: { readonly onStart: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-kanagawa-atmos text-foreground noise animate-fade-in">
      <div className="flex-1 overflow-y-auto px-6 py-10 flex items-center justify-center">
        <div className="w-full max-w-md mx-auto space-y-6">
          <div className="inline-flex items-center gap-2 rounded-full border border-sumi-4/60 bg-sumi-3/40 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-fuji-gray">
            <Sparkles className="h-3 w-3 text-spring-green" strokeWidth={2.25} />
            work in progress
          </div>

          <h1 className="text-3xl font-semibold leading-tight tracking-tight">
            Hi, I&apos;m Ollie — welcome to <span className="text-crystal">nalu</span>.
          </h1>

          <div className="space-y-4 text-[15px] leading-relaxed text-fuji-gray">
            <p>
              A little side project of mine — think{" "}
              <span className="text-foreground">Duolingo, but for anything</span> you want to learn.
            </p>
            <p>
              The prompting and model aren&apos;t finished yet, but this should give you a real feel
              for where it&apos;s heading.
            </p>
            <p>
              Unlike a regular chatbot, nalu has a{" "}
              <span className="text-foreground">progression system</span> that tracks how
              you&apos;re doing, adapts to your answers, and gamifies the journey — structure a
              plain chat just doesn&apos;t have.
            </p>
          </div>
        </div>
      </div>

      <div className="px-6 pb-8 pt-2">
        <div className="mx-auto w-full max-w-md">
          <button
            onClick={onStart}
            style={{ color: "var(--sumi-ink-0)" }}
            className="w-full h-12 inline-flex items-center justify-center rounded-xl text-[15px] font-medium bg-spring-green transition active:scale-[0.99] hover:brightness-110 shadow-glow"
          >
            Start learning
          </button>
          <p className="mt-3 text-center text-[11px] text-fuji-gray">
            nalu · a work in progress by Ollie
          </p>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck, lint, build**

Run: `just typecheck && just lint && just build`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add src/components/chat/Splash.tsx
git commit -m "feat(ui): add splash screen intro component"
```

---

## Task 12: `useWaveState` — route XP to the badge, expose `topic` + `currentTier`

`useWaveState` owns the XP counter: it applies server-graded free-text/completion XP, exposes the badge display fields plus an `awardMcXp` handler for the Composer, drops the XP toasts (keeps the tier-up toast), and exposes `topic` + `currentTier`.

**Files:**

- Modify: `src/hooks/useWaveState.ts`
- Modify: `src/hooks/useWaveState.test.tsx`

- [ ] **Step 1: Update the failing tests**

In `src/hooks/useWaveState.test.tsx`:

(a) Add `window.localStorage.clear();` to the `beforeEach` block — `useCourseXp` persists XP per courseId, and tests share `courseId: "c1"`:

```ts
beforeEach(() => {
  /* eslint-disable functional/immutable-data -- reset test buffers between tests */
  submitTurnCalls.length = 0;
  latestOnSuccess = undefined;
  latestOnError = undefined;
  currentState = defaultStateData;
  window.localStorage.clear();
  /* eslint-enable functional/immutable-data */
});
```

(b) Add `topic` to `defaultStateData`:

```ts
const defaultStateData = {
  courseId: "c1",
  topic: "Test topic",
  waveId: "w1",
  waveNumber: 1,
  currentTier: 1,
  status: "active" as const,
  turnsRemaining: 9,
  chatLog: [{ role: "assistant", kind: "text", content: "Welcome to wave 1." }] as const,
  closeResult: null,
};
```

(c) In the existing test `"captures closeResult from a close-turn mutation response"`, append one line immediately after its final assertion (the `expect(result.current.closeResult).toEqual({ ... })` call) — the close-turn's completion XP of 50 must reach the badge counter:

```ts
await waitFor(() => expect(result.current.xp).toBe(50));
```

(d) Add two new `it` blocks inside the `describe`:

```ts
it("adds free-text XP to the badge and skips mc-index signals", async () => {
  const { result } = renderHook(() => useWaveState("c1", 1), { wrapper });
  await waitFor(() => expect(result.current.turns.length).toBeGreaterThan(0));

  act(() => result.current.submitChatText("an answer"));
  await waitFor(() => expect(latestOnSuccess).toBeDefined());

  act(() =>
    latestOnSuccess?.({
      kind: "mid-turn",
      gradedSignals: [
        { kind: "free-text", questionId: "q1", xpAwarded: 30 },
        { kind: "mc-index", questionId: "q2", xpAwarded: 20 },
      ],
    }),
  );

  await waitFor(() => expect(result.current.xp).toBe(30));
});

it("exposes the course topic and current tier", async () => {
  const { result } = renderHook(() => useWaveState("c1", 1), { wrapper });
  await waitFor(() => expect(result.current.topic).toBe("Test topic"));
  expect(result.current.currentTier).toBe(1);
});
```

- [ ] **Step 2: Run the tests — verify they fail**

Run: `bun run test src/hooks/useWaveState.test.tsx`
Expected: FAIL — `result.current.xp` / `.topic` / `.currentTier` are `undefined`.

- [ ] **Step 3: Import `useCourseXp` and use it**

In `src/hooks/useWaveState.ts`, add the import:

```ts
import { useCourseXp } from "./useCourseXp";
```

Inside `useWaveState`, after `const qc = useQueryClient();`, add:

```ts
const courseXp = useCourseXp(courseId);
```

- [ ] **Step 4: Replace the XP toasts in `submitTurn.onSuccess`**

Find the `submitTurn` `useMutation` and replace its `onSuccess` body. The new `onSuccess`:

```ts
      onSuccess: (result) => {
        if (result.kind === "mid-turn") {
          // Free-text XP is server-graded; sum it into one badge pulse. MC XP
          // is already counted client-side at confirm time (Composer
          // onCorrectAnswer) — skip `mc-index` signals to avoid double-counting.
          const freeTextXp = result.gradedSignals
            .filter((s) => s.kind === "free-text")
            .reduce((sum, s) => sum + s.xpAwarded, 0);
          courseXp.addXp(freeTextXp);
        } else {
          // close-turn — capture the close result + completion XP.
          setCloseResult({
            closingMessage: result.closingMessage,
            nextWaveNumber: result.nextWaveNumber,
            completionXpAwarded: result.completionXpAwarded,
            tierAdvancedTo: result.tierAdvancedTo,
          });
          courseXp.addXp(result.completionXpAwarded);
          if (result.tierAdvancedTo !== null) {
            toast.success(`Tier up → ${result.tierAdvancedTo}`, { duration: 3000 });
          }
        }
        invalidateState();
      },
```

Leave the `onError` handler unchanged (it still uses `toast.error`).

- [ ] **Step 5: Extend `UseWaveStateResult` and the return object**

Add to the `UseWaveStateResult` interface (after `status`):

```ts
  readonly status: WaveState["status"] | null;
  /** Course topic — drives the wave header title. Null until the query resolves. */
  readonly topic: string | null;
  /** Wave tier — fallback for client-side MC XP. Null until the query resolves. */
  readonly currentTier: number | null;
  /** Running XP total for the course (display counter). */
  readonly xp: number;
  /** Bumped on each XP gain — drives the header badge animation. */
  readonly xpPulseKey: number;
  /** Amount of the most recent XP gain. */
  readonly xpGainAmount: number;
  /** Records exact MC XP from a correct answer. Wired to the Composer. */
  readonly awardMcXp: (amount: number) => void;
```

Update the hook's `return { ... }`:

```ts
return {
  turns,
  activeQuestionnaire,
  closeResult,
  status: state.data?.status ?? null,
  topic: state.data?.topic ?? null,
  currentTier: state.data?.currentTier ?? null,
  xp: courseXp.xp,
  xpPulseKey: courseXp.pulseKey,
  xpGainAmount: courseXp.gainAmount,
  awardMcXp: courseXp.addXp,
  isPending,
  submitChatText,
  submitQuestionnaireAnswers,
};
```

- [ ] **Step 6: Run the tests — verify they pass**

Run: `bun run test src/hooks/useWaveState.test.tsx`
Expected: PASS.

- [ ] **Step 7: Typecheck, lint**

Run: `just typecheck && just lint`
Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/useWaveState.ts src/hooks/useWaveState.test.tsx
git commit -m "feat(wave): route XP to the header badge, expose topic"
```

---

## Task 13: `WaveSession` — XP badge, course title, optimistic submit

**Files:**

- Modify: `src/components/chat/WaveSession.tsx`

- [ ] **Step 1: Rewrite `WaveSession.tsx`**

Replace the body of `WaveSession` (keep the file's existing `renderTurn` function and all imports below, plus add the two new imports). The new imports at the top — add `useState` is already imported; add `formatComposerAnswers`:

```tsx
import { shapeQuestionnaireAnswers } from "@/lib/course/shapeQuestionnaireAnswers";
import { formatComposerAnswers } from "@/lib/course/formatComposerAnswers";
```

Replace the `WaveSession` function (the `export function WaveSession(...) { ... }` block, **not** `renderTurn`) with:

```tsx
export function WaveSession({
  courseId,
  waveNumber,
}: {
  readonly courseId: string;
  readonly waveNumber: number;
}) {
  const router = useRouter();
  const {
    turns,
    activeQuestionnaire,
    closeResult,
    status,
    topic,
    currentTier,
    xp,
    xpPulseKey,
    xpGainAmount,
    awardMcXp,
    isPending,
    submitChatText,
    submitQuestionnaireAnswers,
  } = useWaveState(courseId, waveNumber);

  const [composerValue, setComposerValue] = useState("");
  // Optimistic user message: rendered immediately on submit so the learner's
  // input appears at once, before the server round-trip. Only shown while a
  // turn is in flight; once `isPending` clears, the refetched `turns` already
  // contain the real entry, so a stale value here is simply not rendered.
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);

  const scroll = turns.map((turn, idx) => renderTurn(turn, idx));

  const nextWaveNumber = closeResult?.nextWaveNumber ?? waveNumber + 1;
  const isClosed = closeResult !== null || status === "closed";
  const moveOn = isClosed
    ? {
        label: t<string>("moveOn.toWave").replace("{n}", String(nextWaveNumber)),
        onAdvance: () => router.push(`/course/${courseId}/wave/${nextWaveNumber}`),
      }
    : undefined;

  return (
    <ChatShell
      title={topic}
      onNew={() => router.push("/")}
      xp={xp}
      xpPulseKey={xpPulseKey}
      xpGainAmount={xpGainAmount}
      showXp
      composer={
        <Composer
          value={composerValue}
          onChange={setComposerValue}
          onSend={() => {
            const text = composerValue.trim();
            if (text.length === 0) return;
            setPendingMessage(text);
            submitChatText(text);
            setComposerValue("");
          }}
          disabled={isPending}
          questions={activeQuestionnaire ? [...activeQuestionnaire.questions] : null}
          persistKey={activeQuestionnaire?.persistKey}
          waveTier={currentTier ?? undefined}
          onCorrectAnswer={awardMcXp}
          moveOn={moveOn}
          onComplete={(answers) => {
            if (!activeQuestionnaire) return;
            setPendingMessage(formatComposerAnswers(answers));
            submitQuestionnaireAnswers(shapeQuestionnaireAnswers(answers));
          }}
        />
      }
    >
      {scroll}
      {isPending && pendingMessage && (
        <MessageBubble message={{ id: "pending", role: "user", content: pendingMessage }} />
      )}
      {isPending && <TypingBubble />}
    </ChatShell>
  );
}
```

- [ ] **Step 2: Typecheck, lint, build**

Run: `just typecheck && just lint && just build`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add src/components/chat/WaveSession.tsx
git commit -m "feat(wave): show course title, XP badge, optimistic user message"
```

---

## Task 14: `Onboarding` + `useScopingState` — course title and optimistic submit

**Files:**

- Modify: `src/hooks/useScopingState.ts` — expose `topic`.
- Modify: `src/hooks/useScopingState.test.tsx` — assert `topic`.
- Modify: `src/components/chat/Onboarding.tsx` — title + optimistic.

- [ ] **Step 1: Update the failing test**

In `src/hooks/useScopingState.test.tsx`, add this `it` block inside the existing top-level `describe`. The test file's tRPC mock already provides a `course.getState` fixture with `topic: "T"`, so the assertion is exact:

```ts
it("exposes the course topic", async () => {
  const { result } = renderHook(() => useScopingState("c1"), { wrapper });
  await waitFor(() => expect(result.current.topic).toBe("T"));
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `bun run test src/hooks/useScopingState.test.tsx`
Expected: FAIL — `result.current.topic` is `undefined`.

- [ ] **Step 3: Expose `topic` from `useScopingState`**

In `src/hooks/useScopingState.ts`, add to the `UseScopingStateResult` interface (after `scopingResult`):

```ts
  readonly scopingResult: CourseState["scopingResult"];
  /** Course topic — drives the chat header title. Null until the query resolves. */
  readonly topic: string | null;
```

In the hook's `return { ... }`, add:

```ts
return {
  turns,
  activeQuestionnaire,
  scopingResult: state.data?.scopingResult ?? null,
  topic: state.data?.topic ?? null,
  isPending,
  submitClarify,
  submitBaselineAnswers,
};
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `bun run test src/hooks/useScopingState.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire title + optimistic submit in `Onboarding.tsx`**

In `src/components/chat/Onboarding.tsx`:

(a) Add the import:

```tsx
import { formatComposerAnswers } from "@/lib/course/formatComposerAnswers";
```

(b) Destructure `topic` from `useScopingState`:

```tsx
const {
  turns,
  activeQuestionnaire,
  scopingResult,
  topic,
  isPending,
  submitClarify,
  submitBaselineAnswers,
} = useScopingState(courseId);
```

(c) Add the pending-message state after `composerValue`:

```tsx
const [composerValue, setComposerValue] = useState("");
// Optimistic user message — see WaveSession for the rationale.
const [pendingMessage, setPendingMessage] = useState<string | null>(null);
```

(d) On `<ChatShell>`, change `title={null}` to `title={topic}`.

(e) In the `Composer`'s `onComplete`, set the pending message before submitting:

```tsx
          onComplete={(answers) => {
            if (!activeQuestionnaire) return;
            setPendingMessage(formatComposerAnswers(answers));
            if (activeQuestionnaire.kind === "clarify") {
              submitClarify(shapeClarifyAnswers(answers));
            } else {
              submitBaselineAnswers(shapeQuestionnaireAnswers(answers));
            }
          }}
```

(f) In the `ChatShell` children, add the optimistic bubble before `TypingBubble`:

```tsx
{
  scroll;
}
{
  isPending && pendingMessage && (
    <MessageBubble message={{ id: "pending", role: "user", content: pendingMessage }} />
  );
}
{
  isPending && <TypingBubble />;
}
```

(`MessageBubble` is already imported in `Onboarding.tsx`. Leave the `onSend` handler unchanged — free-text send is unused on the scoping screen.)

- [ ] **Step 6: Typecheck, lint, build**

Run: `just typecheck && just lint && just build`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useScopingState.ts src/hooks/useScopingState.test.tsx src/components/chat/Onboarding.tsx
git commit -m "feat(scoping): show course title and optimistic user message"
```

---

## Task 15: `TopicInput` — mount the splash and optimistic topic submit

**Files:**

- Modify: `src/components/chat/TopicInput.tsx` — full rewrite.

- [ ] **Step 1: Rewrite `TopicInput.tsx`**

Replace the entire contents of `src/components/chat/TopicInput.tsx` with:

```tsx
"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc";
import { ChatShell } from "./ChatShell";
import { Composer } from "./Composer";
import { EmptyState } from "./EmptyState";
import { MessageBubble, TypingBubble } from "./MessageBubble";
import { Splash } from "./Splash";

/**
 * Empty home screen: splash intro + greeting + suggestions + free-text
 * Composer. Submitting the topic calls `course.clarify` and routes to
 * `/course/{id}`. While the call is in flight the submitted topic renders
 * optimistically as a chat bubble + typing spinner — there is no course chat
 * to route into yet, so the home screen stands in.
 */
export function TopicInput() {
  const router = useRouter();
  const trpc = useTRPC();
  const [value, setValue] = useState("");
  // Shown on every visit to the home screen (TopicInput remounts on each "/").
  const [showSplash, setShowSplash] = useState(true);
  // The submitted topic — drives the optimistic view until the route changes.
  const [submittedTopic, setSubmittedTopic] = useState<string | null>(null);

  const clarify = useMutation(
    trpc.course.clarify.mutationOptions({
      onSuccess: (result) => {
        router.push(`/course/${result.courseId}`);
      },
      onError: (err) => {
        toast.error("Couldn't start your course", { description: err.message });
        // Submission failed — drop the optimistic view so the learner can retry.
        setSubmittedTopic(null);
      },
    }),
  );

  const send = (text?: string) => {
    // Guard against double-fire from repeated suggestion clicks or rapid Enter.
    if (clarify.isPending) return;
    const content = (text ?? value).trim();
    if (!content) return;
    setValue("");
    setSubmittedTopic(content);
    clarify.mutate({ topic: content });
  };

  return (
    <>
      {showSplash && <Splash onStart={() => setShowSplash(false)} />}
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
        {submittedTopic ? (
          <>
            <MessageBubble message={{ id: "pending", role: "user", content: submittedTopic }} />
            <TypingBubble />
          </>
        ) : (
          <EmptyState onPick={(topic) => send(topic)} />
        )}
      </ChatShell>
    </>
  );
}
```

- [ ] **Step 2: Typecheck, lint, build**

Run: `just typecheck && just lint && just build`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add src/components/chat/TopicInput.tsx
git commit -m "feat(home): add splash screen and optimistic topic submission"
```

---

## Task 16: Full verification

**Files:** none changed.

- [ ] **Step 1: Run the full check suite**

Run: `just check`
Expected: lint, typecheck, and unit tests all pass.

- [ ] **Step 2: Production build**

Run: `just build`
Expected: build succeeds.

- [ ] **Step 3: Manual verification (dev server)**

Start the dev server (`just dev` — requires Touch ID for `op run`) and verify each feature:

1. **Splash** — loading `/` shows the full-screen splash; "Start learning" dismisses it; navigating away and back to `/` shows it again.
2. **Optimistic home submit** — type a topic and submit: the topic appears immediately as a chat bubble with a typing spinner, before the route changes to `/course/{id}`.
3. **Course title** — on `/course/{id}` (scoping) and `/course/{id}/wave/{n}`, the header shows the course topic.
4. **Optimistic in-course submit** — in a wave, send a chat message: it appears instantly with the spinner, no hang.
5. **Questionnaire step-lock** — answer a question; navigating back to it shows the answer locked (options dimmed/disabled, textarea disabled).
6. **No duplicate prompt** — during a questionnaire, "or type your own answer" appears only inside the input box. The placeholder reads "Or type your own answer…" for MC questions and "Type your answer…" for free-text questions.
7. **XP badge** — in a wave, the header shows the XP pill. A correct MC answer pops the badge with a "+N XP" floater immediately; a free-text answer pops it again when the server grading returns; no XP sonner toasts appear. A wave completion pops it by the completion XP; a tier-up still shows its toast.

- [ ] **Step 4: Report**

Summarize the verification results. If any manual check fails, open a follow-up rather than marking the plan complete.

---

## Self-review notes

- **Spec coverage:** Splash → Tasks 2, 11, 15. Step-lock → Task 8. XP tracker → Tasks 2, 3, 5, 9, 10, 12, 13. Course title → Tasks 4, 12, 13, 14. Optimistic submit → Tasks 6, 13, 14, 15. Duplicate text → Task 7. Reference fast-forward → Task 1. All six spec features covered.
- **Type consistency:** `ChoiceQuestion.tier` / `WaveQuestionForClient.tier` / `OpenQuestionForClient.tier` (Task 3) feed `Composer.waveTier`/`current.tier` (Task 9). `WaveState.topic` (Task 4) → `useWaveState.topic` (Task 12) → `WaveSession` (Task 13). `useCourseXp` result fields (`xp`, `pulseKey`, `gainAmount`, `addXp`) (Task 5) → `useWaveState` (`xp`, `xpPulseKey`, `xpGainAmount`, `awardMcXp`) (Task 12) → `ChatShell`/`ChatHeader` props (`xp`, `xpPulseKey`, `xpGainAmount`, `showXp`) (Task 10) and `Composer.onCorrectAnswer` (Task 9). `formatComposerAnswers` (Task 6) consumed by Tasks 13–14. Names consistent across tasks.
- **No backend XP-accounting changes** — `courses.total_xp` / `user_profiles.total_xp` untouched, per the spec's out-of-scope list.
