import { t } from "@/i18n";

/** One rung of the framework's tier ladder rendered below the framework turn. */
export interface FrameworkTier {
  readonly number: number;
  readonly name: string;
  readonly description: string;
}

/**
 * Structured renderer for the framework turn's tier ladder. Visually part of
 * the LLM-side prose stream, not a card. Sits below the framework's
 * `userMessage` markdown body.
 */
export function FrameworkTierList({ tiers }: { readonly tiers: readonly FrameworkTier[] }) {
  return (
    <div className="mt-3 mb-2">
      <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-fuji-gray mb-2">
        {t<string>("stages.framework.label")}
      </p>
      <ol className="space-y-2">
        {tiers.map((tier) => (
          <li key={tier.number} className="flex items-start gap-3">
            <span className="font-mono text-[11px] text-crystal shrink-0 w-6 tabular-nums">
              {String(tier.number).padStart(2, "0")}
            </span>
            <div className="min-w-0">
              <p className="text-[14px] font-medium text-foreground/95 leading-tight">
                {tier.name}
              </p>
              <p className="text-[13px] text-foreground/75 leading-snug">{tier.description}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
