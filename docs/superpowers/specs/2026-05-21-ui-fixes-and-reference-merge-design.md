# UI fixes + kanagawa-whispers reference merge — design

**Date:** 2026-05-21
**Status:** approved (design); pending implementation plan
**Scope:** six UI-layer changes — four feature ports from the reference UI repo
(`../kanagawa-whispers`), two bug fixes. No server business-logic changes beyond
two read-only wire projections.

---

## Context

`../kanagawa-whispers` is the reference UI prototype (TanStack Start; Nalu is
Next.js 16.2). Nalu's `src/components/chat/` is a parity port of it. The
reference repo received 13 new commits on `origin/main` (HEAD `6f9de2e`) that
Nalu has not yet absorbed. This spec ports four of those features and fixes two
standing Nalu bugs.

The reference repo's working tree is 13 commits behind `origin/main`; it should
be fast-forwarded (`git -C ../kanagawa-whispers merge --ff-only origin/main`) so
future re-syncs diff cleanly. That is a housekeeping step, not a code change.

### Decisions taken during brainstorming

- **Splash timing:** shown on **every visit to the home screen** (no
  localStorage/sessionStorage gate).
- **Submission-hang fix scope:** **everywhere**, including the home topic box.
- **XP tracker source:** a **client-side, per-course session counter**
  (localStorage-backed). Nalu's server XP accounting is left untouched.
- **MC XP amount:** computed **exactly** client-side via the existing pure
  `calculateMcXp` — not a flat placeholder. See Feature 3.
- **Optimistic mechanism:** component-local pending-message state, not React
  Query `onMutate` cache mutation. Simpler; no synthetic chat-log entry for the
  `deriveTurns`/`deriveWaveTurns` projections to tolerate; auto-reconciles when
  real data lands.

---

## Feature 1 — Splash screen

**New file:** `src/components/chat/Splash.tsx`

Port of `kanagawa-whispers@origin/main:src/components/chat/Splash.tsx`. A
full-screen `fixed inset-0 z-50` intro overlay: WIP badge, "Hi, I'm Ollie —
welcome to nalu" headline, three intro paragraphs, a "Start learning" CTA, and a
footer line. Copy is kept verbatim from the reference.

Adaptations for the Nalu stack:

- Replace the reference's shadcn `<Button>` import (Nalu has no `ui/button`)
  with a plain `<button>` styled like the existing `moveOn` button in
  `Composer.tsx` (`bg-spring-green text-sumi-0 rounded-2xl`, `h-12`).
- The reference uses `animate-in fade-in duration-500` (tw-animate-css, which
  Nalu does not have). Add a `fade-in` keyframe + `.animate-fade-in` utility to
  `globals.css`.
- Reuse Nalu's existing `.bg-kanagawa-atmos`, `.noise`, `.shadow-glow`.
- `"use client"` (it owns an `onClick`).

**Mount point:** `TopicInput.tsx`. `const [showSplash, setShowSplash] =
useState(true)`; render `{showSplash && <Splash onStart={() =>
setShowSplash(false)} />}`. `TopicInput` remounts on every navigation to `/`, so
`useState(true)` yields "every visit to home".

---

## Feature 2 — Lock answered questionnaire steps (no back-up / resubmit)

**Edit:** `src/components/chat/Composer.tsx`

Port the reference's `58631bd` quiz-UX delta on top of Nalu's existing Composer
deltas (`persistKey`, `moveOn`, free-text handling):

- `const stepLocked = hasQuestions && answers[step] != null` — a step is locked
  once it has a recorded answer.
- `confirmMode` gains `&& !stepLocked`.
- `selectOption` and `clearPending` early-return when `answers[step] != null`.
- Option buttons: `disabled` also when `isLockedAnswer` (`answers[step] !=
null`); non-selected options dim to `opacity-40` on a locked step.
- The textarea is `disabled` while `stepLocked`.

Prev/next chevrons are **unchanged** — a learner can still navigate back to
_view_ a locked question, just not change its answer. This matches the reference
exactly.

---

## Feature 3 — XP tracker replacing the toasts

Replaces every XP-related sonner toast with an animated header badge.

### 3a. Animations

Add to `globals.css` (ported from `kanagawa-whispers` `styles.css`):

- `xp-badge-pop` — badge scales up with a green glow, then settles.
- `xp-gain-float` — a "+N XP" floater rises and fades above the badge.

### 3b. `XpBadge` + `ChatHeader`

**Edit:** `src/components/chat/ChatHeader.tsx`

Port the reference's `XpBadge` (a `Sparkles` pill + tabular XP number, with the
`displayed`/pulse landing timing — pre-gain total shown during the pulse, snaps
to the new total at ~520 ms). `ChatHeader` gains optional props: `xp`,
`xpPulseKey`, `xpGainAmount`, `showXp`. Badge renders when `showXp || xp > 0 ||
xpPulseKey > 0`.

**Edit:** `src/components/chat/ChatShell.tsx` — gains the same optional XP props
and passes them straight through to `ChatHeader`.

The badge is shown only in `WaveSession` (XP is earned in waves). `TopicInput`
and `Onboarding` pass no XP props → badge hidden.

### 3c. `useCourseXp` hook

**New file:** `src/hooks/useCourseXp.ts` (+ colocated `useCourseXp.test.ts`).

`useCourseXp(courseId: string)` → `{ xp, pulseKey, gainAmount, addXp(amount) }`.

- Backed by `localStorage` key `nalu:course:{courseId}:xp` (a single integer).
  This makes the counter accumulate across waves within a course and survive
  reload. SSR-safe (guard all `window`/`localStorage` access; lazy-init or
  read-in-effect — follow the pattern already in `Composer.tsx`'s `persistKey`
  hydration).
- `addXp(amount)` — increments `xp`, bumps `pulseKey`, sets `gainAmount =
amount`, writes localStorage. A non-positive `amount` is a no-op.

Trade-off accepted: the counter is client-computed and may drift from the
server's authoritative XP totals. Acceptable for a WIP demo; not a source of
truth.

### 3d. XP wiring — the timing model

Two XP sources, by question type:

- **MC correct → immediate, client-side, exact.** When the learner confirms a
  correct multiple-choice answer, XP lands at once. The amount is the exact
  `calculateMcXp(tier, true)` from `src/lib/scoring/xp.ts` — a pure function
  (`import`s only `zod` + the `XP` tuning config; client-safe). This replaces
  the Composer's `toast.success("10 XP Gained")` placeholder.
  `calculateMcXp(tier, true) = tier × XP.basePerTier × XP.mcCorrectMultiplier =
tier × 10`. `calculateMcXp`'s own docstring designates this exact path
  ("Wave instant-toast path — correctness decoded client-side from
  `correctEnc`"), so this is completing the intended design, not adding to it.

- **Free-text + wave completion → server-authoritative, on round-trip.** When
  `wave.submitTurn` returns, `useWaveState` records XP from the server:
  - `mid-turn`: sum `gradedSignals` where `kind === "free-text"` →
    one `addXp(total)` (one pulse). `mc-index` signals are **skipped** — already
    counted client-side at confirm time, so this avoids double-counting.
  - `close-turn`: `addXp(completionXpAwarded)`.

`useWaveState` stops firing the XP toasts (`+N XP`, `Wave complete: +N XP`). The
non-XP `Tier up → N` toast is **kept**.

### 3e. Sourcing the per-question tier (wire additions)

The client decodes MC `correct` from `correctEnc` already; it needs `tier` to
call `calculateMcXp`. `v3Question` already carries an optional
`tier: number` field — it just is not projected to the client. Project it:

- `WaveQuestionForClient` (`redactWaveChatLog.ts`) — add optional `tier` to both
  variants; `redactWaveChatLog` maps `q.tier` through. The function **stays
  pure** — `tier` is already on the question, no DB read.
- `OpenQuestionForClient` (`redactQuestionnaire.ts`) — add optional `tier` to
  both variants.
- `ChoiceQuestion` (`adaptQuestionnaire.ts`) — add optional `tier`;
  `adaptOpenQuestion` (and `adaptQuestionnaire`) pass it through.

`v3Question.tier` is `.optional()`. If a wave's generated questions do not carry
it, the Composer falls back to the wave's tier (`WaveState.currentTier`, already
on the wire) passed to the Composer as a `waveTier` prop:
`calculateMcXp(question.tier ?? waveTier ?? 1, true)`.

> Implementation note: confirm whether the wave questionnaire generator
> populates `v3Question.tier`. If it never does, the projection is harmless and
> the wave-tier fallback governs — still exact for the wave's own concepts,
> slightly generous for injected lower-tier SM-2 review questions.

### 3f. Ownership

`useWaveState` owns XP: it calls `useCourseXp(courseId)` internally, applies the
server signals in the `submitTurn` `onSuccess`, and returns `xp`, `xpPulseKey`,
`xpGainAmount`, plus a handler the Composer's MC path calls on a correct answer.
`WaveSession` stays a thin shell: it forwards the XP display fields to
`ChatShell` and the MC handler to the `Composer` `onCorrectAnswer` prop.

The Composer determines MC correctness and the applicable tier and invokes the
designated pure function; the exact callback signature (pass tier vs. pass
computed amount) is left to the implementation plan. The architecture rule
"components contain zero logic" is honoured — calling `calculateMcXp` is
_invoking_ `src/lib/` logic, not _containing_ it.

---

## Feature 4 — Course title in the header

`ChatHeader`/`ChatShell` already render a `title` prop; both `Onboarding` and
`WaveSession` currently hardcode `title={null}`.

- **Scoping (`Onboarding`):** `CourseState.topic` already exists. Expose `topic`
  from `useScopingState`; `Onboarding` passes `title={topic}`.
- **Wave (`WaveSession`):** `WaveState` does not carry the topic. Add
  `topic: string` to the `WaveState` projection in `getWaveState.ts` —
  `getWaveState` already fetches the course row for the ownership check, so
  `course.topic` is in hand (one-line add). Expose `topic` from `useWaveState`;
  `WaveSession` passes `title={topic}`.

`wave.getState`'s tRPC output type is inferred from `getWaveState`'s return, so
the new field propagates automatically. `getWaveState` tests need the new field
in their expected shape.

---

## Feature 5 — Optimistic submit (fixes the hang)

Root cause: nothing renders on submit until the full LLM round-trip + refetch
completes — the user's message is derived from server `chatLog`, never shown
optimistically. Fix: render the user's message + typing spinner immediately.

### In-course — `WaveSession.tsx` and `Onboarding.tsx`

- Add local `pendingMessage: string | null` state.
- On submit (chat text, or questionnaire `onComplete`), set `pendingMessage` to
  the user-visible text. For chat text this is the text verbatim. For
  questionnaire answers, build the same text the corresponding `deriveTurns` /
  `deriveWaveTurns` projection renders for a `user-questionnaire-answers` turn —
  reuse that formatter if one is factored out, so the optimistic bubble does not
  visibly change when the real turn lands.
- Render: after the derived `scroll`, when `pendingMessage` is set, render a
  user `<MessageBubble>` followed by `<TypingBubble>`.
- Clear `pendingMessage` via an effect when `isPending` flips back to `false`.
  At that point the refetch has resolved and `turns` already contains the real
  entry — no gap, no flicker. (On error, `isPending` also goes false → the
  optimistic bubble clears and the existing `onError` toast explains.)

### Home — `TopicInput.tsx`

There is no chat to render into until the course exists. Add `submittedTopic:
string | null` state, set on `send`. While `submittedTopic` is set and `clarify`
is pending or succeeded (keep it through `isSuccess` so `EmptyState` does not
flash back before the route changes), render an optimistic view inside
`ChatShell` — a user `<MessageBubble>` (the topic) + `<TypingBubble>` — in place
of `<EmptyState>`. `clarify.onSuccess` still routes to `/course/{id}`.

`MessageBubble` and `TypingBubble` are already exported from `MessageBubble.tsx`.

---

## Feature 6 — Duplicate "or type your own answer"

The phrase appears twice during a questionnaire: above the input (the
`chooseLabel` "choose one · or type your own", and — for free-text questions —
the empty-options fallback `<p>` that echoes `placeholderAnswering`) and inside
the input (the textarea placeholder). Keep only the textarea placeholder.

**`i18n/en.json`:**

- `composer.chooseLabel`: `"choose one · or type your own"` → `"choose one"`.
- Add `composer.placeholderAnswerFree`: `"Type your answer…"`.
- `composer.placeholderAnswering` stays `"Or type your own answer…"`.

**`Composer.tsx`:**

- Remove the empty-options fallback `<p>{placeholderAnswering}</p>`. For a
  free-text question the card body shows only the prompt; the textarea (with its
  placeholder) is the answer field.
- The question-card header label: render the `chooseLabel` ("choose one") only
  when the current question has options (MC). Hide it for a free-text question.
  The counter and prev/next chevrons stay regardless (navigation).
- Placeholder, dynamic by interaction type:
  - no questionnaire, first message → `placeholderFirst`
  - no questionnaire, continuing → `placeholderContinue`
  - MC question active → `placeholderAnswering` ("Or type your own answer…")
  - free-text question active → `placeholderAnswerFree` ("Type your answer…")

---

## Files

**New**

- `src/components/chat/Splash.tsx`
- `src/hooks/useCourseXp.ts` + `src/hooks/useCourseXp.test.ts`

**Edited**

- `src/components/chat/Composer.tsx` — features 2, 3d, 6
- `src/components/chat/ChatHeader.tsx` — feature 3b (`XpBadge`)
- `src/components/chat/ChatShell.tsx` — feature 3b (XP pass-through)
- `src/components/chat/WaveSession.tsx` — features 3, 4, 5
- `src/components/chat/Onboarding.tsx` — features 4, 5
- `src/components/chat/TopicInput.tsx` — features 1, 5
- `src/hooks/useWaveState.ts` — features 3d/3f, 4 (drop XP toasts)
- `src/hooks/useScopingState.ts` — feature 4 (expose `topic`)
- `src/lib/course/getWaveState.ts` — feature 4 (`topic` on `WaveState`)
- `src/lib/course/redactWaveChatLog.ts` — feature 3e (`tier` projection)
- `src/lib/course/redactQuestionnaire.ts` — feature 3e (`tier` on type)
- `src/lib/course/adaptQuestionnaire.ts` — feature 3e (`tier` on `ChoiceQuestion`)
- `src/i18n/en.json` — feature 6
- `src/app/globals.css` — features 1, 3a (keyframes)

**Repo housekeeping:** fast-forward `../kanagawa-whispers` to `origin/main`.

---

## Testing

- `useCourseXp.test.ts` (new) — `addXp` accumulation, localStorage
  persistence/hydration, `pulseKey` increments, no-op on non-positive amounts,
  SSR safety.
- `useWaveState.test.tsx` — replace XP-toast assertions with XP-state
  assertions (free-text signals summed, `mc-index` skipped, completion XP
  added, `Tier up` toast retained).
- `useScopingState.test.tsx` / `getWaveState` tests — add `topic` to expected
  shapes.
- `redactWaveChatLog.test.ts` — assert `tier` passes through both variants.
- Composer behaviour — locked-step lockout and the dynamic placeholder. (Add a
  Composer test file if none exists.)
- `just check` (lint, typecheck, test, build) must pass. ESLint
  `no-magic-numbers` applies in scoring files — none are edited here; the
  Composer _calls_ `calculateMcXp` rather than embedding constants.

---

## Out of scope (YAGNI)

- Unifying server XP accounting (mid-wave XP → `user_profiles.total_xp` vs.
  completion XP → `courses.total_xp`). Not touched.
- A server-backed XP total or a new tRPC query for it.
- Removing the questionnaire prev/next navigation (the reference keeps it).
- The inert `Attach` / `Voice` Composer buttons.
