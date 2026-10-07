/**
 * The row of filter buttons under a left-drawer tab ("All authors", "Latest",
 * "Price pills", ...). Pure over props (no hooks), extracted out of page.tsx's
 * `renderLeftSubHeader` closure (audit H7: self-contained UI section into its
 * own component) so it is renderable and clickable directly in a test,
 * instead of only checkable by reading page.tsx as a string.
 *
 * page.tsx still owns which action is active per pane and what a click does
 * (`getLeftSubheaderActions` / `handleLeftSubHeaderAction`); this component
 * only paints the given `activeAction` and reports a pick via `onSelect`.
 */

import { LEFT_TERMINAL_SUBHEADERS, type LeftSubheaderAction } from "./terminal-shell-config";
import type { LeftTerminalTab } from "@/components/terminal/terminal-layout-state";
import { cn } from "@/lib/utils";

export function LeftSubheaderBar({
  tab,
  activeAction,
  onSelect,
}: {
  tab: LeftTerminalTab;
  activeAction: LeftSubheaderAction;
  onSelect: (action: LeftSubheaderAction) => void;
}) {
  const items = LEFT_TERMINAL_SUBHEADERS[tab];

  return (
    <div className="flex min-w-0 items-center gap-1 overflow-x-auto overscroll-x-contain xl:no-scrollbar">
      {items.map((item) => {
        const active = item.id === activeAction;

        return (
          <button
            key={item.id}
            type="button"
            title={item.title}
            aria-pressed={active}
            data-left-subheader-action={item.id}
            onClick={() => onSelect(item.id)}
            className={cn(
              "inline-flex h-10 shrink-0 items-center rounded-sm border px-3 text-2xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:h-6 xl:px-2",
              active
                ? "border-primary/40 bg-primary/15 text-primary"
                : "border-border bg-muted/30 text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
