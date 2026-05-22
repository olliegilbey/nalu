# UI QA fixes (round 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix eight UI QA bugs on `feat/ui-fixes-reference-merge` — questionnaire
free-text loss, lingering question card, duplicate/vanishing optimistic bubble,
silent mutation errors, and a localStorage restore bug.

**Architecture:** Two new pure helpers (TDD'd) plus surgical edits to six chat
components/hooks. The optimistic-bubble fix gates the bubble on a `turns.length`
snapshot rather than `isPending`. The Composer gains per-step free-text drafts
and a merged questionnaire-init effect.

**Tech Stack:** Next.js 16.2, TypeScript strict, React, tRPC v11 + TanStack
Query, Zod v4, Vitest, sonner (toasts). Package manager: **bun**.

Spec: `docs/superpowers/specs/2026-05-22-ui-qa-fixes-design.md`.

---

## File Structure

**New files**

- `src/lib/errors.ts` — `formatMutationError(err)`: composes a
  developer-identifiable description from a tRPC/mutation error. Pure.
- `src/lib/errors.test.ts` — colocated test.
- `src/lib/course/parseQuestionnaireBuffer.ts` — `parseQuestionnaireBuffer(raw,
questionsKey, count)`: validates a persisted questionnaire buffer. Pure,
  Zod-validated.
- `src/lib/course/parseQuestionnaireBuffer.test.ts` — colocated test.

**Modified files**

- `src/components/chat/Composer.tsx` — per-step free-text drafts (issue 4);
  merged questionnaire-init effect (localStorage bug, Q3).
- `src/components/chat/Onboarding.tsx` — optimistic-bubble snapshot + dismiss
  questionnaire on submit (issues 5, 6, 8).
- `src/components/chat/WaveSession.tsx` — same as Onboarding (issues 5, 6, 8).
- `src/components/chat/TopicInput.tsx` — error code in the `clarify` toast (8).
- `src/hooks/useScopingState.ts` — error toasts on the three scoping mutations
  (issue 8).
- `src/hooks/useWaveState.ts` — error code in the `submitTurn` toast (issue 8).

**Already applied (committed in Task 1)**

- `src/components/chat/Splash.tsx` — issues 1, 2, 3.
- `src/components/chat/ChatShell.tsx` — issue 7.
- `.claude/settings.json` — unrelated plugin swap; the user asked for it
  committed too.

---

## Conventions for every task

- **Commit messages:** Conventional Commits, lowercase subject.
- **Never** use `--no-verify` or bypass git hooks. The pre-commit hook runs on
  every commit; if it fails, fix the root cause.
- TypeScript strict, no `any`. `eslint-plugin-functional` forbids `let` and (in
  most files) data mutation — use `const` and spreads.
- `Composer.tsx` carries a **file-wide** `eslint-disable` for
  `functional/immutable-data` + `max-lines`; local array mutation is allowed
  there. The new helper files have **no** such disable — keep them immutable.
- No chat-component unit-test harness exists. Components are verified with
  `just typecheck`, `just lint`, `just test` (and `just build` in the final
  task). Pure helpers are TDD'd.

---

## Task 1: Commit the already-applied work

The prior session applied issues 1/2/3/7 and a plugin swap; they sit
uncommitted in the working tree. Commit them so later tasks start from a clean
tree.

**Files:**

- Modify (commit only): `src/components/chat/Splash.tsx`,
  `src/components/chat/ChatShell.tsx`, `.claude/settings.json`

- [ ] **Step 1: Confirm the working tree holds exactly these changes**

Run: `git status --short`
Expected: `M src/components/chat/ChatShell.tsx`, `M src/components/chat/Splash.tsx`,
`M .claude/settings.json`, and untracked `docs/status/`. Nothing else modified.

- [ ] **Step 2: Review the UI diff for sanity**

Run: `git diff src/components/chat/Splash.tsx src/components/chat/ChatShell.tsx`
Expected: `Splash.tsx` shows em-dash → hyphen in the heading, the three
rewritten body paragraphs with `<strong className="font-medium text-foreground">`
emphasis; `ChatShell.tsx` shows a `lastScrollHeight` ref guarding the scroll
effect. No other changes.

- [ ] **Step 3: Commit the UI fixes**

```bash
git add src/components/chat/Splash.tsx src/components/chat/ChatShell.tsx
git commit -m "fix(ui): correct splash copy and stop chat scroll bob"
```

- [ ] **Step 4: Commit the plugin swap separately**

```bash
git add .claude/settings.json
git commit -m "chore: swap context-budget-monitor for rot-reducer plugin"
```

- [ ] **Step 5: Verify the tree is clean apart from untracked status docs**

Run: `git status --short`
Expected: only `?? docs/status/` remains.

---

## Task 2: `formatMutationError` pure helper

A pure helper that turns a mutation error into a one-line, developer-identifiable
toast description (e.g. `"HTTP 429 · TOO_MANY_REQUESTS — Rate limit exceeded"`).

**Files:**

- Create: `src/lib/errors.ts`
- Test: `src/lib/errors.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/errors.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { formatMutationError } from "./errors";

describe("formatMutationError", () => {
  it("includes HTTP status and code for a tRPC-shaped error", () => {
    const err = Object.assign(new Error("Rate limit exceeded"), {
      data: { code: "TOO_MANY_REQUESTS", httpStatus: 429 },
    });
    expect(formatMutationError(err)).toBe("HTTP 429 · TOO_MANY_REQUESTS — Rate limit exceeded");
  });

  it("includes only the code when httpStatus is absent", () => {
    const err = Object.assign(new Error("Bad input"), {
      data: { code: "BAD_REQUEST" },
    });
    expect(formatMutationError(err)).toBe("BAD_REQUEST — Bad input");
  });

  it("falls back to the bare message when there is no data object", () => {
    expect(formatMutationError(new Error("Something broke"))).toBe("Something broke");
  });

  it("handles a plain string error", () => {
    expect(formatMutationError("plain string failure")).toBe("plain string failure");
  });

  it("handles a non-error, non-string input", () => {
    expect(formatMutationError(null)).toBe("Unknown error");
    expect(formatMutationError(undefined)).toBe("Unknown error");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/lib/errors.test.ts`
Expected: FAIL — cannot resolve `./errors` (module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/lib/errors.ts`:

```typescript
/**
 * Compose a developer-identifiable description from a mutation error.
 *
 * tRPC client errors carry a `data` object holding the procedure error's
 * `code` (e.g. `"TOO_MANY_REQUESTS"`) and `httpStatus` (e.g. `429`). This
 * helper surfaces both alongside the message so a toast reads cleanly for a
 * learner yet still lets a developer identify the cause from a screenshot.
 *
 * Tolerant of any input — `data` may be absent (a non-tRPC error) and the
 * input may not be an `Error` at all. The helper never throws.
 *
 * @param err - The error thrown by a tRPC mutation, or anything else.
 * @returns A single-line description, e.g.
 *   `"HTTP 429 · TOO_MANY_REQUESTS — Rate limit exceeded"`. Falls back to the
 *   bare message when no code/status is present.
 */
export function formatMutationError(err: unknown): string {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error";

  // tRPC client errors expose a `data` object. Read it defensively — a plain
  // Error has none, and the formatter must never throw on unexpected shapes.
  const data = readProp(err, "data");
  const httpStatus = readProp(data, "httpStatus");
  const code = readProp(data, "code");

  const tags = [
    typeof httpStatus === "number" ? `HTTP ${httpStatus}` : null,
    typeof code === "string" ? code : null,
  ].filter((tag): tag is string => tag !== null);

  return tags.length > 0 ? `${tags.join(" · ")} — ${message}` : message;
}

/** Read a property off an unknown value, or `undefined` if it is not an object. */
function readProp(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run src/lib/errors.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/errors.ts src/lib/errors.test.ts
git commit -m "feat(errors): add formatMutationError helper"
```

---

## Task 3: `parseQuestionnaireBuffer` pure helper

A pure, Zod-validated parser for the questionnaire buffer persisted in
localStorage. Replaces the inline parse currently in `Composer.tsx` (used in
Task 4) and is the foundation of the localStorage restore-bug fix.

**Files:**

- Create: `src/lib/course/parseQuestionnaireBuffer.ts`
- Test: `src/lib/course/parseQuestionnaireBuffer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/course/parseQuestionnaireBuffer.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseQuestionnaireBuffer } from "./parseQuestionnaireBuffer";

const KEY = "q1|q2";

describe("parseQuestionnaireBuffer", () => {
  it("restores a well-formed buffer including drafts", () => {
    const raw = JSON.stringify({
      questionsKey: KEY,
      answers: ["A", null],
      step: 1,
      drafts: ["draft one", ""],
    });
    expect(parseQuestionnaireBuffer(raw, KEY, 2)).toEqual({
      answers: ["A", null],
      step: 1,
      drafts: ["draft one", ""],
    });
  });

  it("defaults drafts to blanks when the buffer predates the feature", () => {
    const raw = JSON.stringify({ questionsKey: KEY, answers: [null, null], step: 0 });
    expect(parseQuestionnaireBuffer(raw, KEY, 2)).toEqual({
      answers: [null, null],
      step: 0,
      drafts: ["", ""],
    });
  });

  it("returns null when the questionsKey does not match", () => {
    const raw = JSON.stringify({ questionsKey: "other", answers: [null], step: 0 });
    expect(parseQuestionnaireBuffer(raw, KEY, 1)).toBeNull();
  });

  it("returns null when the answers length does not match", () => {
    const raw = JSON.stringify({ questionsKey: KEY, answers: [null], step: 0 });
    expect(parseQuestionnaireBuffer(raw, KEY, 2)).toBeNull();
  });

  it("returns null when step is out of range", () => {
    const raw = JSON.stringify({ questionsKey: KEY, answers: [null, null], step: 5 });
    expect(parseQuestionnaireBuffer(raw, KEY, 2)).toBeNull();
  });

  it("returns null when drafts length does not match", () => {
    const raw = JSON.stringify({
      questionsKey: KEY,
      answers: [null, null],
      step: 0,
      drafts: ["only one"],
    });
    expect(parseQuestionnaireBuffer(raw, KEY, 2)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseQuestionnaireBuffer("{not json", KEY, 2)).toBeNull();
  });

  it("returns null for a null or empty raw value", () => {
    expect(parseQuestionnaireBuffer(null, KEY, 2)).toBeNull();
    expect(parseQuestionnaireBuffer("", KEY, 2)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/lib/course/parseQuestionnaireBuffer.test.ts`
Expected: FAIL — cannot resolve `./parseQuestionnaireBuffer`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/course/parseQuestionnaireBuffer.ts`:

```typescript
import { z } from "zod";

/** Per-question state restored from a persisted questionnaire buffer. */
export interface QuestionnaireBuffer {
  /** Recorded answers, indexed by question; `null` for an unanswered question. */
  readonly answers: readonly (string | null)[];
  /** The question index the learner was last on. */
  readonly step: number;
  /** Per-question free-text drafts, indexed by question. */
  readonly drafts: readonly string[];
}

// The on-disk shape. `drafts` is optional: buffers written before the
// free-text-draft feature lack it.
const bufferSchema = z.object({
  questionsKey: z.string(),
  answers: z.array(z.string().nullable()),
  step: z.number(),
  drafts: z.array(z.string()).optional(),
});

/**
 * Parse a persisted questionnaire buffer from its raw localStorage string.
 *
 * Returns the restored state only when the buffer is well-formed AND matches
 * the current question set — same `questionsKey`, same length, in-range `step`.
 * Returns `null` for any mismatch, malformed JSON, or `null`/empty input.
 * localStorage is an untrusted boundary, so the parse never throws.
 *
 * `drafts` is defaulted to blank strings when the persisted buffer predates
 * the free-text-draft feature.
 *
 * @param raw - The raw string from `localStorage.getItem`, or `null`.
 * @param questionsKey - Identity of the currently-active question set.
 * @param questionCount - Number of questions currently active.
 * @returns The restored buffer, or `null` if it cannot be safely restored.
 */
export function parseQuestionnaireBuffer(
  raw: string | null,
  questionsKey: string,
  questionCount: number,
): QuestionnaireBuffer | null {
  if (raw === null || raw === "") return null;

  const json = safeJsonParse(raw);
  if (json === undefined) return null;

  const parsed = bufferSchema.safeParse(json);
  if (!parsed.success) return null;

  const buffer = parsed.data;
  // Reject a buffer that belongs to a different question set or has drifted
  // out of sync with the current question count.
  if (buffer.questionsKey !== questionsKey) return null;
  if (buffer.answers.length !== questionCount) return null;
  if (buffer.step < 0 || buffer.step >= questionCount) return null;
  if (buffer.drafts && buffer.drafts.length !== questionCount) return null;

  return {
    answers: buffer.answers,
    step: buffer.step,
    drafts: buffer.drafts ?? Array.from({ length: questionCount }, () => ""),
  };
}

/** `JSON.parse` that returns `undefined` instead of throwing on bad input. */
function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run src/lib/course/parseQuestionnaireBuffer.test.ts`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/course/parseQuestionnaireBuffer.ts src/lib/course/parseQuestionnaireBuffer.test.ts
git commit -m "feat(course): add parseQuestionnaireBuffer helper"
```

---

## Task 4: Composer — per-step free-text drafts + merged init effect

Issue 4: free-text answers are lost when navigating back through a
questionnaire. Q3 (localStorage bug): the hydrate effect's restore is clobbered
by the persist and reset effects. Both are fixed here, in `Composer.tsx`.

No unit-test harness exists for the Composer. Verification is `just typecheck`,
`just lint`, `just test`. Each step below is a single precise edit; the file
will only fully typecheck after the last edit.

**Files:**

- Modify: `src/components/chat/Composer.tsx`

- [ ] **Step 1: Import the buffer parser**

**Find:**

```typescript
import { calculateMcXp } from "@/lib/scoring/xp";
```

**Replace with:**

```typescript
import { calculateMcXp } from "@/lib/scoring/xp";
import { parseQuestionnaireBuffer } from "@/lib/course/parseQuestionnaireBuffer";
```

- [ ] **Step 2: Add a module-level `safeGetItem` helper**

**Find:**

```typescript
export type { ChoiceQuestion } from "@/lib/course/adaptQuestionnaire";
import type { ChoiceQuestion } from "@/lib/course/adaptQuestionnaire";
```

**Replace with:**

```typescript
export type { ChoiceQuestion } from "@/lib/course/adaptQuestionnaire";
import type { ChoiceQuestion } from "@/lib/course/adaptQuestionnaire";

/** Read a localStorage key, returning null if storage is unavailable. */
function safeGetItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Add the `drafts` state**

**Find:**

```typescript
const [answers, setAnswers] = useState<(string | null)[]>([]);
const [step, setStep] = useState(0);
```

**Replace with:**

```typescript
const [answers, setAnswers] = useState<(string | null)[]>([]);
// Per-question free-text drafts, indexed alongside `questions`. Free-text
// answers stay editable on revisit (unlike MC, which locks on confirm), so
// their text lives here rather than in the single parent-owned `value`.
const [drafts, setDrafts] = useState<string[]>([]);
const [step, setStep] = useState(0);
```

- [ ] **Step 4: Add the `inputValue` / `setInputValue` binding**

This goes immediately after the `locked` state declaration, before the effects,
so the autosize effect (Step 6) can depend on `inputValue`.

**Find:**

```typescript
// While true, the option grid is locked (during the pulse).
const [locked, setLocked] = useState(false);
```

**Replace with:**

```typescript
// While true, the option grid is locked (during the pulse).
const [locked, setLocked] = useState(false);

// The textarea's value: a per-question draft while a questionnaire is
// active, otherwise the parent-owned chat-input string. `setInputValue`
// routes writes to the matching store.
const inputValue = hasQuestions ? (drafts[step] ?? "") : value;
const setInputValue = (v: string) => {
  if (hasQuestions) {
    const next = [...drafts];
    next[step] = v;
    setDrafts(next);
  } else {
    onChange(v);
  }
};
```

- [ ] **Step 5: Replace the three effects (hydrate / persist / reset) with two**

**Find** (the entire block — comment, hydrate effect, persist effect, reset effect):

```typescript
// Hydrate persisted answers/step from localStorage on mount or when persistKey
// changes. SSR-safe.
useEffect(() => {
  if (!persistKey || typeof window === "undefined" || !hasQuestions) return;
  try {
    const raw = window.localStorage.getItem(persistKey);
    if (!raw) return;
    const parsed = JSON.parse(raw) as {
      readonly questionsKey?: string;
      readonly answers?: (string | null)[];
      readonly step?: number;
    };
    if (parsed.questionsKey !== questionsKey) return;
    if (parsed.answers && parsed.answers.length === questions!.length) {
      setAnswers(parsed.answers);
    }
    if (typeof parsed.step === "number" && parsed.step >= 0 && parsed.step < questions!.length) {
      setStep(parsed.step);
    }
  } catch {
    // Malformed buffer — ignore.
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [persistKey, questionsKey]);

useEffect(() => {
  if (!persistKey || typeof window === "undefined" || !hasQuestions) return;
  try {
    window.localStorage.setItem(persistKey, JSON.stringify({ questionsKey, answers, step }));
  } catch {
    // Quota / disabled — ignore.
  }
}, [persistKey, questionsKey, answers, step, hasQuestions]);

useEffect(() => {
  if (hasQuestions) {
    setAnswers(Array(questions!.length).fill(null));
    setPending(Array(questions!.length).fill(null));
    setFeedback(Array(questions!.length).fill(null));
    setStep(0);
    setSlideDir("none");
    setLocked(false);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [questionsKey]);
```

**Replace with:**

```typescript
// Initialise per-question state whenever the question set changes. Tries to
// restore a persisted buffer (refresh-resilient); falls back to blank.
//
// This is ONE effect by design. It was formerly two — a hydrate effect and a
// reset effect — and React ran the reset second, so its blank fill clobbered
// the hydrate's restore. Merging removes the ordering bug: restore-or-blank
// is now a single decision. SSR-safe.
useEffect(() => {
  if (!hasQuestions) return;
  const len = questions!.length;
  const restored = parseQuestionnaireBuffer(
    persistKey && typeof window !== "undefined" ? safeGetItem(persistKey) : null,
    questionsKey,
    len,
  );
  setAnswers(restored ? [...restored.answers] : Array(len).fill(null));
  setDrafts(restored ? [...restored.drafts] : Array(len).fill(""));
  setStep(restored ? restored.step : 0);
  setPending(Array(len).fill(null));
  setFeedback(Array(len).fill(null));
  setSlideDir("none");
  setLocked(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [questionsKey]);

// Persist the questionnaire buffer to localStorage on every change. Defined
// AFTER the init effect so that, on mount, init reads localStorage before
// this writes — the restore is never lost. SSR-safe.
useEffect(() => {
  if (!persistKey || typeof window === "undefined" || !hasQuestions) return;
  try {
    window.localStorage.setItem(
      persistKey,
      JSON.stringify({ questionsKey, answers, step, drafts }),
    );
  } catch {
    // Quota / disabled — ignore.
  }
}, [persistKey, questionsKey, answers, step, drafts, hasQuestions]);
```

- [ ] **Step 6: Point the autosize effect at `inputValue`**

**Find:**

```typescript
useEffect(() => {
  const el = ref.current;
  if (!el) return;
  el.style.height = "0px";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}, [value]);
```

**Replace with:**

```typescript
useEffect(() => {
  const el = ref.current;
  if (!el) return;
  el.style.height = "0px";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}, [inputValue]);
```

- [ ] **Step 7: Switch `canSend` / `confirmMode` to `inputValue`, add the free-text lock derivation**

**Find:**

```typescript
const canSend = value.trim().length > 0 && !disabled;
const currentPending = hasQuestions ? (pending[step] ?? null) : null;
const hasPending = currentPending != null;
// A step is locked once it has a recorded answer — its option can no longer
// be changed and no answer can be resubmitted for it.
const stepLocked = hasQuestions && answers[step] != null;
// "Confirm" mode: question is active, user picked an option, no free text,
// and the step is not already locked.
const confirmMode = hasQuestions && hasPending && !stepLocked && value.trim().length === 0;

const current = hasQuestions ? questions![step] : null;
const total = hasQuestions ? questions!.length : 0;
```

**Replace with:**

```typescript
const canSend = inputValue.trim().length > 0 && !disabled;
const currentPending = hasQuestions ? (pending[step] ?? null) : null;
const hasPending = currentPending != null;
// A step is locked once it has a recorded answer — its option can no longer
// be changed and no answer can be resubmitted for it.
const stepLocked = hasQuestions && answers[step] != null;
// "Confirm" mode: question is active, user picked an option, no free text,
// and the step is not already locked.
const confirmMode = hasQuestions && hasPending && !stepLocked && inputValue.trim().length === 0;

const current = hasQuestions ? questions![step] : null;
const total = hasQuestions ? questions!.length : 0;

// A free-text question (no options) never locks its textarea — its answer
// stays editable on revisit. MC questions still lock on confirm.
const currentIsFreeText = !!current && current.options.length === 0;
const textareaLocked = stepLocked && !currentIsFreeText;
```

- [ ] **Step 8: Read drafts for free-text questions at completion**

**Find:**

```typescript
onComplete?.(questions!.map((q, i) => ({ question: q, answer: next[i]! })));
```

**Replace with:**

```typescript
onComplete?.(
  questions!.map((q, i) => ({
    question: q,
    // Free-text questions stay editable, so the live draft — not the
    // answer recorded at send time — is the source of truth, picking up
    // any back-edits. Fall back to the recorded answer if the draft was
    // blanked. MC questions use the recorded option text.
    answer: q.options.length === 0 ? drafts[i]?.trim() || next[i]! : next[i]!,
  })),
);
```

- [ ] **Step 9: Stop clearing the draft on a free-text send**

**Find:**

```typescript
if (hasQuestions) {
  const answer = value.trim();
  onChange("");
  // Typing a free-text answer counts as the chosen answer for this step.
  clearPending();
  advanceAfterAnswer(answer);
} else {
  onSend();
}
```

**Replace with:**

```typescript
if (hasQuestions) {
  const answer = inputValue.trim();
  // Keep the draft — a free-text answer stays editable on revisit.
  clearPending();
  advanceAfterAnswer(answer);
} else {
  onSend();
}
```

- [ ] **Step 10: Bind the textarea to `inputValue` / `setInputValue` / `textareaLocked`**

**Find:**

```typescript
        <textarea
          ref={ref}
          rows={1}
          value={value}
          disabled={stepLocked}
          onChange={(e) => {
            if (e.target.value.length > 0) clearPending();
            onChange(e.target.value);
          }}
```

**Replace with:**

```typescript
        <textarea
          ref={ref}
          rows={1}
          value={inputValue}
          disabled={textareaLocked}
          onChange={(e) => {
            if (e.target.value.length > 0) clearPending();
            setInputValue(e.target.value);
          }}
```

- [ ] **Step 11: Typecheck**

Run: `just typecheck`
Expected: PASS — no errors. (If `value` or `onChange` is reported unused, a
binding was missed — both are still used via `inputValue`/`setInputValue`.)

- [ ] **Step 12: Lint and unit tests**

Run: `just lint && just test`
Expected: lint clean (no `no-let` / `react-hooks/exhaustive-deps` violations);
all unit tests pass.

- [ ] **Step 13: Commit**

```bash
git add src/components/chat/Composer.tsx
git commit -m "fix(composer): keep freetext editable on back-nav and fix questionnaire restore"
```

---

## Task 5: useScopingState — error toasts on the scoping mutations

Issue 8: `generateFramework`, `generateBaseline` and `submitBaseline` have no
`onError` — failures are silent. Add toasts carrying the error code.

**Files:**

- Modify: `src/hooks/useScopingState.ts`

- [ ] **Step 1: Add the `toast` and `formatMutationError` imports**

**Find:**

```typescript
import { useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
```

**Replace with:**

```typescript
import { useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc";
import { formatMutationError } from "@/lib/errors";
```

- [ ] **Step 2: Add `onError` to `generateFramework` and `submitBaseline`**

**Find:**

```typescript
const generateFramework = useMutation(
  trpc.course.generateFramework.mutationOptions({ onSuccess: invalidateState }),
);
const generateBaseline = useMutation(
  trpc.course.generateBaseline.mutationOptions({ onSuccess: invalidateState }),
);
const submitBaseline = useMutation(
  trpc.course.submitBaseline.mutationOptions({ onSuccess: invalidateState }),
);
```

**Replace with:**

```typescript
const generateFramework = useMutation(
  trpc.course.generateFramework.mutationOptions({
    onSuccess: invalidateState,
    onError: (err) => {
      toast.error("Couldn't build your course outline", {
        description: formatMutationError(err),
      });
    },
  }),
);
const generateBaseline = useMutation(
  trpc.course.generateBaseline.mutationOptions({ onSuccess: invalidateState }),
);
const submitBaseline = useMutation(
  trpc.course.submitBaseline.mutationOptions({
    onSuccess: invalidateState,
    onError: (err) => {
      toast.error("Couldn't save your answers", {
        description: formatMutationError(err),
      });
    },
  }),
);
```

- [ ] **Step 3: Add the toast to `generateBaseline`'s per-call `onError`**

`generateBaseline` is auto-dispatched; its per-call `onError` already clears the
dispatch guard. Add the toast alongside it.

**Find:**

```typescript
        {
          // Clear the guard on error so a user retry (refetch/remount) can fire
          // again. Without this, a single LLM failure would suppress baseline
          // generation for this course until the page is fully reloaded.
          onError: () => {
            if (baselineDispatchedFor.current === dispatchedCourseId) {
              baselineDispatchedFor.current = null;
            }
          },
        },
```

**Replace with:**

```typescript
        {
          // Clear the guard on error so a user retry (refetch/remount) can fire
          // again. Without this, a single LLM failure would suppress baseline
          // generation for this course until the page is fully reloaded.
          onError: (err) => {
            if (baselineDispatchedFor.current === dispatchedCourseId) {
              baselineDispatchedFor.current = null;
            }
            toast.error("Couldn't create your baseline quiz", {
              description: formatMutationError(err),
            });
          },
        },
```

- [ ] **Step 4: Typecheck, lint, test**

Run: `just typecheck && just lint && just test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useScopingState.ts
git commit -m "fix(scoping): surface scoping mutation errors as toasts"
```

---

## Task 6: Error codes in the existing turn / topic toasts

Issue 8: `useWaveState`'s `submitTurn` and `TopicInput`'s `clarify` already
toast on error but surface only `err.message`. Route both through
`formatMutationError` so the error code appears.

**Files:**

- Modify: `src/hooks/useWaveState.ts`
- Modify: `src/components/chat/TopicInput.tsx`

- [ ] **Step 1: Import `formatMutationError` in `useWaveState.ts`**

**Find:**

```typescript
import { useTRPC } from "@/lib/trpc";
import { deriveWaveTurns } from "@/lib/course/deriveWaveTurns";
```

**Replace with:**

```typescript
import { useTRPC } from "@/lib/trpc";
import { formatMutationError } from "@/lib/errors";
import { deriveWaveTurns } from "@/lib/course/deriveWaveTurns";
```

- [ ] **Step 2: Route the `submitTurn` toast through `formatMutationError`**

**Find:**

```typescript
      onError: (err) => {
        toast.error("Couldn't submit that turn", { description: err.message });
      },
```

**Replace with:**

```typescript
      onError: (err) => {
        toast.error("Couldn't submit that turn", {
          description: formatMutationError(err),
        });
      },
```

- [ ] **Step 3: Import `formatMutationError` in `TopicInput.tsx`**

**Find:**

```typescript
import { useTRPC } from "@/lib/trpc";
import { ChatShell } from "./ChatShell";
```

**Replace with:**

```typescript
import { useTRPC } from "@/lib/trpc";
import { formatMutationError } from "@/lib/errors";
import { ChatShell } from "./ChatShell";
```

- [ ] **Step 4: Route the `clarify` toast through `formatMutationError`**

The drop-the-optimistic-topic behaviour (`setSubmittedTopic(null)`) is
intentional and stays — only the description changes.

**Find:**

```typescript
      onError: (err) => {
        toast.error("Couldn't start your course", { description: err.message });
        // Submission failed — drop the optimistic view so the learner can retry.
        setSubmittedTopic(null);
      },
```

**Replace with:**

```typescript
      onError: (err) => {
        toast.error("Couldn't start your course", {
          description: formatMutationError(err),
        });
        // Submission failed — drop the optimistic view so the learner can retry.
        setSubmittedTopic(null);
      },
```

- [ ] **Step 5: Typecheck, lint, test**

Run: `just typecheck && just lint && just test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useWaveState.ts src/components/chat/TopicInput.tsx
git commit -m "fix(chat): include error codes in turn and topic error toasts"
```

---

## Task 7: Onboarding — optimistic-bubble snapshot + dismiss questionnaire

Issues 5, 6, 8 in `Onboarding.tsx`:

- 5: the question card lingers in the Composer after submit.
- 6: a duplicate optimistic bubble appears during the framework→baseline gap.
- 8: the optimistic bubble vanishes on error.

The optimistic bubble is re-gated on a `turns.length` snapshot instead of
`isPending`; a `dismissedKey` hides the submitted question card at once.

**Files:**

- Modify: `src/components/chat/Onboarding.tsx`

- [ ] **Step 1: Replace `pendingMessage` state with `optimistic` + `dismissedKey`**

**Find:**

```typescript
const [composerValue, setComposerValue] = useState("");
// Optimistic user message — see WaveSession for the rationale.
const [pendingMessage, setPendingMessage] = useState<string | null>(null);
```

**Replace with:**

```typescript
const [composerValue, setComposerValue] = useState("");
// Optimistic user message. `turnCountAtSubmit` is the `turns.length` captured
// at submit: the bubble shows while `turns` has not grown past it (server
// round-trip not yet landed, or it failed) and hides the instant the real
// turn appears. This prevents a duplicate during the framework→baseline gap
// (the real turn lands while baseline is still dispatching) and keeps the
// bubble visible on error.
const [optimistic, setOptimistic] = useState<{
  readonly content: string;
  readonly turnCountAtSubmit: number;
} | null>(null);
// The questionnaire key just submitted — its question card is hidden from the
// Composer immediately, rather than lingering until the server round-trip.
const [dismissedKey, setDismissedKey] = useState<string | null>(null);
```

- [ ] **Step 2: Gate the Composer's `questions` prop on `dismissedKey`**

**Find:**

```typescript
          questions={activeQuestionnaire ? [...activeQuestionnaire.questions] : null}
```

**Replace with:**

```typescript
          questions={
            activeQuestionnaire && activeQuestionnaire.questionsKey !== dismissedKey
              ? [...activeQuestionnaire.questions]
              : null
          }
```

- [ ] **Step 3: Update `onComplete` to snapshot turns and dismiss the card**

**Find:**

```typescript
          onComplete={(answers) => {
            if (!activeQuestionnaire) return;
            // Render the submitted answers optimistically before the server
            // round-trip lands. Domain-shape mappers live in `src/lib/course/`
            // so this component stays a thin rendering shell.
            setPendingMessage(formatComposerAnswers(answers));
            if (activeQuestionnaire.kind === "clarify") {
              submitClarify(shapeClarifyAnswers(answers));
            } else {
              submitBaselineAnswers(shapeQuestionnaireAnswers(answers));
            }
          }}
```

**Replace with:**

```typescript
          onComplete={(answers) => {
            if (!activeQuestionnaire) return;
            // Render the submitted answers optimistically before the server
            // round-trip lands, and dismiss the question card from the Composer
            // at once. Domain-shape mappers live in `src/lib/course/` so this
            // component stays a thin rendering shell.
            setOptimistic({
              content: formatComposerAnswers(answers),
              turnCountAtSubmit: turns.length,
            });
            setDismissedKey(activeQuestionnaire.questionsKey);
            if (activeQuestionnaire.kind === "clarify") {
              submitClarify(shapeClarifyAnswers(answers));
            } else {
              submitBaselineAnswers(shapeQuestionnaireAnswers(answers));
            }
          }}
```

- [ ] **Step 4: Gate the optimistic bubble on the turn-count snapshot**

**Find:**

```typescript
      {scroll}
      {isPending && pendingMessage && (
        <MessageBubble message={{ id: "pending", role: "user", content: pendingMessage }} />
      )}
      {isPending && <TypingBubble />}
```

**Replace with:**

```typescript
      {scroll}
      {optimistic && turns.length === optimistic.turnCountAtSubmit && (
        <MessageBubble
          message={{ id: "pending", role: "user", content: optimistic.content }}
        />
      )}
      {isPending && <TypingBubble />}
```

- [ ] **Step 5: Typecheck, lint, test**

Run: `just typecheck && just lint && just test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/components/chat/Onboarding.tsx
git commit -m "fix(scoping): dedup optimistic bubble and dismiss questionnaire on submit"
```

---

## Task 8: WaveSession — optimistic-bubble snapshot + dismiss questionnaire

The same three fixes (issues 5, 6, 8) in `WaveSession.tsx`. WaveSession has two
submit paths — free-text `onSend` and questionnaire `onComplete` — both snapshot
the turn count.

**Files:**

- Modify: `src/components/chat/WaveSession.tsx`

- [ ] **Step 1: Replace `pendingMessage` state with `optimistic` + `dismissedKey`**

**Find:**

```typescript
const [composerValue, setComposerValue] = useState("");
// Optimistic user message: rendered immediately on submit so the learner's
// input appears at once, before the server round-trip. Only shown while a
// turn is in flight; once `isPending` clears, the refetched `turns` already
// contain the real entry, so a stale value here is simply not rendered.
const [pendingMessage, setPendingMessage] = useState<string | null>(null);
```

**Replace with:**

```typescript
const [composerValue, setComposerValue] = useState("");
// Optimistic user message. `turnCountAtSubmit` is the `turns.length` captured
// at submit: the bubble shows while `turns` has not grown past it (server
// round-trip not yet landed, or it failed) and hides the instant the real
// turn appears — so it never duplicates the real turn, and it survives an
// error rather than vanishing with `isPending`.
const [optimistic, setOptimistic] = useState<{
  readonly content: string;
  readonly turnCountAtSubmit: number;
} | null>(null);
// The questionnaire key just submitted — its question card is hidden from the
// Composer immediately, rather than lingering until the server round-trip.
const [dismissedKey, setDismissedKey] = useState<string | null>(null);
```

- [ ] **Step 2: Snapshot the turn count in the free-text `onSend` path**

**Find:**

```typescript
          onSend={() => {
            // Free-text send path: submit chat-text turn. Composer-side guard
            // already filters empty strings (it disables the send button).
            const text = composerValue.trim();
            if (text.length === 0) return;
            setPendingMessage(text);
            submitChatText(text);
            setComposerValue("");
          }}
```

**Replace with:**

```typescript
          onSend={() => {
            // Free-text send path: submit chat-text turn. Composer-side guard
            // already filters empty strings (it disables the send button).
            const text = composerValue.trim();
            if (text.length === 0) return;
            setOptimistic({ content: text, turnCountAtSubmit: turns.length });
            submitChatText(text);
            setComposerValue("");
          }}
```

- [ ] **Step 3: Gate the Composer's `questions` prop on `dismissedKey`**

**Find:**

```typescript
          questions={activeQuestionnaire ? [...activeQuestionnaire.questions] : null}
```

**Replace with:**

```typescript
          questions={
            activeQuestionnaire && activeQuestionnaire.questionsKey !== dismissedKey
              ? [...activeQuestionnaire.questions]
              : null
          }
```

- [ ] **Step 4: Update `onComplete` to snapshot turns and dismiss the card**

**Find:**

```typescript
          onComplete={(answers) => {
            if (!activeQuestionnaire) return;
            // Domain-shape mapper lives in `src/lib/` so this component stays
            // a thin rendering shell.
            setPendingMessage(formatComposerAnswers(answers));
            submitQuestionnaireAnswers(shapeQuestionnaireAnswers(answers));
          }}
```

**Replace with:**

```typescript
          onComplete={(answers) => {
            if (!activeQuestionnaire) return;
            // Optimistic bubble + dismiss the question card at once. Domain-shape
            // mapper lives in `src/lib/` so this component stays a thin shell.
            setOptimistic({
              content: formatComposerAnswers(answers),
              turnCountAtSubmit: turns.length,
            });
            setDismissedKey(activeQuestionnaire.questionsKey);
            submitQuestionnaireAnswers(shapeQuestionnaireAnswers(answers));
          }}
```

- [ ] **Step 5: Gate the optimistic bubble on the turn-count snapshot**

**Find:**

```typescript
      {scroll}
      {isPending && pendingMessage && (
        <MessageBubble message={{ id: "pending", role: "user", content: pendingMessage }} />
      )}
      {isPending && <TypingBubble />}
```

**Replace with:**

```typescript
      {scroll}
      {optimistic && turns.length === optimistic.turnCountAtSubmit && (
        <MessageBubble
          message={{ id: "pending", role: "user", content: optimistic.content }}
        />
      )}
      {isPending && <TypingBubble />}
```

- [ ] **Step 6: Typecheck, lint, test**

Run: `just typecheck && just lint && just test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/components/chat/WaveSession.tsx
git commit -m "fix(wave): dedup optimistic bubble and dismiss questionnaire on submit"
```

---

## Task 9: Full verification and commit the status docs

Final gate across the whole batch, plus committing the untracked session
handoffs (the user asked for a fully clean tree).

**Files:**

- Commit only: `docs/status/`

- [ ] **Step 1: Run the full check suite**

Run: `just check`
Expected: format-check, lint, typecheck, unit tests and integration tests all
pass. (`just check` runs `test-int`, which boots a Postgres testcontainer and
needs Docker. If Docker is unavailable, run `just lint && just typecheck && just test`
instead and note that integration tests were skipped.)

- [ ] **Step 2: Run a production build**

Run: `just build`
Expected: build succeeds. (Per parent-batch Discovery 1, the Turbopack `root`
is pinned to this worktree — `just build` must be run from the worktree, which
it is.)

- [ ] **Step 3: Commit the session status docs**

```bash
git add docs/status/
git commit -m "docs: add session status handoffs for ui-qa-fixes"
```

- [ ] **Step 4: Confirm a clean tree**

Run: `git status --short`
Expected: empty output — everything committed.

- [ ] **Step 5: Review the commit series**

Run: `git log --oneline main..HEAD`
Expected: the spec commit, the Task 1 commits, and one commit per Task 2–9 —
all present, all conventional-commit subjects.

---

## Notes for the implementer

- **Manual verification is recommended** after Task 8: run `just dev` (needs
  Touch ID for the 1Password-injected env) and walk the scoping flow — submit
  clarify answers, watch for a single optimistic bubble through the
  framework→baseline gap; navigate a questionnaire back and forth to confirm
  free-text persists; submit a questionnaire and confirm the card disappears at
  once. This is a check, not a gate — the automated gate is Task 9.
- **PR creation is a separate, user-authorised step.** Do not open a PR as part
  of executing this plan.
- Issues 1/2/3/7 are committed in Task 1, already implemented. Issues 4/5/6/8
  and the localStorage bug are Tasks 2–8.

---

## Self-Review

**Spec coverage:**

- Issue 1/2/3 (Splash copy) → Task 1. ✓
- Issue 7 (scroll bob) → Task 1. ✓
- Issue 4 (freetext back-nav) → Task 4 (drafts, `textareaLocked`, `onComplete`
  draft read, `handleSend` no-clear). ✓
- Issue 5 (lingering card) → Tasks 7 & 8 (`dismissedKey`). ✓
- Issues 6 + 8 (optimistic bubble) → Tasks 7 & 8 (`turns.length` snapshot). ✓
- Issue 8 (error surfacing) → Tasks 2, 5, 6 (`formatMutationError`, scoping
  `onError`s, existing-toast routing). ✓
- localStorage bug (Q3) → Tasks 3 & 4 (`parseQuestionnaireBuffer`, merged init
  effect). ✓
- GH issues #15/#16 → already filed. ✓
- settings.json committed → Task 1; status docs → Task 9. ✓

**Placeholder scan:** No TBD/TODO. Every code step shows complete code. Test
steps show full test code.

**Type consistency:** `formatMutationError(err: unknown): string` — call sites
(Tasks 5, 6) pass tRPC-typed errors into the `unknown` param. ✓
`parseQuestionnaireBuffer(raw, questionsKey, count)` → `QuestionnaireBuffer | null`;
Task 4 spreads `restored.answers` / `restored.drafts` into mutable arrays for
`setAnswers` / `setDrafts`. ✓ The `optimistic` object shape
`{ content: string; turnCountAtSubmit: number }` is identical in Tasks 7 and 8.
✓ `setDrafts` / `drafts` / `setInputValue` / `inputValue` / `textareaLocked` /
`currentIsFreeText` names are consistent across Task 4 steps. ✓
