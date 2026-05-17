"use client";

import { ArrowUpRight } from "lucide-react";
import { useEffect, useState } from "react";
import { t, getGreeting, type Greeting } from "@/i18n";

const KIND_COLORS: Record<string, string> = {
  language: "var(--sakura-pink)",
  concept: "var(--crystal-blue)",
  skill: "var(--wave-aqua-2)",
  history: "var(--carp-yellow)",
  plan: "var(--crystal-blue)",
  explain: "var(--sakura-pink)",
  write: "var(--wave-aqua-2)",
  ideate: "var(--carp-yellow)",
};

type Suggestion = { kind: string; label: string };

export function EmptyState({ onPick }: { onPick: (t: string) => void }) {
  // Compute on the client only to avoid SSR/CSR hydration mismatch on time-of-day.
  // setState-in-effect is the React-recommended pattern for this exact case
  // (client-only values that must not run during SSR).
  const [greeting, setGreeting] = useState<Greeting | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: client-only hydration of time-of-day greeting
    setGreeting(getGreeting());
  }, []);

  const suggestions = t<Suggestion[]>("home.suggestions");
  const headlineLead = t<string>("home.headlineLead");
  const headlineTail = t<string>("home.headlineTail");
  const suggestionsLabel = t<string>("home.suggestionsLabel");

  return (
    <div className="flex flex-col h-full px-1 pt-12">
      <div className="space-y-1.5">
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-fuji-gray">
          {greeting ? (
            <>
              {greeting.ja} · {greeting.en}
            </>
          ) : (
            <>&nbsp;</>
          )}
        </p>
        <h1 className="text-[28px] leading-[1.15] font-medium tracking-tight">
          {headlineLead}
          <br />
          <span className="text-fuji-gray">{headlineTail}</span>
          <span className="text-sakura-pink">?</span>
        </h1>
      </div>

      <div className="mt-10 space-y-px">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-fuji-gray pb-2">
          {suggestionsLabel}
        </p>
        {suggestions.map((s) => (
          <button
            key={s.label}
            onClick={() => onPick(`${s.kind} ${s.label}`)}
            className="group w-full flex items-center justify-between gap-3 py-3.5 border-b border-sumi-4/70 text-left hover:border-sumi-5 transition-colors"
          >
            <span className="flex items-baseline gap-2.5 min-w-0">
              <span
                className="font-mono text-[11px] uppercase tracking-wider shrink-0"
                style={{ color: KIND_COLORS[s.kind] ?? "var(--crystal-blue)" }}
              >
                {s.kind}
              </span>
              <span className="text-[15px] text-foreground/85 truncate">{s.label}</span>
            </span>
            <ArrowUpRight
              className="h-4 w-4 text-fuji-gray group-hover:text-foreground group-hover:-translate-y-0.5 group-hover:translate-x-0.5 transition-all shrink-0"
              strokeWidth={1.75}
            />
          </button>
        ))}
      </div>
    </div>
  );
}
