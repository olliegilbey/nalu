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

/** A colour utility on a Kanagawa palette name, with any variants and opacity modifier. */
const KANAGAWA_CLASS =
  /^(?:[\w-]+:)*(?:bg|text|border|ring|outline|fill|stroke|from|via|to|decoration|divide|caret|accent)-(?:sumi|wave|fuji|old-white|katana|crystal|spring|light-blue|aqua|autumn|carp|boat|surimi|sakura|peach|oni|samurai)[\w-]*(?:\/\d+)?$/;

/** Every Kanagawa colour class in the `.tsx` source of components and routes. */
function kanagawaClassesInUse(): string[] {
  const files = ["components", "app"].flatMap((dir) =>
    readdirSync(path.join(SRC_DIR, dir), { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".tsx") && !file.endsWith(".test.tsx"))
      .map((file) => path.join(SRC_DIR, dir, file)),
  );
  // Split on quotes, whitespace and braces: class strings break into tokens.
  const tokens = files.flatMap((file) => readFileSync(file, "utf8").split(/[\s"'`{}()]+/));
  return [...new Set(tokens.filter((token) => KANAGAWA_CLASS.test(token)))].sort();
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
});
