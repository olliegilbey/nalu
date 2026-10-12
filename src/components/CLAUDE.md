# src/components

Thin rendering layer. Components get data through hooks in `src/hooks/`. Scoping uses tRPC. Wave turns stream through AI SDK `useChat` in `useWaveState.ts`. No business logic, scoring, prompt assembly, or DB access here — that belongs in `src/lib/`.

- Tailwind only. No CSS modules, no styled-components.
- Assessment cards must be visually distinct from chat. Interactive (buttons for MC, input for free-text).
- Comprehension signals are invisible to the user. XP shows only as the header badge and its `+N XP` floater (`ChatHeader.tsx`).
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

springGreen also marks an MC option picked but not yet confirmed. Once the learner confirms an ungraded MC question (no answer key), the pick freezes in crystalBlue. Green after Confirm would read as "correct" (`Composer.tsx`).

Glassmorphic, Apple liquid glass inspired. Rounded corners. Generous whitespace. Translucent panels with subtle blur.
