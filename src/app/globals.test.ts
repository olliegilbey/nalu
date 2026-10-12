import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import typography from "@tailwindcss/typography";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";

/*
 * Every Kanagawa colour class the UI uses must generate CSS (issues #77, #106).
 *
 * Tailwind silently drops a class it cannot build. A plain class hand-written
 * in `@layer utilities` renders as written, but Tailwind builds no variants
 * (`hover:`, `focus-within:`, `prose-a:`) or opacity modifiers (`/50`) for it.
 * So `text-sumi-0` and `hover:border-crystal/50` were silent no-ops. This test
 * compiles `globals.css` with the repo's Tailwind, then checks each Kanagawa
 * class found in the component source.
 */

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.dirname(APP_DIR);
const require = createRequire(import.meta.url);

/**
 * A colour utility on a Kanagawa palette name, with any variants and opacity
 * modifier. Covers side borders (`border-t-…`) and coloured shadows.
 */
const KANAGAWA_CLASS =
  /^(?:[\w-]+:)*(?:bg|text|border(?:-[xytrblse])?|ring|outline|fill|stroke|from|via|to|decoration|divide|caret|accent|shadow)-(?:sumi|wave|fuji|old-white|katana|crystal|spring|light-blue|aqua|autumn|carp|boat|surimi|sakura|peach|oni|samurai)[\w-]*(?:\/\d+)?$/;

/**
 * Every Kanagawa colour class in the non-test `.ts` and `.tsx` source under
 * `src/`. Names built from template parts are out of reach; write them whole.
 */
function kanagawaClassesInUse(): string[] {
  const files = readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => path.join(SRC_DIR, file));
  // Split on quotes, whitespace and braces: class strings break into tokens.
  const tokens = files.flatMap((file) => readFileSync(file, "utf8").split(/[\s"'`{}()]+/));
  return [...new Set(tokens.filter((token) => KANAGAWA_CLASS.test(token)))].sort();
}

/** The body of the first `selector { … }` block in `css`. The blocks checked here hold no nested braces. */
function blockBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no ${selector} block in globals.css`);
  return css.slice(start, css.indexOf("}", start));
}

/** Compile `globals.css` the way the app build does: Tailwind core plus the typography plugin. */
async function compileGlobals() {
  const css = readFileSync(path.join(APP_DIR, "globals.css"), "utf8");
  return compile(css, {
    base: APP_DIR,
    loadStylesheet: async (id) => {
      // `@import "tailwindcss"` is the only stylesheet import.
      const file = require.resolve(id === "tailwindcss" ? "tailwindcss/index.css" : id);
      return { path: file, base: path.dirname(file), content: readFileSync(file, "utf8") };
    },
    loadModule: async (id, base) => {
      if (id !== "@tailwindcss/typography") throw new Error(`unexpected @plugin ${id}`);
      return { path: id, base, module: typography };
    },
  });
}

/** True when the compiled CSS holds a rule for `className`. Tailwind escapes `:` and `/` in selectors. */
function hasRule(css: string, className: string): boolean {
  const selector = "." + className.replace(/[^\w-]/g, (ch) => `\\${ch}`);
  return css.includes(`${selector} {`);
}

describe("globals.css Kanagawa colours", () => {
  it("generates CSS for every Kanagawa colour class the UI uses", async () => {
    const classes = kanagawaClassesInUse();
    // The issue classes, so an empty scan cannot pass by accident.
    expect(classes).toEqual(
      expect.arrayContaining([
        "text-sumi-0",
        "hover:border-crystal/50",
        "group-hover:text-crystal",
        "focus-within:border-crystal/50",
      ]),
    );

    const css = (await compileGlobals()).build(classes);
    const missing = classes.filter((className) => !hasRule(css, className));
    expect(missing).toEqual([]);
  });

  it("points every theme colour at a variable defined in :root", () => {
    // A typo such as `var(--carp-yelow)` compiles fine and renders nothing.
    const css = readFileSync(path.join(APP_DIR, "globals.css"), "utf8");
    const theme = blockBody(css, "@theme inline");
    const rootVariables = new Set(
      [...blockBody(css, ":root").matchAll(/(--[\w-]+):/g)].map((match) => match[1]),
    );
    const colourTargets = [...theme.matchAll(/--color-[\w-]+:\s*var\((--[\w-]+)\)/g)].map(
      (match) => match[1],
    );

    expect(colourTargets).toContain("--crystal-blue");
    expect(colourTargets.filter((target) => !rootVariables.has(target))).toEqual([]);
  });
});
