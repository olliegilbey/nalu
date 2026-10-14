/**
 * The keys of a multiple-choice question's options, in display order. The one
 * home of the A-D set: wire, storage and input schemas all pin to it. MC cards
 * always carry four options. There is no "Not sure" key: the free-text escape
 * is the non-engagement affordance.
 */
export const MC_OPTION_KEYS = ["A", "B", "C", "D"] as const;

/** One MC option key: a question's `correct` key or a learner's `choice`. */
export type McOptionKey = (typeof MC_OPTION_KEYS)[number];
