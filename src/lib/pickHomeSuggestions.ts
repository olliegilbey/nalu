/** One home-screen suggestion. The label alone is the topic; `kind` only picks its accent colour. */
export type HomeSuggestion = { readonly kind: string; readonly label: string };

/** Home suggestion labels grouped by kind, as authored in `home.suggestionPool` in `en.json`. */
export type HomeSuggestionPool = Readonly<Record<string, readonly string[]>>;

/**
 * Pick one suggestion per kind from the home pool.
 *
 * The pool groups labels by kind, so the result holds each kind once, in pool
 * order, and the accent colours stay varied. `random` returns a float in
 * [0, 1), like `Math.random`. It is injected so tests can pin the pick.
 */
export function pickHomeSuggestions(
  pool: HomeSuggestionPool,
  random: () => number,
): readonly HomeSuggestion[] {
  return Object.entries(pool).map(([kind, labels]) => {
    const index = Math.floor(random() * labels.length);
    const label = labels[index];
    // An empty kind, or a source outside [0, 1), lands outside the list.
    if (label === undefined) throw new Error(`no home suggestion for kind "${kind}" at ${index}`);
    return { kind, label };
  });
}
