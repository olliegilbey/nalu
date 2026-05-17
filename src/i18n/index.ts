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
