import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Conventional shadcn-style className composer. Merges Tailwind classes via
 * `tailwind-merge` so later classes win, with `clsx` handling conditionals.
 */
export function cn(...inputs: readonly ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Copy of `items` with slot `index` set to `value`. The input is untouched.
 *
 * Same result as `const copy = [...items]; copy[index] = value`, so an index
 * past the end extends the copy. `Array#with` would throw a RangeError there.
 */
export function replaceAt<T>(items: readonly T[], index: number, value: T): T[] {
  const copy = [...items];
  copy[index] = value;
  return copy;
}
