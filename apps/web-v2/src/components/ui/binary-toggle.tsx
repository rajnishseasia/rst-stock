import { cn } from "@/lib/utils";

/**
 * Segmented two-option toggle used in place of <Select> for binary fields
 * (Asset Type, Side/Direction, Call/Put). A real dropdown for two choices means
 * an extra open/pick interaction; the toggle lets the user flip values in a
 * single tap and shows both options at all times.
 *
 * Generic over the value type so it works with the form's union-string types
 * ("EQUITY" | "OPTION", "long" | "short", "call" | "put", ...).
 *
 * `tone` has no "gold" member on purpose. It had one, nothing ever passed it,
 * and a solid `bg-primary` fill sitting unused in a shared primitive is how
 * the next gold slab gets seeded (DESIGN.md: gold is a seasoning, not a
 * sauce). Direction is the only thing worth a solid fill here, so the toned
 * sides are the green/red the ticket CTAs use; anything else is neutral.
 */
export function BinaryToggle<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: ReadonlyArray<{
    value: T;
    label: string;
    tone?: "positive" | "negative" | "neutral";
    disabled?: boolean;
    title?: string;
  }>;
  onChange: (next: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="terminal-binary-toggle flex h-10 w-full items-center rounded-full border bg-muted/80 p-0.5 xl:h-8"
    >
      {options.map((opt) => {
        const isActive = value === opt.value;
        const tone = opt.tone ?? "neutral";
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            data-tone={tone}
            data-state={isActive ? "active" : "inactive"}
            aria-disabled={opt.disabled || undefined}
            disabled={opt.disabled}
            title={opt.title}
            onClick={() => {
              if (!isActive && !opt.disabled) onChange(opt.value);
            }}
            className={cn(
              // Active toned sides use the same solid fills as the ticket
              // submit CTAs so "which way am I trading" reads at a glance.
              "flex h-9 flex-1 items-center justify-center rounded-full border border-transparent px-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isActive &&
                tone === "positive" &&
                "border-transparent bg-green-500 text-black",
              isActive &&
                tone === "negative" &&
                "border-transparent bg-red-500 text-white",
              isActive &&
                tone === "neutral" &&
                "border-border bg-background text-foreground",
              !isActive &&
                tone === "positive" &&
                "text-muted-foreground hover:bg-green-500/10",
              !isActive &&
                tone === "negative" &&
                "text-muted-foreground hover:bg-red-500/10",
              !isActive &&
                tone === "neutral" &&
                "text-muted-foreground hover:bg-background/60 hover:text-foreground",
              opt.disabled &&
                "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
