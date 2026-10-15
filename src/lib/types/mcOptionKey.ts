/**
 * The keys of a multiple-choice question's options, in display order. The one
 * home of the A-D set: wire, storage and input schemas all pin to it. MC cards
 * always carry four options. There is no "Not sure" key: the free-text escape
 * is the non-engagement affordance.
 */
export const MC_OPTION_KEYS = ["A", "B", "C", "D"] as const;

/** One MC option key: a question's `correct` key or a learner's `choice`. */
export type McOptionKey = (typeof MC_OPTION_KEYS)[number];

/** An MC question's option texts, keyed by option key. */
export type McOptions = Readonly<Record<McOptionKey, string>>;

/**
 * Option key → index, in `MC_OPTION_KEYS` order (A=0 .. D=3). The envelope,
 * the Composer and the `correctEnc` obfuscation (`encodeCorrect` in
 * `src/lib/security/obfuscateCorrect.ts`) all read this one table, so their
 * numeric encodings cannot drift. `satisfies` fails the build if the key set
 * changes and this table does not.
 */
export const KEY_TO_INDEX = { A: 0, B: 1, C: 2, D: 3 } as const satisfies Record<
  McOptionKey,
  number
>;
