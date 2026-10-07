"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { overlayToggleButtonClassName } from "./terminal-chart-panel-layout";

export interface ChartOverlayToggleGroupProps {
  showExecutions: boolean;
  showSignals: boolean;
  onToggleExecutions: () => void;
  onToggleSignals: () => void;
}

const OVERLAY_BUTTON_CLASS =
  "h-7 rounded-sm border px-2 text-xs font-semibold transition-colors";

/**
 * The chart's "My Orders" / "Signals" overlay toggles, extracted from
 * TerminalChartPanel so it is a leaf component with no hooks: the click
 * isolation (it sits inside a clickable command bar / drawer header) and the
 * active/inactive styling are unit-testable by calling this function directly
 * and invoking the handlers it wires up (see terminal-chart-panel.test.ts).
 */
export function ChartOverlayToggleGroup({
  showExecutions,
  showSignals,
  onToggleExecutions,
  onToggleSignals,
}: ChartOverlayToggleGroupProps) {
  return (
    <div
      role="group"
      aria-label="Chart overlays"
      className="flex h-8 shrink-0 items-center gap-0.5 rounded-md bg-muted p-0.5"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Button
        type="button"
        variant="ghost"
        aria-label="Toggle my orders overlay"
        aria-pressed={showExecutions}
        className={cn(
          OVERLAY_BUTTON_CLASS,
          overlayToggleButtonClassName(showExecutions),
        )}
        onClick={onToggleExecutions}
      >
        My Orders
      </Button>
      <Button
        type="button"
        variant="ghost"
        aria-label="Toggle signals overlay"
        aria-pressed={showSignals}
        className={cn(
          OVERLAY_BUTTON_CLASS,
          overlayToggleButtonClassName(showSignals),
        )}
        onClick={onToggleSignals}
      >
        Signals
      </Button>
    </div>
  );
}
