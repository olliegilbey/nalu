# src/components

Thin rendering layer. Components get data through hooks in `src/hooks/`. Scoping uses tRPC. Wave turns stream through AI SDK `useChat` in `useWaveState.ts`. No business logic, scoring, prompt assembly, or DB access here — that belongs in `src/lib/`.

- Tailwind only. No CSS modules, no styled-components.
- Copy lives in `src/i18n/en.json`. Fill its `{name}` slots with `tFill` (`src/i18n/index.ts`), not `.replace`.
- Assessment cards must be visually distinct from chat. Interactive (buttons for MC, input for free-text).
- Comprehension signals are invisible to the user. XP shows only as the header badge and its `+N XP` floater (`ChatHeader.tsx`).
- The Composer is a render shell. `useQuestionnaire` (`src/hooks/`) owns its answer-card state machine: answers, drafts, the question on screen, the unconfirmed pick, confirm feedback, the pulse lock, and the localStorage buffer. Its decisions are pure helpers in `src/lib/course/`: `deriveComposerControls`, `deriveSendAction`, `deriveQuestionnaireAdvance`, `deriveMcXpAward`, `questionnaireBuffer`, `questionnaireKey`. `AnswerCard.tsx` renders the card. Upstream kanagawa-whispers changes are ported by hand; there is no parity lock.
- An answer card's questions and its buffer `persistKey` always come from one questionnaire. WaveSession picks both with `selectComposerQuestionnaire`; Onboarding has no preview and reads both from its one `activeQuestionnaire`. A Wave's streaming preview has no id yet, so it gets no key. The Composer treats a keyless card as a read-only preview: `readOnly` textarea, prev/next disabled. Otherwise the commit's re-init would wipe a draft typed there. The Composer re-reads its buffer when the question ids or the key change. Wave questionnaires reuse raw ids like `q1`, so ids alone never identify one (issue #118).
- The badge is a display counter. The Composer awards a correct MC answer's XP at answer time, once per question per questionnaire (`useMcXpAward`, keyed by `deriveMcXpAward`). That covers Confirm and typed text naming the option verbatim, which ships as MC. `matchOptionIndex` (`shapeQuestionnaireAnswers.ts`) is the one rule for that match; `isTypedCorrectMcAnswer` applies it. The turn result adds only free-text and completion XP (`deriveTurnResultEffects`), so the two never overlap.
- A failed Wave Turn must never make the learner retype (issue #231; why: `src/lib/course/CLAUDE.md`). A failed chat-text send puts its text back in the Composer. `useWaveState.failedTurn` drives WaveSession's `RetryRow`, which re-sends the same payload and empties the restored text. A Composer send of that same text skips the optimistic bubble: the server already shows the entry. The rules live in `failedChatText.ts`.
- `SettingsSheet.tsx` holds the learner's custom instructions. Its entry point is the side menu's Settings button: `ChatShell` wires `SideMenu`'s `onOpenSettings`, so every page opens it. `useCustomInstructions` (`src/hooks/`) reads the saved text while the sheet is open, saves, and toasts the result. The text area's `maxLength` reads `PROFILE.maxCustomInstructionsLength`. A save applies from the next Wave, and the sheet says so.
- A `getState` NOT_FOUND is final: a wrong URL, or another browser's course. `useScopingState` sets `courseNotFound`, `useWaveState` sets `waveNotFound`, and Onboarding and WaveSession then return `CourseNotFound`: a Nalu message and a "Start a new course" CTA to `/`. Onboarding passes the "can't find this course" copy. WaveSession passes "can't find this lesson": its NOT_FOUND also covers a Wave number the learner's own course lacks (issue #230). `createQueryClient()` (`src/lib/queryClient.ts`) never retries or refetches it. A malformed URL 404s at the page before any query runs: the course id must pass `z.uuid()`, and a Wave number must be plain digits with no leading zero, at most `MAX_WAVE_NUMBER` (the `wave_number` column's Postgres `integer` limit).
- The Wave progress strip (`WaveProgressBar.tsx`) sits in ChatShell's `subheader` slot, pinned under the header. The header has no room for it on a phone: the topic title would truncate. WaveSession feeds `deriveWaveProgress` the server's `turnsRemaining` and `turnBudget` from `wave.getState`, which refetches after each landed Turn. The client counts no turns from the chat log. `getWaveState` counts only landed Turns: a trailing learner entry has no reply yet (it streams, or it failed), so a refetch never moves the strip early. The strip reads "Wave complete" on the same `isClosed` that shows the move-on CTA. It is display only and never touches XP (issue #80).
- Keep components small. Extract sub-components approaching 150 lines.
- No `any` in props. All props typed with interfaces or inferred from tRPC.

## Kanagawa Palette (from kanagawa.nvim)

`src/app/globals.css` `:root` is the source of truth for tokens and semantic roles.

| Role                     | Token        |
| ------------------------ | ------------ |
| Background               | sumiInk1     |
| Card/popover/muted bg    | sumiInk3     |
| Secondary, border, input | sumiInk4     |
| User message bubble      | waveBlue2    |
| Primary, focus ring      | crystalBlue  |
| Foreground               | fujiWhite    |
| Muted text               | fujiGray     |
| Accent                   | sakuraPink   |
| Accent gold              | carpYellow   |
| Success/correct          | springGreen  |
| Error/incorrect          | waveRed      |
| Destructive              | samuraiRed   |
| Warning/review           | autumnYellow |
| Accent violet            | oniViolet    |
| Accent orange            | surimiOrange |

The Kanagawa colours are Tailwind theme colours (`@theme inline` in `globals.css`). Every utility, variant and `/NN` modifier works on them, e.g. `hover:border-crystal/50`. Class names: `sumi-0`…`sumi-5`, `wave-blue-1`, `wave-blue-2`, `fuji-gray`, `crystal`, `sakura`, `spring-green`, `carp`, `aqua`, `oni`, `wave-red`. Add a new colour to `@theme`, never as a plain class in `@layer utilities`: Tailwind builds no variants or modifiers for a plain class. `src/app/globals.test.ts` fails on any Kanagawa class that generates no CSS.

springGreen also marks an MC option picked but not yet confirmed. Once the learner confirms an ungraded MC question (no answer key), the pick freezes in crystalBlue. Green after Confirm would read as "correct" (`AnswerCard.tsx`).

Glassmorphic, Apple liquid glass inspired. Rounded corners. Generous whitespace. Translucent panels with subtle blur.
