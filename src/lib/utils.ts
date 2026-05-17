import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Conventional shadcn-style className composer. Merges Tailwind classes via
 * `tailwind-merge` so later classes win, with `clsx` handling conditionals.
 */
export function cn(...inputs: readonly ClassValue[]): string {
  return twMerge(clsx(inputs));
}
