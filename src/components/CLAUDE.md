# src/components

Thin rendering layer. Components call tRPC hooks for data. No business logic, scoring, prompt assembly, or DB access here — that belongs in `src/lib/`.

- Tailwind only. No CSS modules, no styled-components.
- Assessment cards must be visually distinct from chat. Interactive (buttons for MC, input for free-text).
- Comprehension signals are invisible to the user. Show only a brief XP toast.
- Keep components small. Extract sub-components approaching 150 lines.
- No `any` in props. All props typed with interfaces or inferred from tRPC.

## Kanagawa Palette (from kanagawa.nvim)

| Role              | Token        | Hex     |
| ----------------- | ------------ | ------- |
| Background        | sumiInk3     | #1F1F28 |
| Subtle bg         | sumiInk4     | #2A2A37 |
| Card/float bg     | waveBlue1    | #223249 |
| Card border/hover | waveBlue2    | #2D4F67 |
| Primary           | crystalBlue  | #7E9CD8 |
| Foreground        | fujiWhite    | #DCD7BA |
| Muted text        | fujiGray     | #727169 |
| Accent gold       | carpYellow   | #E6C384 |
| Success/correct   | springGreen  | #98BB6C |
| Error/incorrect   | waveRed      | #E46876 |
| Warning/review    | autumnYellow | #DCA561 |
| Accent violet     | oniViolet    | #957FB8 |
| Accent pink       | sakuraPink   | #D27E99 |
| Accent orange     | surimiOrange | #FFA066 |

Glassmorphic, Apple liquid glass inspired. Rounded corners. Generous whitespace. Translucent panels with subtle blur.
