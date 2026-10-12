# src/components

Thin rendering layer. Components get data through hooks in `src/hooks/`. Scoping uses tRPC. Wave turns stream through AI SDK `useChat` in `useWaveState.ts`. No business logic, scoring, prompt assembly, or DB access here — that belongs in `src/lib/`.

- Tailwind only. No CSS modules, no styled-components.
- Assessment cards must be visually distinct from chat. Interactive (buttons for MC, input for free-text).
- Comprehension signals are invisible to the user. XP shows only as the header badge and its `+N XP` floater (`ChatHeader.tsx`).
- Keep components small. Extract sub-components approaching 150 lines.
- No `any` in props. All props typed with interfaces or inferred from tRPC.

## Kanagawa Palette (from kanagawa.nvim)

`src/app/globals.css` `:root` is the source of truth for tokens and semantic roles.

| Role                     | Token        | Hex     |
| ------------------------ | ------------ | ------- |
| Background               | sumiInk1     | #181820 |
| Card/popover/muted bg    | sumiInk3     | #1F1F28 |
| Secondary, border, input | sumiInk4     | #2A2A37 |
| User message bubble      | waveBlue2    | #2D4F67 |
| Primary, focus ring      | crystalBlue  | #7E9CD8 |
| Foreground               | fujiWhite    | #DCD7BA |
| Muted text               | fujiGray     | #727169 |
| Accent                   | sakuraPink   | #D27E99 |
| Accent gold              | carpYellow   | #E6C384 |
| Success/correct          | springGreen  | #98BB6C |
| Error/incorrect          | waveRed      | #E46876 |
| Destructive              | samuraiRed   | #E82424 |
| Warning/review           | autumnYellow | #DCA561 |
| Accent violet            | oniViolet    | #957FB8 |
| Accent orange            | surimiOrange | #FFA066 |

Glassmorphic, Apple liquid glass inspired. Rounded corners. Generous whitespace. Translucent panels with subtle blur.
