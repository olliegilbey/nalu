import en from "./en.json";

type Dict = typeof en;

/** Active translation dictionary. English-only for MVP; locale loader lands later. */
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

/** Bilingual greeting payload — `key` identifies the time-of-day bucket. */
export type Greeting = {
  ja: string;
  en: string;
  key: "morning" | "afternoon" | "evening" | "night";
};

/**
 * Pick a time-of-day greeting from `i18n.greeting`. Uses local hours of the
 * provided `date` (defaults to now). Bucketing: 5-12 morning, 12-17 afternoon,
 * 17-22 evening, else night.
 */
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
