# Onboarding UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port whispers' chat-shape UI into Nalu (Next.js 16.2) and wire it to the four existing scoping tRPC procedures (`clarify` → `generateFramework` → `generateBaseline` → `submitBaseline`) so a learner can complete onboarding end-to-end and see a "Move on to Wave 1" CTA.

**Architecture:** Server (`courses` row) is the only durable state. A new `course.getState` query returns the typed row; a pure `deriveTurns` projects it to a discriminated `Turn[]`; `useScopingState` glues it to mutations + a Question→ChoiceQuestion adapter. UI is whispers byte-parity: same components, same animations, same sounds — only `routes/__root.tsx` + `routes/index.tsx` are rewritten for Next App Router, and the Composer gets three small Nalu-only deltas (pure-free-text questionnaire mode, `persistKey`, Move-on mode).

**Tech Stack:** Next.js 16.2 (App Router, RSC), React 19.2, TypeScript strict, tRPC v11 via `@trpc/tanstack-react-query` (`useTRPC()` + `queryOptions`/`mutationOptions` style), TanStack Query 5, Tailwind v4 (`@theme`), Zod v4, sonner, react-markdown + remark-gfm, lucide-react, @radix-ui/react-dialog. Bun for installs. Vitest (`unit` project) for colocated tests; Playwright for the one end-to-end happy-path.

**Spec:** `docs/superpowers/specs/2026-05-15-onboarding-ui-design.md`. Read it once before starting Task 1.

**Whispers reference repo:** `/Users/olliegilbey/code/kanagawa-whispers/`. Parity-locked files must match whispers byte-for-byte except for the small named Nalu deltas. When in doubt, re-read the whispers source.

**Common conventions:**

- Commands: `just dev`, `just test`, `just lint`, `just typecheck`, `just check`, `just build`. **Use `bun add <pkg>` to install** — Nalu uses bun, never npm.
- Never bypass git hooks (`--no-verify`, `HUSKY=0`).
- No `any`; Zod at trust boundaries.
- 200-line file cap **relaxed only** for parity-locked files (`Composer.tsx`, `MessageBubble.tsx`, `SideMenu.tsx`, `ChatHeader.tsx`, `EmptyState.tsx`, `sound.ts`, `i18n/index.ts`, ported `ui/sheet.tsx`). New Nalu files (`useScopingState.ts`, `deriveTurns.ts`, `getState.ts`, `Onboarding.tsx`, `ChatShell.tsx`, etc.) stay under the cap.
- The `correct` key on baseline MC questions is intentionally shipped to the client — confirmed at `src/lib/prompts/baseline.ts:77-78`. Do not strip it.
- tRPC client style is **NOT** `trpc.foo.useQuery({...})`. It's:
  ```ts
  const trpc = useTRPC();
  const q = useQuery(trpc.course.getState.queryOptions({ courseId }));
  const m = useMutation(
    trpc.course.generateFramework.mutationOptions({ onSuccess: () => qc.invalidateQueries() }),
  );
  ```
  See `src/lib/trpc.ts` for the existing context.
- Commit every task. Use Conventional Commits (`feat:`, `chore:`, `test:`, etc.). Keep messages short.

---

## Task 0: Read the spec and confirm baseline

**Files:** None (read-only)

- [ ] **Step 1: Read the spec end-to-end**

Read `docs/superpowers/specs/2026-05-15-onboarding-ui-design.md`. Skim every section.

- [ ] **Step 2: Confirm clean working tree**

Run: `git status`
Expected: working tree clean on `main` (or current branch).

- [ ] **Step 3: Run baseline check**

Run: `just check`
Expected: all green. Stop and resolve if anything is red — do not start work on a dirty baseline.

- [ ] **Step 4: Create feature branch**

Run: `git checkout -b feat/onboarding-ui`

No commit yet.

---

## Task 1: Add new runtime dependencies

**Files:**

- Modify: `package.json`
- Modify: `bun.lock` (auto)

We need: `sonner` (toast), `react-markdown` + `remark-gfm` (LLM bubble markdown), `lucide-react` (icons), `@radix-ui/react-dialog` (sheet backbone), `class-variance-authority` + `clsx` + `tailwind-merge` (cn util / sheet variants).

- [ ] **Step 1: Install**

Run:

```bash
bun add sonner react-markdown remark-gfm lucide-react @radix-ui/react-dialog class-variance-authority clsx tailwind-merge
```

- [ ] **Step 2: Confirm install**

Run: `bun pm ls | grep -E 'sonner|react-markdown|remark-gfm|lucide-react|@radix-ui/react-dialog|class-variance|clsx|tailwind-merge'`
Expected: each package listed with a resolved version.

- [ ] **Step 3: Type-check**

Run: `just typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock
git commit -m "chore(deps): add sonner, react-markdown, lucide-react, radix-dialog, cn-utils for onboarding UI"
```

---

## Task 2: Add cn utility

Whispers `ui/sheet.tsx` imports `cn` from `@/lib/utils`. Nalu doesn't have it yet.

**Files:**

- Create: `src/lib/utils.ts`

- [ ] **Step 1: Write utility**

Create `src/lib/utils.ts`:

```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Conventional shadcn-style className composer. Merges Tailwind classes via
 * `tailwind-merge` so later classes win, with `clsx` handling conditionals.
 */
export function cn(...inputs: readonly ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 2: Type-check**

Run: `just typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/utils.ts
git commit -m "chore: add cn() className utility"
```

---

## Task 3: Port `sound.ts` (parity-locked)

**Files:**

- Create: `src/lib/sound.ts`

Byte-parity port of `/Users/olliegilbey/code/kanagawa-whispers/src/lib/sound.ts`. Already SSR-safe via `typeof window === "undefined"` guard.

- [ ] **Step 1: Write `src/lib/sound.ts`**

Copy verbatim from the whispers source. The full file is reproduced here so the engineer can write it without leaving the plan:

```ts
// Tiny client-side sound + mute manager. No assets — uses WebAudio oscillators
// to synthesize a friendly ping (correct) and a sad ping (wrong).

let muted = false;
const listeners = new Set<(m: boolean) => void>();

export const isMuted = () => muted;
export const setMuted = (v: boolean) => {
  muted = v;
  listeners.forEach((l) => l(v));
};
export const subscribeMute = (cb: (m: boolean) => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

let ctx: AudioContext | null = null;
function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  return ctx;
}

function tone(
  c: AudioContext,
  freq: number,
  when: number,
  dur: number,
  type: OscillatorType = "sine",
  peak = 0.18,
) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, when);
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(peak, when + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  o.connect(g).connect(c.destination);
  o.start(when);
  o.stop(when + dur + 0.05);
}

/** Bright ascending arpeggio — C5 → E5 → G5. */
export function playCorrect() {
  if (muted) return;
  const c = getCtx();
  if (!c) return;
  if (c.state === "suspended") c.resume().catch(() => {});
  const t0 = c.currentTime;
  [523.25, 659.25, 783.99].forEach((f, i) => tone(c, f, t0 + i * 0.07, 0.22, "sine", 0.16));
}

/** Soft descending two-tone — A4 → F4. */
export function playWrong() {
  if (muted) return;
  const c = getCtx();
  if (!c) return;
  if (c.state === "suspended") c.resume().catch(() => {});
  const t0 = c.currentTime;
  tone(c, 392.0, t0, 0.22, "triangle", 0.14);
  tone(c, 311.13, t0 + 0.12, 0.32, "triangle", 0.14);
}
```

Note: the file uses module-level `let muted` and `let ctx`. `eslint-plugin-functional/no-let` would normally reject this. Add a file-scoped override at the top:

```ts
/* eslint-disable functional/no-let, functional/immutable-data --
 * Parity-locked port from kanagawa-whispers. Module-level singletons (WebAudio
 * context + mute flag) are intentional. See spec §6.
 */
```

Insert that block as the first lines of the file.

- [ ] **Step 2: Type-check + lint**

Run: `just typecheck && just lint`
Expected: clean. If lint still complains, widen the disable comment to cover the specific rule names it reports.

- [ ] **Step 3: Commit**

```bash
git add src/lib/sound.ts
git commit -m "feat(ui): port sound.ts from whispers (WebAudio correct/wrong + mute manager)"
```

---

## Task 4: Port i18n module + en.json

**Files:**

- Create: `src/i18n/en.json`
- Create: `src/i18n/index.ts`

- [ ] **Step 1: Write `src/i18n/en.json`**

Start from `/Users/olliegilbey/code/kanagawa-whispers/src/i18n/en.json` byte-parity, then extend with Nalu-specific keys. Final shape:

```json
{
  "app": {
    "name": "nalu",
    "tagline": "your AI learning companion",
    "disclaimer": "nalu · responses may be inaccurate"
  },
  "greeting": {
    "morning": { "ja": "おはよう", "en": "good morning" },
    "afternoon": { "ja": "こんにちは", "en": "good afternoon" },
    "evening": { "ja": "こんばんは", "en": "good evening" },
    "night": { "ja": "おやすみ", "en": "good night" }
  },
  "home": {
    "headlineLead": "What would you like",
    "headlineTail": "to learn today",
    "suggestionsLabel": "/ start a course on",
    "suggestions": [
      { "kind": "language", "label": "conversational Japanese" },
      { "kind": "concept", "label": "how transformers work" },
      { "kind": "skill", "label": "playing chess like a 1500 elo" },
      { "kind": "history", "label": "the Edo period in 10 lessons" }
    ]
  },
  "composer": {
    "placeholderFirst": "What do you want to learn…",
    "placeholderContinue": "Reply to nalu…",
    "placeholderAnswering": "Or type your own answer…",
    "chooseLabel": "choose one · or type your own",
    "questionCounter": "{current} / {total}",
    "prev": "Previous question",
    "next": "Next question",
    "confirm": "Confirm",
    "escapeHatch": "I'd rather pick from options"
  },
  "header": {
    "newConversationTitle": "new course",
    "menu": "Menu",
    "newChat": "New course"
  },
  "menu": {
    "title": "Your courses",
    "subtitle": "pick up where you left off",
    "newCourse": "Start a new course",
    "settings": "Settings",
    "mute": "Mute sounds",
    "unmute": "Unmute sounds",
    "profileNamePlaceholder": "Your name",
    "profileSubPlaceholder": "free plan",
    "empty": "No courses yet — start your first one.",
    "courses": []
  },
  "stages": {
    "clarify": { "indicator": "Clarifying" },
    "framework": { "label": "Your learning ladder" },
    "baseline": { "indicator": "Baseline check" }
  },
  "moveOn": { "toWave": "Move on to Wave {n}" },
  "xp": { "gained": "10 XP Gained" }
}
```

Notes:

- `menu.courses` is `[]` for Nalu — whispers' inert demo courses are not ported. The SideMenu's empty-state branch already handles `length === 0`.
- The `demo.*` block from whispers is dropped — Nalu doesn't need it.

- [ ] **Step 2: Write `src/i18n/index.ts`**

Byte-parity port of whispers'. Use `unknown` instead of `any` to satisfy `no-any`:

```ts
import en from "./en.json";

type Dict = typeof en;

export const i18n: Dict = en;

/**
 * Tiny dot-path translator. e.g. t("composer.placeholderFirst")
 * Returns the raw value (string | object | array) — caller handles shape.
 */
export function t<T = string>(path: string): T {
  return path
    .split(".")
    .reduce<unknown>(
      (acc, k) => (acc == null ? acc : (acc as Record<string, unknown>)[k]),
      i18n as unknown,
    ) as T;
}

export type Greeting = {
  ja: string;
  en: string;
  key: "morning" | "afternoon" | "evening" | "night";
};

export function getGreeting(date: Date = new Date()): Greeting {
  const h = date.getHours();
  const key: Greeting["key"] =
    h >= 5 && h < 12
      ? "morning"
      : h >= 12 && h < 17
        ? "afternoon"
        : h >= 17 && h < 22
          ? "evening"
          : "night";
  const g = i18n.greeting[key];
  return { ja: g.ja, en: g.en, key };
}
```

- [ ] **Step 3: Allow JSON imports**

Confirm `tsconfig.json` has `"resolveJsonModule": true`. If absent, add it.

Run: `just typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/i18n/ tsconfig.json
git commit -m "feat(ui): port i18n module + en.json from whispers, extend with Nalu keys"
```

---

## Task 5: Extend `globals.css` with Kanagawa palette + keyframes

**Files:**

- Modify: `src/app/globals.css`

Port whispers' palette, `@theme` tokens, and keyframes. **Replace** the current minimal `globals.css` (the boilerplate is unused).

- [ ] **Step 1: Rewrite `src/app/globals.css`**

```css
@import "tailwindcss";

@theme inline {
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
  --radius-2xl: calc(var(--radius) + 8px);
  --radius-3xl: calc(var(--radius) + 12px);
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --font-sans: var(--font-geist-sans);
  --font-mono: var(--font-geist-mono);
}

:root {
  --radius: 0.75rem;

  /* Kanagawa Wave — authentic palette */
  --sumi-ink-0: #16161d;
  --sumi-ink-1: #181820;
  --sumi-ink-2: #1a1a22;
  --sumi-ink-3: #1f1f28;
  --sumi-ink-4: #2a2a37;
  --sumi-ink-5: #363646;
  --sumi-ink-6: #54546d;

  --wave-blue-1: #223249;
  --wave-blue-2: #2d4f67;

  --fuji-white: #dcd7ba;
  --old-white: #c8c093;
  --fuji-gray: #727169;
  --katana-gray: #717c7c;

  --crystal-blue: #7e9cd8;
  --spring-blue: #7fb4ca;
  --light-blue: #a3d4d5;
  --wave-aqua-2: #7aa89f;
  --spring-green: #98bb6c;
  --autumn-green: #76946a;
  --carp-yellow: #e6c384;
  --autumn-yellow: #dca561;
  --boat-yellow-2: #c0a36e;
  --surimi-orange: #ffa066;
  --sakura-pink: #d27e99;
  --wave-red: #e46876;
  --peach-red: #ff5d62;
  --oni-violet: #957fb8;
  --oni-violet-2: #b8b4d0;
  --spring-violet-2: #9cabca;
  --samurai-red: #e82424;

  /* Semantic */
  --background: var(--sumi-ink-1);
  --foreground: var(--fuji-white);
  --card: var(--sumi-ink-3);
  --card-foreground: var(--fuji-white);
  --popover: var(--sumi-ink-3);
  --popover-foreground: var(--fuji-white);
  --primary: var(--crystal-blue);
  --primary-foreground: var(--sumi-ink-0);
  --secondary: var(--sumi-ink-4);
  --secondary-foreground: var(--fuji-white);
  --muted: var(--sumi-ink-3);
  --muted-foreground: var(--fuji-gray);
  --accent: var(--sakura-pink);
  --accent-foreground: var(--sumi-ink-0);
  --destructive: var(--samurai-red);
  --destructive-foreground: var(--fuji-white);
  --border: var(--sumi-ink-4);
  --input: var(--sumi-ink-4);
  --ring: var(--crystal-blue);

  --shadow-soft: 0 1px 0 0 rgb(255 255 255 / 0.03) inset, 0 8px 24px -16px rgb(0 0 0 / 0.6);
  --shadow-glow:
    0 0 0 1px color-mix(in oklab, var(--crystal-blue) 25%, transparent),
    0 8px 32px -8px color-mix(in oklab, var(--crystal-blue) 25%, transparent);
}

@layer base {
  * {
    border-color: var(--color-border);
  }
  body {
    background-color: var(--color-background);
    color: var(--color-foreground);
    font-feature-settings: "ss01", "cv11";
    -webkit-font-smoothing: antialiased;
  }
  html,
  body {
    height: 100%;
  }
}

@layer utilities {
  .font-mono {
    font-family: var(--font-mono);
  }
  .shadow-soft {
    box-shadow: var(--shadow-soft);
  }
  .shadow-glow {
    box-shadow: var(--shadow-glow);
  }

  .text-crystal {
    color: var(--crystal-blue);
  }
  .text-sakura {
    color: var(--sakura-pink);
  }
  .text-spring-green {
    color: var(--spring-green);
  }
  .text-carp {
    color: var(--carp-yellow);
  }
  .text-aqua {
    color: var(--wave-aqua-2);
  }
  .text-oni {
    color: var(--oni-violet-2);
  }
  .text-fuji-gray {
    color: var(--fuji-gray);
  }

  .bg-sumi-0 {
    background-color: var(--sumi-ink-0);
  }
  .bg-sumi-1 {
    background-color: var(--sumi-ink-1);
  }
  .bg-sumi-2 {
    background-color: var(--sumi-ink-2);
  }
  .bg-sumi-3 {
    background-color: var(--sumi-ink-3);
  }
  .bg-sumi-4 {
    background-color: var(--sumi-ink-4);
  }
  .bg-wave-blue-1 {
    background-color: var(--wave-blue-1);
  }
  .bg-wave-blue-2 {
    background-color: var(--wave-blue-2);
  }

  .border-sumi-4 {
    border-color: var(--sumi-ink-4);
  }
  .border-sumi-5 {
    border-color: var(--sumi-ink-5);
  }

  .bg-kanagawa-atmos {
    background-color: var(--sumi-ink-1);
    background-image:
      radial-gradient(900px 500px at 85% -10%, rgb(126 156 216 / 0.1), transparent 60%),
      radial-gradient(700px 400px at -10% 110%, rgb(210 126 153 / 0.07), transparent 60%),
      radial-gradient(500px 300px at 50% 50%, rgb(122 168 159 / 0.04), transparent 70%);
  }

  .noise::before {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    opacity: 0.035;
    mix-blend-mode: overlay;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>");
  }

  @keyframes dot-pulse {
    0%,
    80%,
    100% {
      transform: translateY(0);
      opacity: 0.3;
    }
    40% {
      transform: translateY(-3px);
      opacity: 1;
    }
  }
  .typing-dot {
    animation: dot-pulse 1.3s infinite ease-in-out;
  }

  @keyframes message-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  .animate-message-in {
    animation: message-in 0.32s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }

  @keyframes q-slide-next {
    from {
      opacity: 0;
      transform: translateX(16px);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }
  @keyframes q-slide-prev {
    from {
      opacity: 0;
      transform: translateX(-16px);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }
  .animate-q-slide-next {
    animation: q-slide-next 0.28s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }
  .animate-q-slide-prev {
    animation: q-slide-prev 0.28s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }

  @keyframes pulse-correct {
    0% {
      box-shadow: 0 0 0 0 color-mix(in oklab, var(--spring-green) 0%, transparent);
      background-color: var(--sumi-ink-3);
    }
    30% {
      box-shadow: 0 0 0 6px color-mix(in oklab, var(--spring-green) 35%, transparent);
      background-color: color-mix(in oklab, var(--spring-green) 22%, var(--sumi-ink-3));
    }
    100% {
      box-shadow: 0 0 0 0 color-mix(in oklab, var(--spring-green) 0%, transparent);
      background-color: var(--sumi-ink-3);
    }
  }
  @keyframes pulse-wrong {
    0% {
      box-shadow: 0 0 0 0 color-mix(in oklab, var(--samurai-red) 0%, transparent);
      background-color: var(--sumi-ink-3);
    }
    30% {
      box-shadow: 0 0 0 6px color-mix(in oklab, var(--wave-red) 38%, transparent);
      background-color: color-mix(in oklab, var(--wave-red) 22%, var(--sumi-ink-3));
    }
    100% {
      box-shadow: 0 0 0 0 color-mix(in oklab, var(--samurai-red) 0%, transparent);
      background-color: var(--sumi-ink-3);
    }
  }
  .pulse-correct {
    animation: pulse-correct 0.7s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }
  .pulse-wrong {
    animation: pulse-wrong 0.7s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }

  .border-spring-green {
    border-color: var(--spring-green);
  }
  .border-wave-red {
    border-color: var(--wave-red);
  }
  .text-wave-red {
    color: var(--wave-red);
  }
  .bg-spring-green {
    background-color: var(--spring-green);
  }

  @keyframes wave-spin {
    0% {
      transform: rotate(0deg) scale(1);
    }
    50% {
      transform: rotate(180deg) scale(1.06);
    }
    100% {
      transform: rotate(360deg) scale(1);
    }
  }
  .wave-spin {
    animation: wave-spin 1.8s cubic-bezier(0.6, 0.05, 0.4, 0.95) infinite;
    transform-origin: 50% 50%;
  }
}
```

Notes:

- Dropped whispers' `@plugin "@tailwindcss/typography"` directive — the project hasn't added the plugin. Either:
  - **(a) Install + enable it** so `prose-*` classes work in `MessageBubble` (recommended; whispers depends on this). Run `bun add -d @tailwindcss/typography` and add the `@plugin` line back.
  - **(b)** Skip the plugin for now and accept that the assistant prose styling will look plain. Document in a follow-up.
- Pick (a). Update Step 1 accordingly:

```css
@import "tailwindcss";
@plugin "@tailwindcss/typography";
```

And run `bun add -d @tailwindcss/typography` before testing.

- [ ] **Step 2: Install typography plugin**

Run: `bun add -d @tailwindcss/typography`

- [ ] **Step 3: Verify build**

Run: `just build`
Expected: builds without CSS errors. The boilerplate page is going to be replaced soon — visual breakage is fine, but **build** must succeed.

- [ ] **Step 4: Commit**

```bash
git add src/app/globals.css package.json bun.lock
git commit -m "feat(ui): port Kanagawa palette + keyframes + typography plugin"
```

---

## Task 6: Update `RootLayout` to mount Sonner Toaster

**Files:**

- Modify: `src/app/layout.tsx`

- [ ] **Step 1: Edit layout**

Replace the existing `RootLayout` body to mount `<Toaster .../>`:

```tsx
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { Providers } from "./providers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Nalu",
  description: "AI-powered learning platform — Duolingo for anything",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
        <Toaster
          position="top-center"
          toastOptions={{ className: "font-sans text-[13px]" }}
          closeButton={false}
          richColors
        />
      </body>
    </html>
  );
}
```

- [ ] **Step 2: Type-check + build**

Run: `just typecheck && just build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/app/layout.tsx
git commit -m "feat(ui): mount sonner Toaster in root layout (top-center, richColors, no close button)"
```

---

## Task 7: Inject `x-dev-user-id` header into tRPC client

**Files:**

- Modify: `src/app/providers.tsx`
- Modify: `.env.local.example` (create if absent)

- [ ] **Step 1: Find the seeded dev user UUID**

Read `src/db/seed.ts` (or the equivalent dev seed file) to find the UUID it inserts. Note it.

Run: `grep -rE 'id:\s*"[0-9a-f-]{36}"' src/db/ | head` or similar to surface the seeded user id.

- [ ] **Step 2: Edit `src/app/providers.tsx`**

```tsx
"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { useState } from "react";
import { TRPCProvider, getBaseUrl } from "@/lib/trpc";
import type { AppRouter } from "@/server/routers";

const DEV_USER_FALLBACK = "<paste-seeded-dev-user-uuid-here>";

/**
 * Root providers — wraps the app with tRPC + TanStack Query.
 * Dev-only: injects `x-dev-user-id` header so `protectedProcedure` resolves
 * a user without real auth. Swap for a Supabase session token when auth lands.
 */
export function Providers({ children }: { readonly children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [
        httpBatchLink({
          url: `${getBaseUrl()}/api/trpc`,
          headers: () => ({
            "x-dev-user-id": process.env.NEXT_PUBLIC_DEV_USER_ID ?? DEV_USER_FALLBACK,
          }),
        }),
      ],
    }),
  );

  return (
    <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </TRPCProvider>
  );
}
```

Replace `<paste-seeded-dev-user-uuid-here>` with the UUID found in Step 1.

- [ ] **Step 3: Document env var**

If `.env.local.example` exists, append:

```
# Dev-only — the seeded user the tRPC client claims to be.
NEXT_PUBLIC_DEV_USER_ID=<seeded-dev-user-uuid>
```

Otherwise create the file with that block.

- [ ] **Step 4: Type-check**

Run: `just typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/providers.tsx .env.local.example
git commit -m "feat(ui): inject x-dev-user-id header into tRPC client (dev-only)"
```

---

## Task 8: Create `Turn` discriminated union type

**Files:**

- Create: `src/lib/types/turn.ts`

- [ ] **Step 1: Write the type**

```ts
/**
 * One entry in the rendered chat scroll. Derived from a `courses` row by
 * `deriveTurns`; never mutated by the client.
 *
 * The active questionnaire is **not** a `Turn` — the Composer renders it from
 * `useScopingState.activeQuestionnaire` (see spec §4.3).
 */
export type Turn =
  | { readonly kind: "user-topic"; readonly content: string }
  | { readonly kind: "llm-clarify-intro"; readonly content: string }
  | { readonly kind: "user-clarify-answers"; readonly content: string }
  | {
      readonly kind: "llm-framework";
      readonly userMessage: string;
      readonly tiers: ReadonlyArray<{
        readonly number: number;
        readonly name: string;
        readonly description: string;
      }>;
    }
  | { readonly kind: "llm-baseline-intro"; readonly content: string }
  | { readonly kind: "user-baseline-answers"; readonly content: string }
  | { readonly kind: "llm-baseline-close"; readonly content: string }
  | { readonly kind: "move-on-cta"; readonly nextWaveNumber: number };
```

- [ ] **Step 2: Type-check**

Run: `just typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/types/turn.ts
git commit -m "feat(types): add Turn discriminated union for chat scroll rendering"
```

---

## Task 9: `getState` lib step + test

**Files:**

- Create: `src/lib/course/getState.ts`
- Create: `src/lib/course/getState.test.ts`

This is a thin lib step over `getCourseById` that projects to the client-facing payload. Trust boundary already applied in `courseRowGuard`; we project to a stable wire shape so the client doesn't depend on the full DB row.

- [ ] **Step 1: Write failing test**

`src/lib/course/getState.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getState } from "./getState";

vi.mock("@/db/queries/courses", () => ({
  getCourseById: vi.fn(),
  NotFoundError: class NotFoundError extends Error {
    constructor(entity: string, id: string) {
      super(`${entity} not found: ${id}`);
    }
  },
}));

import { getCourseById, NotFoundError } from "@/db/queries/courses";

const mockedGetCourse = vi.mocked(getCourseById);

beforeEach(() => {
  mockedGetCourse.mockReset();
});

describe("getState", () => {
  it("projects a scoping row with only topic + clarification", async () => {
    mockedGetCourse.mockResolvedValue({
      id: "c1",
      userId: "u1",
      topic: "Linear algebra",
      status: "scoping",
      clarification: {
        userMessage: "let's clarify",
        questions: [{ id: "q1", type: "free_text", prompt: "Why?", freetextRubric: "n/a" }],
        responses: [],
      },
      framework: null,
      baseline: null,
      summary: null,
      startingTier: null,
      currentTier: 1,
      totalXp: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      summaryUpdatedAt: null,
    } as unknown as Awaited<ReturnType<typeof getCourseById>>);

    const result = await getState({ userId: "u1", courseId: "c1" });
    expect(result.courseId).toBe("c1");
    expect(result.status).toBe("scoping");
    expect(result.topic).toBe("Linear algebra");
    expect(result.clarification).not.toBeNull();
    expect(result.framework).toBeNull();
    expect(result.baseline).toBeNull();
    expect(result.scopingResult).toBeNull();
  });

  it("emits scopingResult for an active course", async () => {
    mockedGetCourse.mockResolvedValue({
      id: "c2",
      userId: "u1",
      topic: "T",
      status: "active",
      clarification: { userMessage: "c", questions: [], responses: [] },
      framework: {
        userMessage: "f",
        tiers: [{ number: 1, name: "n", description: "d", exampleConcepts: [] }],
        estimatedStartingTier: 1,
        baselineScopeTiers: [1],
      },
      baseline: {
        userMessage: "closing message",
        questions: [],
        responses: [],
        gradings: [],
        startingTier: 1,
      },
      summary: "s",
      startingTier: 1,
      currentTier: 1,
      totalXp: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
      summaryUpdatedAt: new Date(),
    } as unknown as Awaited<ReturnType<typeof getCourseById>>);

    const result = await getState({ userId: "u1", courseId: "c2" });
    expect(result.scopingResult).not.toBeNull();
    expect(result.scopingResult?.closingMessage).toBe("closing message");
    expect(result.scopingResult?.startingTier).toBe(1);
  });

  it("re-throws NotFoundError from the query layer", async () => {
    mockedGetCourse.mockRejectedValue(new NotFoundError("course", "c3"));
    await expect(getState({ userId: "u1", courseId: "c3" })).rejects.toThrow(NotFoundError);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `just test src/lib/course/getState.test.ts`
Expected: FAIL — `getState` doesn't exist.

- [ ] **Step 3: Implement `src/lib/course/getState.ts`**

```ts
import { getCourseById } from "@/db/queries/courses";
import type { ClarificationJsonb, FrameworkJsonb, BaselineJsonb } from "@/lib/types/jsonb";

export interface GetStateParams {
  readonly userId: string;
  readonly courseId: string;
}

/**
 * The portion of `scopingResult` that exists only after `submitBaseline` has
 * closed scoping. `deriveTurns` gates `move-on-cta` on this being non-null.
 */
export interface ScopingResult {
  readonly closingMessage: string;
  readonly startingTier: number;
}

export interface CourseState {
  readonly courseId: string;
  readonly status: "scoping" | "active" | "archived";
  readonly topic: string;
  readonly clarification: ClarificationJsonb | null;
  readonly framework: FrameworkJsonb | null;
  /** The pre-close baseline JSONB (questions only). Null when not yet generated. */
  readonly baseline: BaselineJsonb | null;
  /** Populated only when `status === 'active'`. Drives the Move-on CTA. */
  readonly scopingResult: ScopingResult | null;
}

/**
 * Read a course and project to the client-facing state shape.
 *
 * Trust boundary: `getCourseById` runs `courseRowGuard` which Zod-validates
 * every JSONB column. Ownership is enforced by passing `userId`; rows owned
 * by other users surface as `NotFoundError` (info-leak-safe).
 */
export async function getState(params: GetStateParams): Promise<CourseState> {
  const course = await getCourseById(params.courseId, params.userId);

  const baseline = (course.baseline as BaselineJsonb | null) ?? null;
  const scopingResult: ScopingResult | null =
    course.status === "active" && baseline !== null && "startingTier" in baseline
      ? {
          closingMessage: baseline.userMessage,
          startingTier: baseline.startingTier,
        }
      : null;

  return {
    courseId: course.id,
    status: course.status as CourseState["status"],
    topic: course.topic,
    clarification: (course.clarification as ClarificationJsonb | null) ?? null,
    framework: (course.framework as FrameworkJsonb | null) ?? null,
    baseline,
    scopingResult,
  };
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `just test src/lib/course/getState.test.ts`
Expected: all three tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/course/getState.ts src/lib/course/getState.test.ts
git commit -m "feat(course): add getState lib step — projects DB row to client state"
```

---

## Task 10: Add `course.getState` tRPC procedure

**Files:**

- Modify: `src/server/routers/course.ts`

- [ ] **Step 1: Add procedure**

Add to `courseRouter`:

```ts
import { getState } from "@/lib/course/getState";
// ...
getState: protectedProcedure
  .input(z.object({ courseId: z.string().uuid() }))
  .query(({ ctx, input }) => getState({ userId: ctx.userId, courseId: input.courseId })),
```

Place it before `clarify` (alphabetical-ish within the router). Final file should still be under 200 lines.

- [ ] **Step 2: Type-check + lint**

Run: `just typecheck && just lint`
Expected: clean.

- [ ] **Step 3: Run existing tests**

Run: `just test src/server/routers`
Expected: existing course router tests still pass.

- [ ] **Step 4: Commit**

```bash
git add src/server/routers/course.ts
git commit -m "feat(api): add course.getState query procedure"
```

---

## Task 11: `deriveTurns` pure function + case-table test

**Files:**

- Create: `src/lib/course/deriveTurns.ts`
- Create: `src/lib/course/deriveTurns.test.ts`

- [ ] **Step 1: Write failing test (case table)**

`src/lib/course/deriveTurns.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveTurns } from "./deriveTurns";
import type { CourseState } from "./getState";

function baseState(overrides: Partial<CourseState>): CourseState {
  return {
    courseId: "c",
    status: "scoping",
    topic: "Linear algebra",
    clarification: null,
    framework: null,
    baseline: null,
    scopingResult: null,
    ...overrides,
  };
}

describe("deriveTurns", () => {
  it("emits only user-topic when only topic exists", () => {
    const turns = deriveTurns(baseState({}));
    expect(turns).toEqual([{ kind: "user-topic", content: "Linear algebra" }]);
  });

  it("adds llm-clarify-intro when clarification is present", () => {
    const turns = deriveTurns(
      baseState({
        clarification: {
          userMessage: "Let's narrow this down.",
          questions: [{ id: "q1", type: "free_text", prompt: "Why?", freetextRubric: "n/a" }],
          responses: [],
        },
      }),
    );
    expect(turns).toEqual([
      { kind: "user-topic", content: "Linear algebra" },
      { kind: "llm-clarify-intro", content: "Let's narrow this down." },
    ]);
  });

  it("emits user-clarify-answers + llm-framework once framework lands", () => {
    const turns = deriveTurns(
      baseState({
        clarification: {
          userMessage: "Let's narrow this down.",
          questions: [
            { id: "q1", type: "free_text", prompt: "Why are you learning?", freetextRubric: "n/a" },
            { id: "q2", type: "free_text", prompt: "Prior experience?", freetextRubric: "n/a" },
          ],
          responses: [
            { questionId: "q1", freetext: "to pass an exam" },
            { questionId: "q2", freetext: "calc 1" },
          ],
        },
        framework: {
          userMessage: "Here's your ladder.",
          tiers: [
            { number: 1, name: "Foundations", description: "Numbers", exampleConcepts: [] },
            { number: 2, name: "Vectors", description: "Magnitude", exampleConcepts: [] },
          ],
          estimatedStartingTier: 1,
          baselineScopeTiers: [1, 2],
        },
      }),
    );

    const kinds = turns.map((t) => t.kind);
    expect(kinds).toEqual([
      "user-topic",
      "llm-clarify-intro",
      "user-clarify-answers",
      "llm-framework",
    ]);
    const userAnswers = turns.find((t) => t.kind === "user-clarify-answers")!;
    expect(userAnswers).toMatchObject({
      content: expect.stringContaining("Why are you learning?"),
    });
    expect(userAnswers).toMatchObject({
      content: expect.stringContaining("to pass an exam"),
    });
    const framework = turns.find((t) => t.kind === "llm-framework")!;
    expect(framework).toMatchObject({
      userMessage: "Here's your ladder.",
      tiers: [
        { number: 1, name: "Foundations", description: "Numbers" },
        { number: 2, name: "Vectors", description: "Magnitude" },
      ],
    });
  });

  it("adds llm-baseline-intro once baseline questions exist (still scoping)", () => {
    const turns = deriveTurns(
      baseState({
        clarification: {
          userMessage: "c",
          questions: [],
          responses: [],
        },
        framework: {
          userMessage: "f",
          tiers: [],
          estimatedStartingTier: 1,
          baselineScopeTiers: [1],
        },
        baseline: {
          userMessage: "Let's check what you know.",
          questions: [],
          responses: [],
          gradings: [],
        },
      }),
    );

    const intro = turns.find((t) => t.kind === "llm-baseline-intro")!;
    expect(intro).toEqual({ kind: "llm-baseline-intro", content: "Let's check what you know." });
    expect(turns.find((t) => t.kind === "move-on-cta")).toBeUndefined();
  });

  it("emits user-baseline-answers + close + move-on-cta when scopingResult lands", () => {
    const turns = deriveTurns(
      baseState({
        status: "active",
        clarification: {
          userMessage: "c",
          questions: [],
          responses: [],
        },
        framework: {
          userMessage: "f",
          tiers: [],
          estimatedStartingTier: 1,
          baselineScopeTiers: [1],
        },
        baseline: {
          userMessage: "Nicely done.",
          questions: [
            {
              id: "b1",
              type: "multiple_choice",
              prompt: "What is 2+2?",
              options: { A: "3", B: "4", C: "5", D: "6" },
              correct: "B",
              freetextRubric: "n/a",
              conceptName: "addition",
              tier: 1,
            },
          ],
          responses: [{ questionId: "b1", choice: "B" }],
          gradings: [],
          startingTier: 1,
        } as unknown as NonNullable<CourseState["baseline"]>,
        scopingResult: { closingMessage: "Nicely done.", startingTier: 1 },
      }),
    );

    const kinds = turns.map((t) => t.kind);
    expect(kinds).toEqual([
      "user-topic",
      "llm-clarify-intro",
      "user-clarify-answers",
      "llm-framework",
      "llm-baseline-intro",
      "user-baseline-answers",
      "llm-baseline-close",
      "move-on-cta",
    ]);
    expect(turns.at(-1)).toEqual({ kind: "move-on-cta", nextWaveNumber: 1 });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `just test src/lib/course/deriveTurns.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/lib/course/deriveTurns.ts`**

```ts
import type { Turn } from "@/lib/types/turn";
import type { CourseState } from "./getState";
import type { ClarificationJsonb, BaselineJsonb } from "@/lib/types/jsonb";

/**
 * Project a `CourseState` to the chat scroll `Turn[]`.
 *
 * Deterministic and pure. Each downstream turn depends on the presence of a
 * specific JSONB column on the row, in this order:
 *
 *   topic → clarification → (clarify responses present → framework) → baseline
 *   → (scopingResult present → close + move-on-cta)
 *
 * The active questionnaire (clarify or baseline) is not a turn — the Composer
 * renders it separately from `useScopingState.activeQuestionnaire`.
 */
export function deriveTurns(state: CourseState): readonly Turn[] {
  const turns: Turn[] = [{ kind: "user-topic", content: state.topic }];

  if (state.clarification) {
    turns.push({ kind: "llm-clarify-intro", content: state.clarification.userMessage });
  }

  // Once the framework lands, clarify responses are guaranteed to be saved
  // (generateFramework persists them before calling the LLM — see
  // src/lib/course/generateFramework.ts:86-92). Emit the user-clarify-answers
  // turn from the persisted responses so a reload renders identically.
  if (state.framework && state.clarification) {
    turns.push({
      kind: "user-clarify-answers",
      content: concatClarifyAnswers(state.clarification),
    });
    turns.push({
      kind: "llm-framework",
      userMessage: state.framework.userMessage,
      tiers: state.framework.tiers.map((t) => ({
        number: t.number,
        name: t.name,
        description: t.description,
      })),
    });
  }

  if (state.baseline) {
    turns.push({ kind: "llm-baseline-intro", content: state.baseline.userMessage });
  }

  if (state.scopingResult && state.baseline) {
    turns.push({
      kind: "user-baseline-answers",
      content: concatBaselineAnswers(state.baseline),
    });
    turns.push({ kind: "llm-baseline-close", content: state.scopingResult.closingMessage });
    turns.push({ kind: "move-on-cta", nextWaveNumber: 1 });
  }

  return turns;
}

function concatClarifyAnswers(c: ClarificationJsonb): string {
  const byId = new Map(c.questions.map((q) => [q.id, q]));
  return c.responses
    .map((r, i) => {
      const q = byId.get(r.questionId);
      const prompt = q?.prompt ?? `Q${i + 1}`;
      return `${i + 1}. ${prompt} — ${r.freetext ?? ""}`;
    })
    .join("\n");
}

function concatBaselineAnswers(b: BaselineJsonb): string {
  const byId = new Map(b.questions.map((q) => [q.id, q]));
  return b.responses
    .map((r, i) => {
      const q = byId.get(r.questionId);
      const prompt = q?.prompt ?? `Q${i + 1}`;
      const answer =
        r.choice !== undefined
          ? q && q.type === "multiple_choice"
            ? q.options[r.choice]
            : r.choice
          : (r.freetext ?? "");
      return `${i + 1}. ${prompt} — ${answer}`;
    })
    .join("\n");
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `just test src/lib/course/deriveTurns.test.ts`
Expected: all five tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/course/deriveTurns.ts src/lib/course/deriveTurns.test.ts
git commit -m "feat(course): add deriveTurns(state) — pure projection from CourseState to Turn[]"
```

---

## Task 12: Question → ChoiceQuestion adapter + test

**Files:**

- Create: `src/lib/course/adaptQuestionnaire.ts`
- Create: `src/lib/course/adaptQuestionnaire.test.ts`

The whispers Composer takes `ChoiceQuestion[]` — `{ id, prompt, options: string[], correctIndex? }`. Nalu's `Question` is a discriminated union. The adapter bridges them.

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import { adaptQuestionnaire } from "./adaptQuestionnaire";
import type { Question } from "@/lib/prompts/questionnaire";

describe("adaptQuestionnaire", () => {
  it("adapts MC questions and derives correctIndex from `correct` letter key", () => {
    const qs: readonly Question[] = [
      {
        id: "b1",
        type: "multiple_choice",
        prompt: "What is 2+2?",
        options: { A: "3", B: "4", C: "5", D: "6" },
        correct: "B",
        freetextRubric: "n/a",
        conceptName: "addition",
        tier: 1,
      },
    ];
    const result = adaptQuestionnaire(qs);
    expect(result.mode).toBe("mc");
    expect(result.questions).toEqual([
      {
        id: "b1",
        prompt: "What is 2+2?",
        options: ["3", "4", "5", "6"],
        correctIndex: 1,
      },
    ]);
  });

  it("leaves correctIndex undefined when `correct` is absent (clarify-style MC)", () => {
    const qs: readonly Question[] = [
      {
        id: "c1",
        type: "multiple_choice",
        prompt: "Pick one",
        options: { A: "a", B: "b", C: "c", D: "d" },
        freetextRubric: "n/a",
      },
    ];
    const r = adaptQuestionnaire(qs);
    expect(r.questions[0].correctIndex).toBeUndefined();
  });

  it("adapts free-text questions to ChoiceQuestion with empty options array", () => {
    const qs: readonly Question[] = [
      {
        id: "f1",
        type: "free_text",
        prompt: "Why are you learning?",
        freetextRubric: "n/a",
      },
    ];
    const r = adaptQuestionnaire(qs);
    expect(r.mode).toBe("free-text");
    expect(r.questions).toEqual([{ id: "f1", prompt: "Why are you learning?", options: [] }]);
  });

  it("classifies mode as 'mc' only when every question has options", () => {
    const qs: readonly Question[] = [
      {
        id: "m1",
        type: "multiple_choice",
        prompt: "p",
        options: { A: "1", B: "2", C: "3", D: "4" },
        freetextRubric: "n/a",
      },
      {
        id: "m2",
        type: "free_text",
        prompt: "p2",
        freetextRubric: "n/a",
      },
    ];
    const r = adaptQuestionnaire(qs);
    expect(r.mode).toBe("mixed");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `just test src/lib/course/adaptQuestionnaire.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement adapter**

```ts
import type { Question, McOptionKey } from "@/lib/prompts/questionnaire";

/** Whispers Composer's question shape. Kept in sync with the upstream type. */
export interface ChoiceQuestion {
  readonly id: string;
  readonly prompt: string;
  /** Empty array means free-text-only. */
  readonly options: readonly string[];
  readonly correctIndex?: number;
}

const KEY_TO_INDEX: Record<McOptionKey, number> = { A: 0, B: 1, C: 2, D: 3 };

export interface AdaptedQuestionnaire {
  readonly mode: "mc" | "free-text" | "mixed";
  readonly questions: readonly ChoiceQuestion[];
}

/**
 * Adapt a Nalu `Question[]` to the whispers Composer's `ChoiceQuestion[]`.
 *
 * - `multiple_choice` → options materialised as a 4-element string array in
 *   A,B,C,D order; `correct` letter (if present) becomes `correctIndex`.
 * - `free_text` → `options: []`. The Composer's pure-free-text branch
 *   renders the textarea instead of the option grid for these.
 *
 * Mode is informational for the caller; the Composer doesn't strictly need it
 * (it inspects `options.length === 0` per question) but `useScopingState`
 * uses it to decide whether to render the MC `chooseLabel` header.
 */
export function adaptQuestionnaire(qs: readonly Question[]): AdaptedQuestionnaire {
  const questions = qs.map((q): ChoiceQuestion => {
    if (q.type === "multiple_choice") {
      return {
        id: q.id,
        prompt: q.prompt,
        options: [q.options.A, q.options.B, q.options.C, q.options.D],
        correctIndex: q.correct !== undefined ? KEY_TO_INDEX[q.correct] : undefined,
      };
    }
    return { id: q.id, prompt: q.prompt, options: [] };
  });

  const hasMc = qs.some((q) => q.type === "multiple_choice");
  const hasFree = qs.some((q) => q.type === "free_text");
  const mode: AdaptedQuestionnaire["mode"] =
    hasMc && hasFree ? "mixed" : hasMc ? "mc" : "free-text";

  return { mode, questions };
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `just test src/lib/course/adaptQuestionnaire.test.ts`
Expected: all four tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/course/adaptQuestionnaire.ts src/lib/course/adaptQuestionnaire.test.ts
git commit -m "feat(course): add Question→ChoiceQuestion adapter for whispers Composer"
```

---

## Task 13: Port `ui/sheet.tsx`

**Files:**

- Create: `src/components/ui/sheet.tsx`

Byte-parity port of `/Users/olliegilbey/code/kanagawa-whispers/src/components/ui/sheet.tsx`. Already a "use client" file. Depends on `cn` (Task 2) and the Radix package (Task 1).

- [ ] **Step 1: Write the file**

Copy the whispers `sheet.tsx` content verbatim (123 lines). Reproduced for self-containment:

```tsx
"use client";

import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;
const SheetPortal = SheetPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Overlay
    className={cn(
      "fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
    ref={ref}
  />
));
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName;

const sheetVariants = cva(
  "fixed z-50 gap-4 bg-background p-6 shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500 data-[state=open]:animate-in data-[state=closed]:animate-out",
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
        bottom:
          "inset-x-0 bottom-0 border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
        left: "inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm",
        right:
          "inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm",
      },
    },
    defaultVariants: { side: "right" },
  },
);

interface SheetContentProps
  extends
    React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content>,
    VariantProps<typeof sheetVariants> {}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  SheetContentProps
>(({ side = "right", className, children, ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <SheetPrimitive.Content ref={ref} className={cn(sheetVariants({ side }), className)} {...props}>
      <SheetPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-secondary">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </SheetPrimitive.Close>
      {children}
    </SheetPrimitive.Content>
  </SheetPortal>
));
SheetContent.displayName = SheetPrimitive.Content.displayName;

export { Sheet, SheetPortal, SheetOverlay, SheetTrigger, SheetClose, SheetContent };
```

Notes:

- The `slide-in-from-left` / `fade-in-0` data-state classes come from `tw-animate-css` in whispers. Nalu doesn't have that plugin; the sheet will still **function** (Radix's mount/unmount logic), the slide animation just won't run. Acceptable for MVP. If polish requires it, add `bun add -d tw-animate-css` and `@import "tw-animate-css";` in `globals.css` as a follow-up.

- [ ] **Step 2: Type-check + lint**

Run: `just typecheck && just lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/sheet.tsx
git commit -m "feat(ui): port Radix-backed Sheet primitive from whispers"
```

---

## Task 14: Port `ChatHeader.tsx`

**Files:**

- Create: `src/components/chat/ChatHeader.tsx`

- [ ] **Step 1: Write the file**

Byte-parity port from whispers. Add `"use client"` since it uses `onClick`/`aria-label` props that React handles client-side, and a parent client component will pass callbacks. Match this file:

```tsx
"use client";

import { Menu, SquarePen } from "lucide-react";
import { t } from "@/i18n";

export function ChatHeader({
  onNew,
  onMenu,
  title,
}: {
  onNew?: () => void;
  onMenu?: () => void;
  /** When omitted, shows the app wordmark. When set, shows the conversation title. */
  title?: string | null;
}) {
  const showTitle = !!title;
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

      <button
        onClick={onNew}
        aria-label={t("header.newChat")}
        className="h-9 w-9 -mr-2 grid place-items-center rounded-lg text-fuji-gray hover:text-foreground hover:bg-sumi-3 transition-colors"
      >
        <SquarePen className="h-[17px] w-[17px]" strokeWidth={1.75} />
      </button>
    </header>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `just typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/chat/ChatHeader.tsx
git commit -m "feat(ui): port ChatHeader byte-parity from whispers"
```

---

## Task 15: Port `MessageBubble.tsx` + `WaveSpinner`

**Files:**

- Create: `src/components/chat/MessageBubble.tsx`

- [ ] **Step 1: Write the file**

Byte-parity port from whispers (`/Users/olliegilbey/code/kanagawa-whispers/src/components/chat/MessageBubble.tsx`, 129 lines). Prepend `"use client"`. Copy verbatim. Re-read the whispers source before pasting if uncertain about formatting.

Key blocks to preserve exactly:

- `ChatMessage` type export.
- The asymmetric rendering: user → `<p className="whitespace-pre-wrap">{message.content}</p>` (no markdown); assistant → `<ReactMarkdown remarkPlugins={[remarkGfm]} components={...}>{message.content}</ReactMarkdown>` inside the long `prose-*` className chain.
- `TypingBubble` exported alongside.
- `WaveSpinner` SVG block (two `<path>` arcs + circle, mirrored via `<g transform="rotate(180 20 20)">`, on the `.wave-spin` class).

- [ ] **Step 2: Type-check**

Run: `just typecheck`
Expected: clean. If `ReactMarkdown` types don't line up with `react-markdown` v10's exports, adjust the `components` prop typing to match the installed version.

- [ ] **Step 3: Commit**

```bash
git add src/components/chat/MessageBubble.tsx
git commit -m "feat(ui): port MessageBubble + TypingBubble + WaveSpinner byte-parity from whispers"
```

---

## Task 16: Port `EmptyState.tsx`

**Files:**

- Create: `src/components/chat/EmptyState.tsx`

- [ ] **Step 1: Write the file**

Byte-parity port. Prepend `"use client"`. Source: whispers `EmptyState.tsx` (69 lines).

- [ ] **Step 2: Type-check**

Run: `just typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/chat/EmptyState.tsx
git commit -m "feat(ui): port EmptyState byte-parity from whispers"
```

---

## Task 17: Port `SideMenu.tsx`

**Files:**

- Create: `src/components/chat/SideMenu.tsx`

- [ ] **Step 1: Write the file**

Byte-parity port. Prepend `"use client"`. Source: whispers `SideMenu.tsx` (163 lines). Functional `MuteToggle` in the footer uses `src/lib/sound.ts`.

- [ ] **Step 2: Type-check**

Run: `just typecheck`
Expected: clean. The `t<Course[]>("menu.courses")` call must return `[]` — confirmed by the `en.json` rewrite in Task 4.

- [ ] **Step 3: Commit**

```bash
git add src/components/chat/SideMenu.tsx
git commit -m "feat(ui): port SideMenu byte-parity from whispers (inert nav, functional mute toggle)"
```

---

## Task 18: Port `Composer.tsx` + Nalu deltas

**Files:**

- Create: `src/components/chat/Composer.tsx`

The Composer is the largest port and the only parity-locked file where Nalu adds new behavior. Three deltas:

1. **Pure-free-text questionnaire mode** — when the current question has `options.length === 0`, render the textarea + counter + chevrons instead of the option grid. Send records the typed value and advances.
2. **`persistKey?: string` prop** — when set, hydrate `answers` and `step` from `localStorage.getItem(persistKey)` on mount; write on every change; clear when `onComplete` fires.
3. **Move-on mode** — when `moveOn` prop is set, the bottom row is a single labelled button instead of input + send/confirm.

- [ ] **Step 1: Start from whispers source**

Begin with the whispers `Composer.tsx` (337 lines) byte-parity. Prepend `"use client"`. Keep all existing logic (`questionsKey`, `answers`, `pending`, `feedback`, `step`, `locked`, `slideDir`, `selectOption`, `confirmSelection`, `advanceAfterAnswer`, `goPrev`, `goNext`, `handleSend`, sounds, toast, pulse classes).

- [ ] **Step 2: Add the new props**

Extend the component prop type:

```ts
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
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled?: boolean;
  questions?: ChoiceQuestion[] | null;
  onComplete?: (answers: { question: ChoiceQuestion; answer: string }[]) => void;
  isFirstMessage?: boolean;
  /** localStorage key for refresh-resilient questionnaire buffer. */
  persistKey?: string;
  /** When set, replaces the input row with a single advance button. */
  moveOn?: { readonly label: string; readonly onAdvance: () => void };
}) {
  /* ... */
}
```

Re-export `ChoiceQuestion` from `@/lib/course/adaptQuestionnaire` instead of redefining it:

```ts
export type { ChoiceQuestion } from "@/lib/course/adaptQuestionnaire";
```

(Remove the local `export type ChoiceQuestion` at the top of the whispers source.)

- [ ] **Step 3: Add free-text-per-question rendering**

In the JSX block that renders the option grid (inside the slide window), conditionally render either the option grid (when `current.options.length > 0`) or a free-text-only hint. The textarea is already in the Composer; for free-text-only questions the hint just reads the prompt and prompts the learner to type. Concretely, replace:

```tsx
<div className="grid grid-cols-1 gap-1.5">
  {current.options.map((opt, i) => {
    /* ... button JSX ... */
  })}
</div>
```

with:

```tsx
{
  current.options.length > 0 ? (
    <div className="grid grid-cols-1 gap-1.5">
      {current.options.map((opt, i) => {
        /* unchanged button JSX */
      })}
    </div>
  ) : (
    <p className="px-1 text-[12px] text-fuji-gray italic">
      {t<string>("composer.placeholderAnswering")}
    </p>
  );
}
```

`handleSend` already correctly routes free-text input through `advanceAfterAnswer(answer)` when `hasQuestions && !confirmMode`, so typing in the textarea + Enter advances the questionnaire. No further logic change needed.

- [ ] **Step 4: Add `persistKey` hydration + writes**

Near the top of the function (after the `questionsKey` `useMemo`):

```tsx
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
    // Only hydrate if the questions are the same batch.
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

// Write through on changes.
useEffect(() => {
  if (!persistKey || typeof window === "undefined" || !hasQuestions) return;
  try {
    window.localStorage.setItem(persistKey, JSON.stringify({ questionsKey, answers, step }));
  } catch {
    // Quota / disabled — ignore.
  }
}, [persistKey, questionsKey, answers, step, hasQuestions]);
```

Inside `advanceAfterAnswer`, after the `onComplete?.(...)` call (in the every-answer-set branch), clear the buffer:

```tsx
if (next.every((a) => a != null)) {
  if (persistKey && typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(persistKey);
    } catch {
      /* ignore */
    }
  }
  onComplete?.(questions!.map((q, i) => ({ question: q, answer: next[i]! })));
  return;
}
```

- [ ] **Step 5: Add Move-on mode**

At the very top of the returned JSX (before the question header block), short-circuit when `moveOn` is set:

```tsx
if (moveOn) {
  return (
    <div className="px-3 pb-4 pt-3 bg-sumi-1/85 backdrop-blur-xl border-t border-sumi-4/60">
      <button
        onClick={moveOn.onAdvance}
        className="w-full h-11 inline-flex items-center justify-center rounded-2xl bg-spring-green text-sumi-0 font-medium tracking-tight transition active:scale-[0.99] hover:brightness-110"
      >
        {moveOn.label}
      </button>
      <p className="mt-2.5 text-center font-mono text-[10px] tracking-wider text-fuji-gray/80">
        {t<string>("app.disclaimer")}
      </p>
    </div>
  );
}
```

This must come before the `hasQuestions && current && (...)` block so a Move-on-state Composer never renders the questionnaire header.

- [ ] **Step 6: Type-check + lint**

Run: `just typecheck && just lint`
Expected: clean. If `eslint-plugin-functional/immutable-data` flags the in-place `next[step] = ...` assignments in `advanceAfterAnswer`/`selectOption`, add a file-scoped disable comment at the top:

```ts
/* eslint-disable functional/immutable-data --
 * Parity-locked port from kanagawa-whispers. Local array mutations are
 * confined to handler closures whose results re-enter React state via setX.
 */
```

- [ ] **Step 7: Commit**

```bash
git add src/components/chat/Composer.tsx
git commit -m "feat(ui): port Composer + Nalu deltas (free-text questions, persistKey, move-on mode)"
```

---

## Task 19: New `FrameworkTierList.tsx`

**Files:**

- Create: `src/components/chat/FrameworkTierList.tsx`

Nalu-only component — renders the structured tier list inside the LLM prose stream of the framework turn.

- [ ] **Step 1: Write the file**

```tsx
import { t } from "@/i18n";

export interface FrameworkTier {
  readonly number: number;
  readonly name: string;
  readonly description: string;
}

/**
 * Structured renderer for the framework turn's tier ladder. Visually part of
 * the LLM-side prose stream, not a card. Sits below the framework's
 * `userMessage` markdown body.
 */
export function FrameworkTierList({ tiers }: { readonly tiers: readonly FrameworkTier[] }) {
  return (
    <div className="mt-3 mb-2">
      <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-fuji-gray mb-2">
        {t<string>("stages.framework.label")}
      </p>
      <ol className="space-y-2">
        {tiers.map((tier) => (
          <li key={tier.number} className="flex items-start gap-3">
            <span className="font-mono text-[11px] text-crystal shrink-0 w-6 tabular-nums">
              {String(tier.number).padStart(2, "0")}
            </span>
            <div className="min-w-0">
              <p className="text-[14px] font-medium text-foreground/95 leading-tight">
                {tier.name}
              </p>
              <p className="text-[13px] text-foreground/75 leading-snug">{tier.description}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `just typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/chat/FrameworkTierList.tsx
git commit -m "feat(ui): add FrameworkTierList — structured tier renderer inside LLM prose stream"
```

---

## Task 20: `useScopingState` hook

**Files:**

- Create: `src/hooks/useScopingState.ts`

The hook glues `course.getState` to `deriveTurns` + the three mutation procedures, plus the questionnaire adapter and the auto-dispatch of `generateBaseline`.

- [ ] **Step 1: Write the hook**

```ts
"use client";

import { useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import { deriveTurns } from "@/lib/course/deriveTurns";
import { adaptQuestionnaire, type ChoiceQuestion } from "@/lib/course/adaptQuestionnaire";
import type { Turn } from "@/lib/types/turn";
import type { CourseState } from "@/lib/course/getState";

export interface ActiveQuestionnaire {
  readonly kind: "clarify" | "baseline";
  readonly questions: readonly ChoiceQuestion[];
  /** Stable identity for the active question set — feeds the Composer's reset key. */
  readonly questionsKey: string;
  /** Stable per-courseId+stage key for refresh-resilient localStorage buffer. */
  readonly persistKey: string;
}

export interface UseScopingStateResult {
  readonly turns: readonly Turn[];
  readonly activeQuestionnaire: ActiveQuestionnaire | null;
  readonly scopingResult: CourseState["scopingResult"];
  readonly isPending: boolean;
  readonly submitClarify: (
    answers: { readonly questionId: string; readonly freetext: string }[],
  ) => void;
  readonly submitBaselineAnswers: (
    answers: ReadonlyArray<
      | { readonly id: string; readonly kind: "mc"; readonly selected: "A" | "B" | "C" | "D" }
      | {
          readonly id: string;
          readonly kind: "freetext";
          readonly text: string;
          readonly fromEscape: boolean;
        }
    >,
  ) => void;
}

/**
 * Drive the scoping flow for one course.
 *
 * Reads server state via `course.getState`; on mutation success, invalidates
 * the query so derived `turns` re-compute. Auto-dispatches `generateBaseline`
 * once `framework` lands and `baseline` is still null — gated on the mutation
 * not already being in flight to avoid double-fire during refetch races.
 *
 * Hook is portable: no DOM, no Next imports. The mutations are dispatched via
 * `@trpc/tanstack-react-query` mutation options.
 */
export function useScopingState(courseId: string): UseScopingStateResult {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const stateOpts = trpc.course.getState.queryOptions({ courseId });
  const state = useQuery(stateOpts);

  const invalidateState = () => qc.invalidateQueries({ queryKey: stateOpts.queryKey });

  const generateFramework = useMutation(
    trpc.course.generateFramework.mutationOptions({ onSuccess: invalidateState }),
  );
  const generateBaseline = useMutation(
    trpc.course.generateBaseline.mutationOptions({ onSuccess: invalidateState }),
  );
  const submitBaseline = useMutation(
    trpc.course.submitBaseline.mutationOptions({ onSuccess: invalidateState }),
  );

  const turns = useMemo(() => (state.data ? deriveTurns(state.data) : []), [state.data]);

  const activeQuestionnaire = useMemo<ActiveQuestionnaire | null>(() => {
    if (!state.data) return null;
    const s = state.data;

    // Clarify is active while there's a clarification with no responses AND
    // no framework yet.
    if (s.clarification && s.clarification.responses.length === 0 && !s.framework) {
      const { questions } = adaptQuestionnaire(s.clarification.questions);
      return {
        kind: "clarify",
        questions,
        questionsKey: questions.map((q) => q.id).join("|"),
        persistKey: `nalu:scoping:${s.courseId}:clarify`,
      };
    }

    // Baseline is active while there's a baseline with no responses AND status
    // still 'scoping' (so the close hasn't landed).
    if (s.baseline && s.baseline.responses.length === 0 && s.status === "scoping") {
      const { questions } = adaptQuestionnaire(s.baseline.questions);
      return {
        kind: "baseline",
        questions,
        questionsKey: questions.map((q) => q.id).join("|"),
        persistKey: `nalu:scoping:${s.courseId}:baseline`,
      };
    }

    return null;
  }, [state.data]);

  // Auto-dispatch generateBaseline when framework is present and baseline is not.
  // Use a ref guard so we don't re-fire during refetch settling.
  const baselineDispatchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!state.data) return;
    if (state.data.framework && !state.data.baseline && state.status === "success") {
      if (baselineDispatchedFor.current === state.data.courseId) return;
      if (generateBaseline.isPending) return;
      baselineDispatchedFor.current = state.data.courseId;
      generateBaseline.mutate({ courseId: state.data.courseId });
    }
  }, [state.data, state.status, generateBaseline]);

  const isPending =
    state.isFetching ||
    generateFramework.isPending ||
    generateBaseline.isPending ||
    submitBaseline.isPending;

  const submitClarify = (answers: { readonly questionId: string; readonly freetext: string }[]) => {
    generateFramework.mutate({ courseId, responses: answers });
  };

  const submitBaselineAnswers: UseScopingStateResult["submitBaselineAnswers"] = (answers) => {
    submitBaseline.mutate({ courseId, answers: answers as never });
  };

  return {
    turns,
    activeQuestionnaire,
    scopingResult: state.data?.scopingResult ?? null,
    isPending,
    submitClarify,
    submitBaselineAnswers,
  };
}
```

- [ ] **Step 2: Type-check**

Run: `just typecheck`
Expected: clean. If `submitBaseline.mutate`'s answer-shape inference rejects `as never`, replace it with a properly-typed cast that matches `inferProcedureInput<AppRouter['course']['submitBaseline']>['answers']`. The router's input schema is the source of truth — see `src/server/routers/course.ts:64-79`.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useScopingState.ts
git commit -m "feat(ui): add useScopingState — derives turns, gates auto-dispatch, exposes mutations"
```

---

## Task 21: `ChatShell.tsx` — composition layer

**Files:**

- Create: `src/components/chat/ChatShell.tsx`

Adapted from whispers' `routes/index.tsx`, minus the demo state. Holds the header + side-menu trigger + scrolling region + Composer. Pure composition — no business logic.

- [ ] **Step 1: Write the file**

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChatHeader } from "./ChatHeader";
import { SideMenu } from "./SideMenu";

/**
 * Layout shell shared by the empty home page and the in-course chat view.
 *
 * Children render the scroll content; the parent owns Composer rendering and
 * passes it as `composer` so it stays sticky at the bottom.
 *
 * Course title (when present) is shown in the header. The side-menu nav is
 * inert for MVP (it always opens a fresh empty `/` per parity with whispers'
 * demo behavior — clicking a course just resets).
 */
export function ChatShell({
  title,
  children,
  composer,
  onNew,
}: {
  readonly title?: string | null;
  readonly children: ReactNode;
  readonly composer: ReactNode;
  readonly onNew: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [children]);

  return (
    <div className="relative flex flex-col h-[100dvh] bg-kanagawa-atmos text-foreground overflow-hidden noise">
      <ChatHeader title={title ?? null} onMenu={() => setMenuOpen(true)} onNew={onNew} />

      <SideMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        activeCourseId={null}
        onSelectCourse={() => {
          setMenuOpen(false);
          onNew();
        }}
        onNewCourse={() => {
          setMenuOpen(false);
          onNew();
        }}
      />

      <main ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5 space-y-5">
        {children}
      </main>

      {composer}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `just typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/chat/ChatShell.tsx
git commit -m "feat(ui): add ChatShell — composition layer adapted from whispers routes/index.tsx"
```

---

## Task 22: `TopicInput.tsx` — empty-state wrapper

**Files:**

- Create: `src/components/chat/TopicInput.tsx`

- [ ] **Step 1: Write the file**

```tsx
"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTRPC } from "@/lib/trpc";
import { ChatShell } from "./ChatShell";
import { Composer } from "./Composer";
import { EmptyState } from "./EmptyState";

/**
 * Empty home screen: greeting + suggestions + free-text Composer.
 * Submitting the topic calls `course.clarify` and routes to `/course/{id}`.
 */
export function TopicInput() {
  const router = useRouter();
  const trpc = useTRPC();
  const [value, setValue] = useState("");

  const clarify = useMutation(
    trpc.course.clarify.mutationOptions({
      onSuccess: (result) => {
        router.push(`/course/${result.courseId}`);
      },
    }),
  );

  const send = (text?: string) => {
    const content = (text ?? value).trim();
    if (!content) return;
    setValue("");
    clarify.mutate({ topic: content });
  };

  return (
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
      <EmptyState onPick={(topic) => send(topic)} />
    </ChatShell>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `just typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/chat/TopicInput.tsx
git commit -m "feat(ui): add TopicInput — empty home screen that calls course.clarify"
```

---

## Task 23: `Onboarding.tsx` — wires `useScopingState` into shell

**Files:**

- Create: `src/components/chat/Onboarding.tsx`

This is where `Turn[]` becomes JSX and the Composer's mode is chosen.

- [ ] **Step 1: Write the file**

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useScopingState } from "@/hooks/useScopingState";
import { ChatShell } from "./ChatShell";
import { Composer } from "./Composer";
import { MessageBubble, TypingBubble, type ChatMessage } from "./MessageBubble";
import { FrameworkTierList } from "./FrameworkTierList";
import { t } from "@/i18n";

/**
 * Drives the chat scroll + Composer mode for a given courseId.
 *
 * Reads turns/active questionnaire/result from `useScopingState`; maps Turn[]
 * to bubble JSX (with FrameworkTierList for the framework turn); selects
 * Composer mode (free-text idle / question / move-on) based on derived state.
 */
export function Onboarding({ courseId }: { readonly courseId: string }) {
  const router = useRouter();
  const {
    turns,
    activeQuestionnaire,
    scopingResult,
    isPending,
    submitClarify,
    submitBaselineAnswers,
  } = useScopingState(courseId);

  const [composerValue, setComposerValue] = useState("");

  // Map Turn[] → array of <MessageBubble> / structured renderers.
  const scroll = turns.map((turn, idx) => {
    switch (turn.kind) {
      case "user-topic":
      case "user-clarify-answers":
      case "user-baseline-answers": {
        const msg: ChatMessage = { id: `t${idx}`, role: "user", content: turn.content };
        return <MessageBubble key={idx} message={msg} />;
      }
      case "llm-clarify-intro":
      case "llm-baseline-intro":
      case "llm-baseline-close": {
        const msg: ChatMessage = { id: `t${idx}`, role: "assistant", content: turn.content };
        return <MessageBubble key={idx} message={msg} />;
      }
      case "llm-framework": {
        const msg: ChatMessage = { id: `t${idx}`, role: "assistant", content: turn.userMessage };
        return (
          <div key={idx}>
            <MessageBubble message={msg} />
            <FrameworkTierList tiers={turn.tiers} />
          </div>
        );
      }
      case "move-on-cta":
        return null;
    }
  });

  // Compute composer mode.
  const moveOn = scopingResult
    ? {
        label: t<string>("moveOn.toWave").replace("{n}", "1"),
        onAdvance: () => router.push(`/course/${courseId}/wave/1`),
      }
    : undefined;

  return (
    <ChatShell
      title={null}
      onNew={() => router.push("/")}
      composer={
        <Composer
          value={composerValue}
          onChange={setComposerValue}
          onSend={() => {
            // Free-text-only submit path is unused on this screen for MVP — the
            // Composer enters question mode whenever activeQuestionnaire is set,
            // and Move-on mode otherwise. A plain text send falls through here.
            setComposerValue("");
          }}
          disabled={isPending}
          questions={activeQuestionnaire ? [...activeQuestionnaire.questions] : null}
          persistKey={activeQuestionnaire?.persistKey}
          moveOn={moveOn}
          onComplete={(answers) => {
            if (!activeQuestionnaire) return;
            if (activeQuestionnaire.kind === "clarify") {
              submitClarify(
                answers.map((a) => ({ questionId: a.question.id, freetext: a.answer })),
              );
            } else {
              // Baseline. Each answer is either an MC selection (when the user
              // tapped an option) or a free-text reply (typed answer, escape
              // hatch). Disambiguate by matching `answer` against the question's
              // options array.
              const submission = answers.map((a) => {
                const idx = a.question.options.indexOf(a.answer);
                const isMcSelection = idx >= 0 && a.question.options.length > 0;
                if (isMcSelection) {
                  const letter = (["A", "B", "C", "D"] as const)[idx];
                  return { id: a.question.id, kind: "mc" as const, selected: letter };
                }
                return {
                  id: a.question.id,
                  kind: "freetext" as const,
                  text: a.answer,
                  // fromEscape = the question HAS options but the user typed instead.
                  fromEscape: a.question.options.length > 0,
                };
              });
              submitBaselineAnswers(submission);
            }
          }}
        />
      }
    >
      {scroll}
      {isPending && <TypingBubble />}
    </ChatShell>
  );
}
```

- [ ] **Step 2: Type-check + lint**

Run: `just typecheck && just lint`
Expected: clean. If lint complains about the unused branch fall-through in `onSend`, simplify the lambda to a no-op `() => setComposerValue("")`.

- [ ] **Step 3: Commit**

```bash
git add src/components/chat/Onboarding.tsx
git commit -m "feat(ui): add Onboarding — wires useScopingState into ChatShell + Composer"
```

---

## Task 24: Update `app/page.tsx` to mount `TopicInput`

**Files:**

- Modify: `src/app/page.tsx`

- [ ] **Step 1: Replace boilerplate**

```tsx
import { TopicInput } from "@/components/chat/TopicInput";

export default function Home() {
  return <TopicInput />;
}
```

- [ ] **Step 2: Type-check + build**

Run: `just typecheck && just build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat(ui): replace home boilerplate with TopicInput empty state"
```

---

## Task 25: Add `app/course/[id]/page.tsx`

**Files:**

- Create: `src/app/course/[id]/page.tsx`

Next 16 returns `params` as a `Promise<{...}>`. Server Component awaits it and passes `courseId` to the client `Onboarding` component.

- [ ] **Step 1: Write the file**

```tsx
import { Onboarding } from "@/components/chat/Onboarding";

export default async function CoursePage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  return <Onboarding courseId={id} />;
}
```

- [ ] **Step 2: Type-check + build**

Run: `just typecheck && just build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/app/course/[id]/page.tsx
git commit -m "feat(ui): add /course/[id] route that mounts Onboarding"
```

---

## Task 26: Stub Wave 1 route

**Files:**

- Create: `src/app/course/[id]/wave/[n]/page.tsx`

Out of scope for this PR but the Move-on CTA needs a landing page.

- [ ] **Step 1: Write a placeholder**

```tsx
export default async function WavePage({
  params,
}: {
  readonly params: Promise<{ readonly id: string; readonly n: string }>;
}) {
  const { n } = await params;
  return (
    <main className="flex min-h-screen items-center justify-center bg-kanagawa-atmos text-foreground">
      <div className="text-center px-6">
        <h1 className="text-[28px] font-medium tracking-tight">Wave {n} coming soon</h1>
        <p className="mt-3 text-fuji-gray text-[14px]">The teaching loop ships in a follow-up.</p>
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Type-check + build**

Run: `just typecheck && just build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/app/course/[id]/wave/[n]/page.tsx
git commit -m "feat(ui): stub /course/[id]/wave/[n] placeholder for Move-on landing"
```

---

## Task 27: `useScopingState` test

**Files:**

- Create: `src/hooks/useScopingState.test.tsx`

Hook test — runs against a mocked tRPC client. Goal: confirm the adapter wiring and auto-dispatch gating, **not** the underlying mutations.

- [ ] **Step 1: Write the test**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// Mock tRPC context to provide hand-shaped queryOptions/mutationOptions.
vi.mock("@/lib/trpc", () => {
  const stateData = {
    courseId: "c1",
    status: "scoping",
    topic: "T",
    clarification: {
      userMessage: "intro",
      questions: [{ id: "q1", type: "free_text", prompt: "Why?", freetextRubric: "n/a" }],
      responses: [],
    },
    framework: null,
    baseline: null,
    scopingResult: null,
  };
  const stateOpts = {
    queryKey: ["course.getState", { courseId: "c1" }] as const,
    queryFn: async () => stateData,
  };
  return {
    useTRPC: () => ({
      course: {
        getState: { queryOptions: () => stateOpts },
        generateFramework: {
          mutationOptions: (o: { onSuccess?: () => void }) => ({
            mutationFn: async () => {
              o.onSuccess?.();
              return {};
            },
          }),
        },
        generateBaseline: {
          mutationOptions: (o: { onSuccess?: () => void }) => ({
            mutationFn: async () => {
              o.onSuccess?.();
              return {};
            },
          }),
        },
        submitBaseline: {
          mutationOptions: (o: { onSuccess?: () => void }) => ({
            mutationFn: async () => {
              o.onSuccess?.();
              return {};
            },
          }),
        },
      },
    }),
  };
});

import { useScopingState } from "./useScopingState";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  // jsdom localStorage clear
  if (typeof window !== "undefined") window.localStorage.clear();
});

describe("useScopingState", () => {
  it("derives turns + an active clarify questionnaire", async () => {
    const { result } = renderHook(() => useScopingState("c1"), { wrapper });
    await waitFor(() => expect(result.current.turns.length).toBeGreaterThan(0));

    const kinds = result.current.turns.map((t) => t.kind);
    expect(kinds).toContain("user-topic");
    expect(kinds).toContain("llm-clarify-intro");
    expect(result.current.activeQuestionnaire).not.toBeNull();
    expect(result.current.activeQuestionnaire?.kind).toBe("clarify");
    expect(result.current.activeQuestionnaire?.persistKey).toBe("nalu:scoping:c1:clarify");
  });
});
```

- [ ] **Step 2: Install testing-library if absent**

Run: `bun pm ls | grep @testing-library/react`

If absent:

```bash
bun add -d @testing-library/react @testing-library/dom jsdom
```

And ensure `vitest.config.ts` (or `vite.config.ts`) has `test.environment: "jsdom"` for the unit project. Skip this step if the project already has jsdom + testing-library set up; check existing component-test files first.

- [ ] **Step 3: Run — expect PASS**

Run: `just test src/hooks/useScopingState.test.tsx`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useScopingState.test.tsx vitest.config.ts package.json bun.lock
git commit -m "test(hooks): smoke test useScopingState — derives clarify questionnaire from row"
```

(Skip the config/package files if they didn't change.)

---

## Task 28: Manual UI verification

**Files:** none

- [ ] **Step 1: Start dev server**

Run: `just dev`
Watch the console for errors.

- [ ] **Step 2: Click through the flow**

Open `http://localhost:3000` and check, in order:

1. Empty home renders with the greeting, headline, four suggestions, and the sticky Composer.
2. Open the side menu — see the empty courses block + functional mute toggle in the footer.
3. Type a topic (e.g. "linear algebra for ML"), press send.
4. Routes to `/course/<uuid>`. WaveSpinner shows while `clarify` resolves.
5. User topic bubble renders right-aligned (plain text). Below it: LLM clarify intro as a left-flush prose stream.
6. Composer enters question mode with N-of-M counter + chevrons. Answer all clarify questions (free-text textarea — no option grid since clarify is `free_text`).
7. User-clarify-answers bubble renders (numbered Q—A pairs). WaveSpinner returns while `generateFramework` runs.
8. Framework appears: `userMessage` prose + numbered tier list (number, name, description; no example concepts).
9. Auto-dispatched `generateBaseline` produces baseline questions. The intro bubble renders, then the Composer enters question mode again.
10. Baseline MC questions: tap an option → button highlights with green border, primary action becomes a Confirm button. Tap Confirm → sound plays (if not muted), pulse animation, "10 XP Gained" toast (if correct), advances to next question.
11. Baseline free-text questions: typing in the textarea + Enter advances.
12. After last baseline answer: user-baseline-answers bubble renders, WaveSpinner while `submitBaseline` runs, then the closing model message lands.
13. Composer transforms into the **"Move on to Wave 1"** button. Confirm it was **not** visible before this point.
14. Refresh the page mid-questionnaire — in-progress answers + step should restore.

- [ ] **Step 3: Note any divergences from whispers**

Compare side-by-side with whispers at `cd /Users/olliegilbey/code/kanagawa-whispers && bun dev`. Any visible divergence (other than the data being real) is a parity bug — fix before merging.

- [ ] **Step 4: No commit for verification**

(Manual step; no diff to commit unless bugs were fixed inline.)

---

## Task 29: `just check`

**Files:** none

- [ ] **Step 1: Run the full pipeline**

Run: `just check`
Expected: lint + typecheck + unit tests all green.

- [ ] **Step 2: Fix anything red**

Iterate until green. **Do not** suppress hook errors with `--no-verify`.

- [ ] **Step 3: Run build**

Run: `just build`
Expected: succeeds.

- [ ] **Step 4: No commit for verification**

---

## Task 30: Open PR

**Files:** none

- [ ] **Step 1: Check tree**

Run: `git status && git log main..HEAD --oneline`
Expected: ~25-30 commits, working tree clean.

- [ ] **Step 2: Push**

Run: `git push -u origin feat/onboarding-ui`

- [ ] **Step 3: Open PR**

Confirm with the user before running `gh pr create`. Suggested title: `feat: chat-shape onboarding UI wired to scoping tRPC procedures`.

Body should reference the spec, summarize the new components, list new deps, and link the parity-locked whispers files.

---

## Notes for the implementer

- **If a parity-locked file appears to differ from whispers**, re-read the whispers source (`/Users/olliegilbey/code/kanagawa-whispers/src/...`) and align. Don't "improve" anything; even small className tweaks defeat the parity goal.
- **The `correct` MC key is intentionally shipped to the client** — see the spec §4.6 reference to `src/lib/prompts/baseline.ts:77-78`. Don't add a stripping step.
- **Auto-dispatch of `generateBaseline`** must be idempotent. The server-side replay guard in `generateBaseline.ts` is the safety net; the client-side `useRef` guard in `useScopingState` avoids double-fire from the React 19 strict-mode double-invoke during dev.
- **Wave 1 priming** lives on the server. The `move-on-cta` cannot render before `submitBaseline` resolves — `deriveTurns` enforces this via the `scopingResult` gate.
- **No `useQuestionnaire` hook.** The Composer owns the multi-question state machine internally. If you find yourself wanting to extract it, stop and re-read spec §4.7.
