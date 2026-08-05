"use client";

import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

/** Cookie values read server-side by `parseLlmProviderCookie`. */
type ProviderChoice = "corti" | "cerebras";

const PROVIDER_OPTIONS: ReadonlyArray<{ value: ProviderChoice; label: string; sub: string }> = [
  { value: "corti", label: "corti-s1", sub: "clinical" },
  { value: "cerebras", label: "gpt-oss-120b", sub: "general" },
];

/** Persist the model choice; server reads it per request (ALS binding). */
function writeProviderCookie(value: ProviderChoice) {
  document.cookie = `nalu-llm-provider=${value}; path=/; max-age=31536000; samesite=lax`;
}

/**
 * Full-screen intro overlay shown on every visit to the home screen. Ported
 * from the kanagawa-whispers reference UI. The reference's shadcn `<Button>` is
 * replaced with a plain button (Nalu has no `ui/button`); `animate-in fade-in`
 * is replaced with the `.animate-fade-in` utility added in `globals.css`.
 */
export function Splash({ onStart }: { readonly onStart: () => void }) {
  // Default corti on this deployment; hydrate any prior choice from the
  // cookie post-mount (same SSR-mismatch pattern as EmptyState's greeting).
  const [provider, setProvider] = useState<ProviderChoice>("corti");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: client-only cookie hydration
    if (document.cookie.includes("nalu-llm-provider=cerebras")) setProvider("cerebras");
  }, []);

  const pick = (value: ProviderChoice) => {
    setProvider(value);
    writeProviderCookie(value);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-kanagawa-atmos text-foreground noise animate-fade-in">
      <div className="flex-1 overflow-y-auto px-6 py-10 flex items-center justify-center">
        <div className="w-full max-w-md mx-auto space-y-6">
          <div className="inline-flex items-center gap-2 rounded-full border border-sumi-4/60 bg-sumi-3/40 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-fuji-gray">
            <Sparkles className="h-3 w-3 text-spring-green" strokeWidth={2.25} />
            work in progress
          </div>

          <h1 className="text-3xl font-semibold leading-tight tracking-tight">
            Hi, I&apos;m Ollie - welcome to <span className="text-crystal">nalu</span>.
          </h1>

          <div className="space-y-4 text-[15px] leading-relaxed text-fuji-gray">
            <p>
              A little side project of mine - think{" "}
              <strong className="font-medium text-foreground">Duolingo, but for anything</strong>{" "}
              you want to learn.
            </p>
            <p>
              The prompting and model are WIP, but this should give you a real feel for where
              it&apos;s heading.
            </p>
            <p>
              Nalu is an AI learning app with a{" "}
              <strong className="font-medium text-foreground">real progression system</strong> that
              tracks a learner&apos;s understanding and gamifies the journey, rather than the
              stateless back-and-forth of a plain chatbot.
            </p>
          </div>
        </div>
      </div>

      <div className="px-6 pb-8 pt-2">
        <div className="mx-auto w-full max-w-md">
          <div className="mb-3">
            <p className="mb-1.5 text-[10px] font-mono uppercase tracking-[0.2em] text-fuji-gray">
              model
            </p>
            <div className="grid grid-cols-2 gap-1.5">
              {PROVIDER_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => pick(opt.value)}
                  aria-pressed={provider === opt.value}
                  className={`h-10 rounded-xl border text-[13px] font-medium transition ${
                    provider === opt.value
                      ? "border-spring-green/60 bg-sumi-3/60 text-foreground"
                      : "border-sumi-4/60 bg-transparent text-fuji-gray hover:border-sumi-5"
                  }`}
                >
                  {opt.label} <span className="font-normal text-fuji-gray">· {opt.sub}</span>
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={onStart}
            style={{ color: "var(--sumi-ink-0)" }}
            className="w-full h-12 inline-flex items-center justify-center rounded-xl text-[15px] font-medium bg-spring-green transition active:scale-[0.99] hover:brightness-110 shadow-glow"
          >
            Start learning
          </button>
          <p className="mt-3 text-center text-[11px] text-fuji-gray">
            nalu · a work in progress by Ollie
          </p>
        </div>
      </div>
    </div>
  );
}
