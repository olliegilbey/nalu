# Onboarding UI — Design

Status: design (supersedes the 2026-05-15 draft of the same name)
Author: Claude + Ollie
Date: 2026-05-16

## 1. Goal

Wire the four scoping tRPC procedures (`clarify` → `generateFramework` → `generateBaseline` → `submitBaseline`) into a working chat UI by porting the existing chat-shape UI from sibling repo `kanagawa-whispers` into Nalu. One PR. Backend is built; this is mostly a wiring + port exercise.

**The whispers UI is the gold standard.** It has been hand-tested by Ollie and works excellently in its current flow — the visual design, the interaction model, the animations, the sounds, the timing are all dialled in. **The job here is to preserve that UI byte-for-byte and swap mocked data for real backend calls.** Nothing about the look, feel, or interaction flow should change. If a UI decision in this spec ever appears to diverge from whispers, the spec is wrong — re-read the whispers source and align.

**Framework migration is part of the port.** Whispers is a TanStack Router / TanStack Start app; Nalu is **Next.js 16.2 (App Router, Turbopack, React Server Components)**. Routes, root layout, and any router-specific imports must be translated:

- TanStack `createFileRoute(...).createRoute(...)` and `routes/index.tsx` → Next App Router `app/page.tsx` (Server Component).
- TanStack `routes/__root.tsx` (with `HeadContent`, `Scripts`, `Outlet`) → Next `app/layout.tsx`.
- TanStack `Link`, `useRouter`, `Outlet` → `next/link`, `next/navigation`'s `useRouter`, child rendering via the layout/page model.
- TanStack route params → Next 16 dynamic segments where `params` is a `Promise<{...}>` that must be `await`ed in Server Components.
- TanStack Query is already in both; `QueryClientProvider` mounting moves from `routes/__root.tsx` into Nalu's existing `app/providers.tsx`.
- `?url` CSS imports → Next's `globals.css` import pattern in `app/layout.tsx`.
- Sonner `<Toaster .../>` mounted in whispers' `__root.tsx` → mounted in Nalu's `app/layout.tsx`.

The framework migration is mechanical and confined to two files (`app/layout.tsx`, `app/page.tsx` / `app/course/[id]/page.tsx`) plus the providers. The chat components themselves (Composer, MessageBubble, SideMenu, ChatHeader) contain no framework-specific code and port without changes beyond CSS class imports.

**Whispers is also the continuous UI demo platform.** We port everything across (even visually-inert pieces like the SideMenu) and stay as close to byte-parity as possible for shared components, so that future whispers UI iterations can be pulled into Nalu as straight copies. Nalu-only additions are confined to (a) state/data wiring, (b) extensions to support Nalu's actual question shapes, and (c) the Move-on mode.

Genuinely new code in this PR: a state hook, a derived-turns function, one new query procedure, a small Composer extension for pure free-text questionnaires (clarify), and Move-on mode on the Composer.

Deliverable: a learner can visit the app, type a topic, answer clarifying questions, see the framework rendered in chat, answer baseline questions, see the closing model message, and click a single "Move on to Wave 1" CTA to advance — and the whole thing **looks and feels indistinguishable from whispers** other than the data being real.

## 2. Non-goals

- Framework editing. The model adapts the course dynamically as learning progresses; manual editing of the initial framework is out of scope for the MVP and beyond.
- Wave / teaching loop UI. This PR stops at the "Move on to Wave 1" CTA. The Wave loop is a follow-up that will reuse the same primitives.
- Real Supabase auth. Dev-only `x-dev-user-id` header is used; real auth is a separate later milestone.
- Streaming LLM responses. Mutations resolve when the model is done; bubbles appear whole. Streaming can be retrofitted later.
- Locale switching. Copy lives in `en.json` only; the translator is in place so future locales are a swap, not a refactor.
- Visual regression / screenshot tests, side-menu functionality, account screens.

## 3. Mental model

### 3.1 The whole app is a chat

95% of the UI surface is one chat thread. Two bubble shapes:

- **Left-aligned LLM bubble** — markdown-rendered model output. The framework turn renders the model's `userMessage` as prose inside this bubble, plus a small structured tier list immediately below the prose (still inside the same left-aligned region). This is the **only** place we render non-prose content from the model directly to the user.
- **Right-aligned user bubble** — the learner's own messages. Free-text messages render as typed. Questionnaire submissions render as if the user typed them out: clarify answers concatenate into one bubble (one Q/A per line); baseline answers do the same. This gives the learner a scrollback record matching what the model received.

No cards. No floating panels. No edit affordances inside bubbles. The bubble scroll is read-only history.

### 3.2 One interaction surface: the Composer

**Sticky Composer** is the main interaction point and lives pinned at the bottom of the viewport at all times. There is effectively one user gesture: tap the primary action button at the right of the Composer. What that gesture _does_ depends on the Composer's current mode:

- **Free-text mode** — autosizing textarea. Primary action sends the typed message. Used for the topic input on the empty home screen; during Waves (out of scope here) this is also the conversational interaction surface for back-and-forth with the tutor LLM.
- **Question mode** (multi-question, stepped entirely client-side) — the current question's prompt above an option grid (MC) or another textarea (pure free-text). N-of-M counter + prev/next chevrons at the top. The flow:
  - **MC**: tap an option → marks it _pending_ (no advance); the primary action button transforms into a **Confirm** button. Tap Confirm → check against `correctIndex`, play correct/wrong sound, fire a "10 XP Gained" toast on correct, pulse animation on the option (700ms), then advance to the next question. Pure parity with whispers — this whole flow lives inside the Composer.
  - **Free-text within a question**: typing in the textarea clears any pending MC pick. Sending the typed value records it as the answer for the current step (this drives `fromEscape: true` server-side for baseline questions that allow it; the escape-hatch UX is just "type instead of pick").
  - **Pure free-text questionnaire** (clarify): no MC options shown, just the prompt + textarea + N-of-M counter + prev/next. Send records the answer, advances. Small Nalu-only extension on top of whispers' Composer.

Once `onComplete` fires (all answers collected), the parent concatenates them into a single right-aligned user bubble (one Q/A per line) and dispatches the next tRPC procedure in **one** call.

**The "Move on to Wave N" button is the same primary action button**, just in a different mode. After `submitBaseline` resolves at the end of scoping (or after a Wave's closing turn resolves at the end of each Wave; out of scope here but the seam matters), the Composer enters Move-on mode: a single labelled button reading "Move on to Wave 1" (or "Move on to Wave N+1" for the wave case) replaces the input row. Tapping it clears the visible chat and opens the next conversation, seeded by the closing payload from the prior conversation. The `submitBaseline` mutation (or the Wave's closing turn) is what primes the next conversation server-side; the Move-on button cannot appear until that closing response has landed — the next conversation literally doesn't exist until then.

This conception keeps the gesture identical across the whole app — tap the bottom-right button to advance — while the underlying behavior (send / confirm / navigate) varies by mode. DRYs nicely with the backend's shared `closeTurn.ts` base schema (`makeCloseTurnBaseSchema`).

### 3.3 Server is source of truth; client derives view-state

Per `AGENTS.md`, the LLM is stateless and the harness holds Context. Per `src/server/routers/CLAUDE.md`, the client maintains stage-state and dispatches accordingly. Reconciliation:

- Server's `courses` row (with its `clarification`, `framework`, `baseline`, `status`, plus the linked `course_messages` thread) is the only durable state.
- Client reads the row via a new `course.getState` query, derives `Turn[]` via a pure function (`deriveTurns`), and renders. Stage dispatch (which mutation to call next) is driven by `nextStage` fields returned from the previous mutation and reconciled against the derived state on remount.
- `localStorage` is used only to buffer in-flight questionnaire answers — the learner's currentIndex and answers Map for the active questionnaire — keyed `nalu:scoping:{courseId}:{stage}`. Cleared on successful mutation. This survives a refresh mid-questionnaire without claiming to be the source of truth.

## 4. Architecture

### 4.1 Routes

Whispers' `routes/index.tsx` (TanStack Router) maps onto Next App Router as follows. The visual output of both routes must match the whispers home page byte-for-byte; the framework swap is plumbing only.

- `/` (Server Component, `app/page.tsx`) — renders the chat shell in an empty state: header, side-menu trigger, empty scrollback with a one-line greeting from `en.json`, sticky Composer in free-text mode for the topic. On submit, the topic-input client component calls `course.clarify` and routes to `/course/{id}` via `next/navigation`'s `useRouter().push(...)` (whispers uses TanStack's `useNavigate`).
- `/course/[id]` (Server Component, `app/course/[id]/page.tsx`) — awaits `params` (Next 16 returns it as a `Promise`), renders the `<Onboarding courseId={id}>` client component which mounts `useScopingState(courseId)` and renders the same chat shell now driven by server data.

The chat shell is one component used on both routes; the only difference is whether `useScopingState` has a `courseId` to fetch. The shell component itself is framework-agnostic and ports cleanly from whispers.

### 4.2 Files added

```
src/
  app/
    layout.tsx                   # ensure <Toaster position="top-center" closeButton={false} richColors /> from sonner is mounted (port from whispers __root.tsx)
    page.tsx                     # replace boilerplate; render <TopicInput/>
    course/[id]/page.tsx         # new server component, awaits params
    providers.tsx                # add x-dev-user-id header to httpBatchLink
    globals.css                  # append Kanagawa palette + @theme + new keyframes (q-slide, pulse-correct/wrong, wave-spin) + utility classes
  components/
    chat/
      ChatHeader.tsx             # port from whispers, byte-parity
      Composer.tsx               # port from whispers (337 lines, parity) + small Nalu extensions: pure-free-text questionnaire mode, persistKey prop, Move-on mode, Nalu Question adapter
      EmptyState.tsx             # port from whispers, byte-parity
      MessageBubble.tsx          # port from whispers, byte-parity (includes WaveSpinner SVG)
      SideMenu.tsx               # port from whispers, byte-parity (inert nav, functional MuteToggle)
      ChatShell.tsx              # adapted from whispers' routes/index.tsx (~50 lines of composition) — assembles header + side-menu + scroll + Composer
      FrameworkTierList.tsx      # new — structured tier renderer inside LLM prose stream
      Onboarding.tsx             # new — wires useScopingState into ChatShell
      TopicInput.tsx             # new — empty-state ChatShell wrapper that calls trpc.course.clarify
    ui/                          # port the shadcn primitives whispers depends on (sheet, button, etc.)
  hooks/
    useScopingState.ts           # new — tRPC.course.getState + dispatch helpers + Question→ChoiceQuestion adapter
  i18n/
    index.ts                     # port from whispers byte-parity (~25 lines)
    en.json                      # port + extend with Nalu-specific keys (move-on, stage indicators)
  lib/
    sound.ts                     # port from whispers, byte-parity (WebAudio correct/wrong tones + mute manager)
    course/
      getState.ts                # new — reads via src/db/queries/courses.ts
      deriveTurns.ts             # new — pure courseRow → Turn[]
      deriveTurns.test.ts        # colocated test, case-table
    types/
      turn.ts                    # new — Turn discriminated union
  server/
    routers/
      course.ts                  # add getState query (~30 lines)
```

New runtime deps: `sonner`, `react-markdown`, `remark-gfm`, `lucide-react`, plus any Radix primitives `ui/sheet.tsx` pulls in (`@radix-ui/react-dialog` at minimum). Verify all against `package.json` before installing.

### 4.3 Turn type

`Turn` is a discriminated union representing one entry in the rendered chat scroll. The component layer cares only about `kind`. Derived from the `courses` row + `course_messages`; never mutated by the client.

```ts
export type Turn =
  | { kind: "user-topic"; content: string }
  | { kind: "llm-clarify-intro"; content: string } // clarification.userMessage
  | { kind: "user-clarify-answers"; content: string } // concatenated Q/A pairs
  | {
      kind: "llm-framework";
      userMessage: string;
      tiers: ReadonlyArray<{ number: number; name: string; description: string }>;
    }
  | { kind: "llm-baseline-intro"; content: string } // baseline.userMessage
  | { kind: "user-baseline-answers"; content: string } // concatenated Q/A pairs
  | { kind: "llm-baseline-close"; content: string } // submitBaseline closing message
  | { kind: "move-on-cta"; nextWaveNumber: number }; // appears only after submitBaseline resolves
```

`deriveTurns(courseRow)` returns `Turn[]` deterministically: presence of fields on the row dictates which turns are emitted. The active questionnaire (clarify or baseline) is **not** a turn — it's rendered by the Composer based on `useScopingState`'s `activeQuestionnaire` field.

### 4.4 Data flow per stage

```
[/ topic input]
  user types topic → TopicInput.onSubmit
    → trpc.course.clarify.mutate({ topic })
    → router.push(`/course/${courseId}`)
    → on mount, useScopingState fetches getState
    → deriveTurns emits: [user-topic, llm-clarify-intro]
    → Composer enters question-mode for the clarification questionnaire

[clarify questionnaire]
  Composer shows Q1 → user answers → Composer advances internally → ... → Qn
  on completion:
    useScopingState.submitClarify(responses)
      → trpc.course.generateFramework.mutate({ courseId, responses })
      → invalidate getState
      → deriveTurns now emits: [..., user-clarify-answers, llm-framework]
    Composer leaves question-mode (no active questionnaire until baseline starts)

[baseline trigger]
  useScopingState detects framework present + no baseline → auto-calls:
    → trpc.course.generateBaseline.mutate({ courseId })
    → invalidate getState
    → deriveTurns emits: [..., llm-baseline-intro]
    → Composer enters question-mode for the baseline questionnaire

[baseline questionnaire]
  Composer shows Q1 (MC or free-text) → ... → Qn
  on completion:
    useScopingState.submitBaselineAnswers(answers)
      → trpc.course.submitBaseline.mutate({ courseId, answers })
      → server grades, primes Wave 1 with the closing payload, flips course status to active
      → invalidate getState
      → deriveTurns emits: [..., user-baseline-answers, llm-baseline-close, move-on-cta]
      → Move-on CTA can now render — and ONLY now, because Wave 1 priming lives in the submitBaseline response

[move on]
  user clicks "Move on to Wave 1"
    → out of scope for THIS PR: routes to a stubbed /course/{id}/wave/1
    → in scope for this PR: the CTA appears, is wired to a navigation stub
```

The same shape holds at end-of-Wave (out of scope here, but the seam is preserved): the closing turn primes the next Wave server-side; the CTA appears only after that response lands.

### 4.5 New tRPC procedure: `course.getState`

```ts
getState: protectedProcedure
  .input(z.object({ courseId: z.string().uuid() }))
  .query(({ ctx, input }) => getState({ userId: ctx.userId, courseId: input.courseId }));
```

Lib step (`src/lib/course/getState.ts`, ~30 lines):

- Reads the `courses` row via existing `src/db/queries/courses.ts`.
- Enforces `userId` ownership; throws `NOT_FOUND` if missing or owned by another user (don't leak existence).
- Returns a typed payload: `{ courseId, status, topic, clarification, framework, baseline, scopingResult }` — the fields the client needs to derive turns. No raw LLM output is in any of these fields beyond what the mutations already returned.

### 4.6 `useScopingState(courseId)`

```ts
function useScopingState(courseId: string) {
  const state = trpc.course.getState.useQuery({ courseId });
  const generateFramework = trpc.course.generateFramework.useMutation({ onSuccess: () => state.refetch() });
  const generateBaseline = trpc.course.generateBaseline.useMutation({ onSuccess: () => state.refetch() });
  const submitBaseline = trpc.course.submitBaseline.useMutation({ onSuccess: () => state.refetch() });

  const turns = useMemo(() => state.data ? deriveTurns(state.data) : [], [state.data]);
  // activeQuestionnaire is the Composer-shaped questionnaire (whispers `ChoiceQuestion[]` or pure-free-text equivalent)
  // derived from the row via deriveActiveQuestionnaire, which also runs the Nalu Question → ChoiceQuestion adapter.
  // For baseline MC questions, `correctIndex` is set from the `correct` key (shipped by design — src/lib/prompts/baseline.ts:77-78).
  // For clarify questions, `correctIndex` is undefined → Composer skips sound/toast and just advances.
  const activeQuestionnaire = deriveActiveQuestionnaire(state.data);   // null | { kind: "clarify" | "baseline"; questions, mode: "mc" | "free-text" }
  const pending = generateFramework.isPending || generateBaseline.isPending || submitBaseline.isPending;

  // auto-dispatch generateBaseline once framework is present and baseline is not
  useEffect(() => { ... }, [state.data]);

  return { turns, activeQuestionnaire, pending, submitClarify, submitBaselineAnswers };
}
```

Hook is portable (no DOM, no Next-specific imports). RN can consume it as-is once the tRPC client is set up there. The Question → ChoiceQuestion adapter is a small pure function colocated in this file (or split out to `src/lib/course/adaptQuestionnaire.ts` if it grows past ~30 lines).

### 4.7 Questionnaire state lives in the Composer

The original draft factored questionnaire stepping into a `useQuestionnaire` hook. After the latest whispers update, the Composer (`/Users/olliegilbey/code/kanagawa-whispers/src/components/chat/Composer.tsx`, 337 lines) **already owns the full multi-question state machine internally**: `answers[]`, `pending[]`, `feedback[]`, `step`, `locked`, `slideDir`, N-of-M counter, prev/next chevrons, tap-then-confirm flow, correct/wrong sound, XP toast, pulse animation. Resetting on a new questionnaire is keyed off `questionsKey = questions.map(q => q.id).join("|")`. The Composer exposes a single `onComplete(answers)` callback.

To preserve parity with whispers (so future whispers UI iterations can be pulled in as straight copies), **we do not extract a separate `useQuestionnaire` hook in Nalu**. The Composer is the questionnaire state machine.

The only Nalu-specific extension to that state is **refresh-resilience**, added as a thin `persistKey?: string` prop on the Composer:

- If set, the Composer reads `answers`/`step` from `localStorage` at `nalu:scoping:{courseId}:{stage}` on mount, and writes on every change.
- Cleared in the `onComplete` flow before the parent dispatches its mutation.
- SSR-safe (`typeof window === "undefined"` guard).
- When absent, the Composer behaves byte-identically to whispers — which is the case during free-text and Move-on modes.

The localStorage buffer is **only** for resilience against accidental refresh mid-questionnaire. The truth lives on the server; if the row already has a saved clarification, the questionnaire isn't active in the first place and the buffer is irrelevant.

### 4.8 Composer adaptation

The whispers Composer already does most of what Nalu needs: free-text mode, MC question mode with multi-question stepping, N-of-M counter + prev/next chevrons, tap-then-confirm flow, correct/wrong sounds, XP toast on correct, pulse animation, slide transitions, `questionsKey`-driven state reset. The whispers `ChoiceQuestion` shape is `{ id: string; prompt: string; options: string[]; correctIndex?: number }`. We port the Composer **byte-parity** and add only the following Nalu-specific deltas:

1. **Nalu Question → ChoiceQuestion adapter** in `useScopingState` (not in the Composer): the Nalu `Question` type (`src/lib/prompts/questionnaire.ts`, discriminated union `free_text | multiple_choice`) is mapped to whispers' `ChoiceQuestion` shape before being handed to the Composer. For `multiple_choice`, `correctIndex` is derived from baseline's `correct` MC key (already shipped to the client by design — see `src/lib/prompts/baseline.ts:77-78`). For clarify questions there is no correct answer, so `correctIndex` is `undefined`; the Composer's existing logic already handles this (no sound, no toast, just advance).
2. **Pure free-text questionnaire mode** (Nalu-only extension; whispers currently only steps through MC questionnaires): for clarify questions and for baseline free-text questions with an escape-hatch flag, the Composer renders the textarea + primary action button + N-of-M counter instead of an option grid. Sending the typed value records the answer for the current step and advances. When the question metadata flags free-text-with-escape-hatch, also render an "I'd rather pick from options" button that toggles into MC mode within the same Composer and drives `fromEscape: true` server-side on submission. This is a small additive branch inside the existing Composer step renderer — the surrounding state machine (step, answers, locked, slide, persistKey) is unchanged.
3. **Move-on mode**: when `useScopingState`'s derived turns include a `move-on-cta` tail entry, the Composer renders a single labelled button across its action row reading "Move on to Wave 1" (or "Move on to Wave N+1" for the Wave case). Tap navigates; no mutation. Move-on mode is intentionally a Composer mode rather than a separate `MoveOnButton` component: the user's mental model is that the bottom action button advances the conversation, and that conceptual continuity is preserved by reusing the Composer's action surface.
4. **`persistKey?: string` prop** for refresh-resilience (see §4.7).

Free-text mode (no active question) stays close to whispers' current form — autosizing textarea + primary action sends the typed message. For this PR it backs the topic input on the empty home screen; the same mode is reused during Waves as the conversational interaction surface with the tutor LLM.

Plus and Mic icon affordances stay visually present from the whispers port but inert for MVP.

### 4.9 Bubble styling and Markdown

A clarification on the word "bubble": colloquially the whole chat scroll is bubbles, but the whispers UI styles them asymmetrically and we keep that asymmetry **byte-for-byte**:

- **LLM side** is a **prose stream**, not a contained bubble. It's rendered as a typography-styled block flush with the left edge (small `Nalu` label + dot, then the markdown body via `ReactMarkdown` + `remarkGfm`). No background, no border, no rounded container. This matches `MessageBubble.tsx`'s assistant branch in whispers.
- **User side** is a **bubble** in the visual sense: rounded-2xl `bg-wave-blue-2` container, right-aligned, max-width capped, plain text via `<p className="whitespace-pre-wrap">{message.content}</p>` — **no markdown**, matching whispers. We previously considered adding markdown on the user side, but the whispers-parity directive overrides: if whispers later adds markdown there, we'll pull it in. Until then, plain text matches.

The TypingBubble (used while a mutation is pending) is whispers' `WaveSpinner` — an animated SVG with two curling wave swooshes (crystal-blue + sakura-pink, yin-yang arranged) driven by the `wave-spin` keyframe. Port byte-parity from `MessageBubble.tsx`.

The framework turn is rendered by `ChatShell` as part of the LLM-side prose stream:

```
[LLM-side prose stream]
  <Markdown>{turn.userMessage}</Markdown>
  <FrameworkTierList tiers={turn.tiers} />
```

`FrameworkTierList` is a small structured renderer (~40 lines): a vertical list of `{number, name, description}` items, styled to read as part of the same model message — not a separate card or boxed UI element. `exampleConcepts` is intentionally not rendered (per design call). This component is Nalu-only (no whispers counterpart) since the framework shape is Nalu-specific.

### 4.10 Move-on gating (no separate component)

There is no separate `MoveOnButton` component. The Composer handles it as one of its modes (§4.8). Gating logic still matters:

The Composer enters Move-on mode when `useScopingState`'s derived `Turn[]` ends in a `move-on-cta` turn. The derived `move-on-cta` is emitted by `deriveTurns` only when the course row has a `scopingResult` field populated — that field is only written server-side once `submitBaseline` finishes successfully. So the Composer's Move-on mode cannot activate before the closing response has landed; this is enforced at the data layer, not by client state.

The same gate principle will apply for Wave→Wave transitions later (the next Wave's seed lives in the closing turn's response payload, and a corresponding `deriveTurns` for Waves will emit `move-on-cta` only when that payload is present).

### 4.11 i18n

Port whispers' translator verbatim (`src/i18n/index.ts`, ~25 lines: dot-path resolver over a typed `en.json`). Port whispers' full `en.json` byte-parity, then extend with Nalu-specific keys. The whispers keys to preserve include (recently added to whispers and required by the Composer/SideMenu port):

```jsonc
{
  "composer": {
    "questionCounter": "{current} / {total}",
    "prev": "Previous",
    "next": "Next",
    "confirm": "Confirm",
    // ...plus existing whispers keys (placeholderFirst, placeholderContinue, chooseLabel, etc.)
  },
  "menu": {
    "mute": "Mute sounds",
    "unmute": "Unmute sounds",
    // ...plus existing whispers keys (newCourse, title, subtitle, courses, etc.)
  },
}
```

Nalu-specific additions on top:

```jsonc
{
  "app": { "name": "Nalu", "disclaimer": "Nalu can make mistakes. Verify important information." },
  "composer": {
    "placeholderFirst": "What do you want to learn?",
    "placeholderAnswering": "Type your answer (or pick an option)…",
    "escapeHatch": "I'd rather pick from options",
  },
  "stages": {
    "clarify": { "indicator": "Clarifying" },
    "framework": { "label": "Your learning ladder" },
    "baseline": { "indicator": "Baseline check" },
  },
  "moveOn": { "toWave": "Move on to Wave {n}" },
  "xp": { "gained": "10 XP Gained" },
}
```

All UI copy goes through `t(...)`. No string literals in components. Migration to `next-intl` later is a key-naming swap, not a rewrite.

### 4.12 Auth header injection

`src/app/providers.tsx`:

```ts
httpBatchLink({
  url: "/api/trpc",
  headers: () => ({
    "x-dev-user-id": process.env.NEXT_PUBLIC_DEV_USER_ID ?? "<seeded-dev-user-uuid>",
  }),
});
```

Document `NEXT_PUBLIC_DEV_USER_ID` in `.env.local.example`. The seeded dev user UUID lives in whatever seed/fixture file `just db-seed` (or the equivalent) populates; the fallback uses that UUID so a fresh checkout works without env setup.

### 4.13 Styles

Append the Kanagawa palette block + `@theme` declarations from `kanagawa-whispers/src/styles.css` into `src/app/globals.css`. Tailwind v4 picks up `@theme` tokens automatically; no `tailwind.config.ts` needed. Port byte-parity.

Specific keyframes to port (all from whispers):

- `@keyframes message-in` — bubble entry animation
- `@keyframes q-slide-next` / `@keyframes q-slide-prev` — 0.28s question-step slide transitions
- `@keyframes pulse-correct` / `@keyframes pulse-wrong` — 0.7s option-button feedback pulse (box-shadow + bg via `color-mix(in oklab, ...)`)
- `@keyframes wave-spin` — 1.8s rotate 360 + scale 1.06 at 50% for `WaveSpinner`

Specific utility classes (used by whispers Composer / MessageBubble / SideMenu):

- `.animate-message-in`, `.animate-q-slide-next`, `.animate-q-slide-prev`
- `.pulse-correct`, `.pulse-wrong`
- `.wave-spin`
- `.border-spring-green`, `.border-wave-red`, `.text-wave-red`, `.bg-spring-green`
- existing whispers utility classes (glass, dot animations) — port as a block, not cherry-picked

## 5. Component boundaries

Each component has one clear responsibility:

| Component           | Responsibility                                                                                                                                                 | Depends on               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `ChatShell`         | Layout: header + side-menu trigger + scroll region + Composer. Adapted from whispers' `routes/index.tsx` (~50 lines of composition)                            | Renders any `Turn[]`     |
| `MessageBubble`     | One message rendering: LLM-side prose stream w/ markdown, user-side rounded plain-text bubble. Port byte-parity. Also exports `WaveSpinner` (typing indicator) | None                     |
| `FrameworkTierList` | Structured tier list rendered inside the LLM prose stream. Nalu-only                                                                                           | None                     |
| `Composer`          | Sticky bottom input; modes = free-text / question (MC + free-text) / move-on; owns questionnaire state machine internally; emits `onComplete(answers)`         | `sound.ts`, sonner toast |
| `SideMenu`          | Drawer with course list + new-course CTA + footer (profile placeholder + functional MuteToggle). Inert nav for MVP. Port byte-parity                           | `sound.ts` (MuteToggle)  |
| `ChatHeader`        | Top bar (menu trigger, title). Port byte-parity                                                                                                                | None                     |
| `Onboarding`        | Wires `useScopingState` → ChatShell + Composer                                                                                                                 | tRPC, `useScopingState`  |
| `TopicInput`        | Empty-state ChatShell wrapper that calls `trpc.course.clarify` and routes                                                                                      | trpc.clarify             |
| `useScopingState`   | tRPC reads (getState) + mutation dispatch + derived turns + Question→ChoiceQuestion adapter                                                                    | trpc + `deriveTurns`     |
| `deriveTurns`       | Pure: row → `Turn[]`                                                                                                                                           | None                     |
| `getState` (lib)    | DB read with ownership check                                                                                                                                   | db/queries               |
| `sound.ts` (lib)    | WebAudio correct/wrong tones + mute manager + subscriber pattern. Port byte-parity                                                                             | None                     |

Boundary test: can someone change `Composer`'s internals without touching anything else? Yes — its prop contract is the question shape, `persistKey`, and `onComplete` callback. Can `deriveTurns` be tested without React or tRPC? Yes — pure function over the row shape.

**Parity-locked components**: `Composer.tsx`, `MessageBubble.tsx`, `SideMenu.tsx`, `ChatHeader.tsx`, `sound.ts`, `i18n/index.ts`, `globals.css` (whispers' palette/keyframes block). Treat these as straight ports; Nalu-only deltas in these files are confined to the small extensions named above. If a whispers update lands later, it should be pull-able as a near-direct copy.

## 6. Code standards

- TypeScript strict, no `any`. Zod at trust boundaries (the new `getState` lib step Zod-parses the DB row on the way out; tRPC procedures already validate inputs).
- **200-line file cap is relaxed for whispers-parity components.** `Composer.tsx` is currently 337 lines upstream and we want it portable as a straight copy on future whispers updates. Refactoring it to fit the cap would defeat the parity goal. `MessageBubble.tsx` (129) and `SideMenu.tsx` (163) are within cap but are also parity-locked — do not refactor for line count. The cap continues to apply to Nalu-only files (`useScopingState`, `deriveTurns`, `getState`, `Onboarding`, etc.).
- Colocated tests (`foo.test.ts` next to `foo.ts`).
- `eslint-plugin-functional` rules apply: `immutable-data`, `no-let`. Use `useState` updaters, `Map` replacements via spread, etc. If parity-locked whispers files trip these rules, add a narrow file-scoped override rather than rewriting — the cost of divergence is higher than the lint diff.
- React Native portability: keep `useScopingState` and `deriveTurns` free of DOM-only APIs. Components are web-only and will get RN equivalents later.
- No business logic in components or routers — all in `src/lib/`.
- No raw SQL outside `src/db/queries/`.

## 7. Testing strategy

Tested:

- `deriveTurns.test.ts` — case table covering every combination of row shape (no clarification → just topic; clarification present → topic + clarify-intro; framework present → through framework; etc.).
- `useScopingState.test.ts` — derived `activeQuestionnaire` per row state (including the Question→ChoiceQuestion adapter, especially `correctIndex` derivation from baseline's `correct` MC key); auto-dispatch of `generateBaseline` when framework is present and baseline is not; localStorage `persistKey` produces stable keys.
- `getState.test.ts` — ownership enforcement (correct user, wrong user, missing).
- One Playwright happy-path: topic → clarify → framework (asserts `userMessage` + tier list both visible) → baseline (asserts XP toast fires on correct MC) → submit → "Move on to Wave 1" CTA visible (and not visible before submit). Also: refresh mid-baseline questionnaire and confirm the in-flight answers/step are restored.

Not tested in this PR:

- The four existing tRPC procedures (covered by existing backend tests).
- Ported `ui/` primitives (stable upstream).
- **`Composer.tsx` internals** — parity-locked, tested upstream in whispers. We rely on whispers' demo platform as the testbed for stepping, sound, toast, pulse, and slide behavior. The Nalu Playwright happy-path is sufficient as a smoke test for the integration.
- **`MessageBubble.tsx`, `SideMenu.tsx`, `sound.ts`** — parity-locked, behavior is whispers' responsibility.
- Visual regression.

## 8. Open questions deferred to implementation

- Exact UUID for the fallback dev user. The implementer should read whatever seed/fixtures file backs the dev workflow and pull the user that currently exists. If no such user exists, seed one and document.
- Whether the Move-on CTA's stubbed wave route should be a 404 placeholder or a "Wave 1 coming soon" page. Either is fine; pick the smaller diff.
- The whispers Composer has Plus/Mic icon buttons that are non-functional in whispers too. Keep them in the port for visual continuity; they remain inert.

## 9. Risk register

- **Tailwind v4 `@theme` block compatibility**: whispers uses Tailwind v4 + `@theme`; verify Nalu's `globals.css` is on v4 before porting. If on v3, postpone the palette port or upgrade first — do not ship a hybrid.
- **`react-markdown` + `remark-gfm` versions**: whispers uses recent versions; check Nalu's `package.json`. Add if absent.
- **`sonner` toast**: whispers uses `<Toaster position="top-center" closeButton={false} richColors />` mounted in `__root.tsx`; mirror in Nalu's `app/layout.tsx`. Add as a dependency if missing.
- **lucide-react icons**: used in Composer (`ArrowUp`, `Mic`, `Plus`), ChatHeader, and SideMenu (`Plus`, `Settings`, `BookOpen`, `Volume2`, `VolumeX`). Add as a dependency if missing.
- **`@radix-ui/react-dialog`**: backs the whispers `ui/sheet.tsx` used by SideMenu. Add if missing.
- **WebAudio browser compat**: `sound.ts` already guards `typeof window === "undefined"` and falls back to webkit prefix. No further action — port verbatim.
- **localStorage on SSR**: Composer's `persistKey` branch must guard against `typeof window === "undefined"` on first render. Standard hooks pattern.
- **Auto-dispatching `generateBaseline` on mount**: must be idempotent. The mutation's own server-side replay guard (already present per backend tests) protects us; client-side, gate the dispatch on `!state.data.baseline && !generateBaseline.isPending` to avoid double-fire during refetch races.
- **Composer 337-line size and complexity**: the parity-locked Composer carries multi-question state plus our Nalu deltas (free-text mode, persistKey, Move-on mode). If the file becomes hard to merge against whispers on a future pull, fall back to: maintain a thin Nalu-specific subclass/wrapper that composes whispers' Composer as the inner control. Don't fork the file.

## 10. Out of scope but adjacent

These are intentionally **not** in this PR but the design preserves their seams:

- Real Supabase auth — swap the `x-dev-user-id` header for a Supabase session token; nothing else changes.
- Wave loop UI — reuses `ChatShell`, `MessageBubble`, `Composer` (all three modes including move-on). The Composer's free-text mode in particular becomes the **primary** interaction surface during Waves, since most Wave turns are conversational tutoring prose rather than questions. New code for Waves: a `useWaveState` hook analogous to `useScopingState`, and a Wave-specific `deriveTurns`.
- React Native — reuses `useScopingState`, `deriveTurns`, all `src/lib/` types and schemas. New code: native renderers for the chat components (including a native questionnaire stepper that mirrors the whispers Composer's behavior, since the web Composer is DOM-bound).
- next-intl migration — keys already namespaced; swap the resolver, keep the JSON.
- Plus and Mic icon affordances in the Composer — visually present from the whispers port but inert for MVP; future work attaches actual functionality (attachments, voice input).

## 11. Acceptance criteria

A reviewer can run `just dev`, open the app, and:

1. See the empty home screen with the topic input — visually matching whispers' empty state byte-for-byte.
2. Open the side menu (`SideMenu`) and see the inert course list, the new-course CTA (inert), and the functional mute toggle in the footer.
3. Type a topic (e.g., "Linear algebra for ML"), press send.
4. Be routed to `/course/{uuid}`, see their topic as a right-aligned bubble (plain text, no markdown — parity), then the clarification intro as a left-aligned prose stream.
5. See a `WaveSpinner` (animated yin-yang waves) appear while each mutation is pending.
6. See the first clarification question in the Composer's question mode with "1 / N" counter and prev/next chevrons. Answer it (pure free-text mode for clarify). Repeat through the questionnaire.
7. See their concatenated clarify answers post as a right-aligned bubble.
8. See the framework appear: prose `userMessage` followed by the tier list (number, name, description per tier — no example concepts).
9. See the baseline intro bubble appear automatically.
10. Answer the baseline questionnaire (MC questions use tap-then-confirm: tap an option → it goes pending → tap Confirm → correct/wrong sound plays (if unmuted), pulse animation on the option (700ms), "10 XP Gained" toast fires on correct (top-center, 1.5s), then advance. Free-text baseline questions with escape hatch show the "I'd rather pick from options" toggle.
11. Toggle mute in the side menu and confirm sounds cease for subsequent answers.
12. See their baseline answers post as a right-aligned bubble, then the closing model message.
13. See the Composer's action button transform into a "Move on to Wave 1" button **after `submitBaseline` resolves** — and not before.
14. Refresh the page mid-questionnaire and find their in-progress answers + current step restored.
