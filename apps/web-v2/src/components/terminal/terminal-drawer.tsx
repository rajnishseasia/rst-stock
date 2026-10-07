"use client";

import type { ReactNode } from "react";
import Image from "next/image";
import {
  ChevronsLeft,
  ChevronsRight,
  PanelBottom,
  PanelRight,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  TerminalDrawerState,
  TerminalSide,
  TerminalSplit,
} from "./terminal-layout-state";

export interface TerminalDrawerProps<T extends string> {
  side: TerminalSide;
  title: string;
  tabs: Array<{ value: T; label: string; iconSrc?: string; badge?: string }>;
  state: TerminalDrawerState<T>;
  collapsedLabel: string;
  renderPane: (tab: T, paneId: string) => ReactNode;
  renderSubHeader?: (tab: T, paneId: string) => ReactNode;
  leadingTabAction?: ReactNode;
  resizeHandle?: ReactNode;
  onCollapse: (collapsed: boolean) => void;
  onSplit: (direction: TerminalSplit) => void;
  onClosePane: (paneId: string) => void;
  onTabChange: (paneId: string, tab: T) => void;
}

function ChevronIcon({
  side,
  collapsed,
}: {
  side: TerminalSide;
  collapsed: boolean;
}) {
  const Icon =
    side === "left"
      ? collapsed
        ? ChevronsRight
        : ChevronsLeft
      : collapsed
        ? ChevronsLeft
        : ChevronsRight;

  return <Icon className="h-3.5 w-3.5" />;
}

export function TerminalDrawer<T extends string>({
  side,
  title,
  tabs,
  state,
  collapsedLabel,
  renderPane,
  renderSubHeader,
  leadingTabAction,
  resizeHandle,
  onCollapse,
  onSplit,
  onClosePane,
  onTabChange,
}: TerminalDrawerProps<T>) {
  const isSplit = state.panes.length > 1;
  const canSplit = state.panes.length < 2;
  const collapseLabel = `${state.collapsed ? "Expand" : "Collapse"} ${title} drawer`;

  if (state.collapsed) {
    return (
      <aside
        aria-label={title}
        title={title}
        data-terminal-side={side}
        data-terminal-collapsed="true"
        data-terminal-drawer-state="collapsed"
        data-terminal-drawer-transition="rail"
        className={cn(
          "terminal-drawer terminal-drawer-rail relative flex h-12 min-h-0 w-full shrink-0 flex-row items-center gap-2 overflow-hidden border-y border-border/50 bg-background/95 px-2 transition-colors duration-200 xl:h-full xl:w-12 xl:flex-col xl:gap-0 xl:border-y-0 xl:px-0 xl:py-2 motion-reduce:transition-none",
          side === "left" ? "xl:border-l" : "xl:border-r",
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-terminal-control="expand"
          aria-label={collapseLabel}
          title={collapseLabel}
          aria-expanded={false}
          onClick={() => onCollapse(false)}
          className="rounded-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground active:bg-muted focus-visible:ring-inset"
        >
          <ChevronIcon side={side} collapsed />
        </Button>
        <div
          data-terminal-rail-label={collapsedLabel}
          className="flex min-h-0 min-w-0 flex-1 items-center gap-2 overflow-hidden xl:flex-col xl:gap-2 xl:pt-2"
        >
          <span
            aria-hidden="true"
            data-terminal-rail-accent="true"
            className="h-px w-4 shrink-0 bg-primary/60 xl:h-5 xl:w-px"
          />
          <div
            className={cn(
              "min-h-0 min-w-0 flex-1 overflow-hidden text-3xs font-medium uppercase tracking-normal text-muted-foreground xl:[writing-mode:vertical-rl]",
              side === "left" && "xl:rotate-180",
            )}
          >
            <span className="block truncate">{collapsedLabel}</span>
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside
      aria-label={title}
      title={title}
      data-terminal-side={side}
      data-terminal-collapsed="false"
      data-terminal-drawer-state="expanded"
      data-terminal-drawer-transition="panel"
      className={cn(
        "terminal-drawer relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-y border-border/50 bg-background transition-colors duration-200 xl:border-y-0 motion-reduce:transition-none",
        side === "left" ? "xl:border-l" : "xl:border-r",
      )}
    >
      <header
        data-terminal-drawer-header={title}
        className="terminal-drawer-header flex h-10 shrink-0 items-center gap-2 border-b border-border/50 bg-muted/10 px-2.5"
      >
        <span
          aria-hidden="true"
          data-terminal-title-accent="true"
          className="h-3 w-px shrink-0 bg-primary/70"
        />
        <h2 className="min-w-0 flex-1 truncate text-2xs font-semibold uppercase tracking-normal text-foreground/80">
          {title}
        </h2>

        <div
          role="group"
          aria-label={`${title} drawer controls`}
          data-terminal-header-controls="true"
          className="flex shrink-0 items-center gap-0.5 rounded-sm bg-muted/30 p-0.5"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-terminal-control="split-bottom"
            aria-label={`Split ${title} bottom`}
            title="Split bottom"
            disabled={!canSplit}
            onClick={() => onSplit("bottom")}
            className="hidden rounded-sm text-muted-foreground hover:bg-background/80 hover:text-foreground active:bg-background focus-visible:ring-inset xl:inline-flex"
          >
            <PanelBottom className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-terminal-control="split-right"
            aria-label={`Split ${title} right`}
            title="Split right"
            disabled={!canSplit}
            onClick={() => onSplit("right")}
            className="hidden rounded-sm text-muted-foreground hover:bg-background/80 hover:text-foreground active:bg-background focus-visible:ring-inset xl:inline-flex"
          >
            <PanelRight className="h-3.5 w-3.5" />
          </Button>
          <span
            aria-hidden="true"
            className="mx-0.5 hidden h-3.5 w-px bg-border/70 xl:block"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-terminal-control="collapse"
            aria-label={collapseLabel}
            title={collapseLabel}
            aria-expanded={true}
            onClick={() => onCollapse(true)}
            className="rounded-sm text-muted-foreground hover:bg-background/80 hover:text-foreground active:bg-background focus-visible:ring-inset"
          >
            <ChevronIcon side={side} collapsed={false} />
          </Button>
        </div>
      </header>

      <div
        data-terminal-split={state.split ?? "none"}
        data-terminal-pane-count={state.panes.length}
        data-terminal-pane-transition="layout"
        className={cn(
          "grid min-h-0 min-w-0 flex-1 overflow-hidden bg-border/50 transition-[grid-template-columns,grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
          !isSplit && "grid-cols-1",
          isSplit && state.split === "bottom" && "grid-rows-2 gap-y-px",
          isSplit &&
            state.split === "right" &&
            "grid-cols-1 gap-y-px xl:grid-cols-2 xl:gap-x-px xl:gap-y-0",
        )}
      >
        {state.panes.map((pane, index) => (
          <section
            key={pane.id}
            aria-label={`${title} pane ${index + 1}`}
            data-terminal-pane={pane.id}
            data-terminal-pane-index={index}
            data-terminal-pane-position={
              isSplit ? (index === 0 ? "primary" : "secondary") : "only"
            }
            data-terminal-pane-transition="fade"
            className="terminal-drawer-pane flex min-h-0 min-w-0 flex-col overflow-hidden bg-background"
          >
            <div
              data-terminal-pane-tabs={pane.id}
              className="terminal-drawer-tabs flex h-10 shrink-0 items-center gap-1 border-b border-border/40 bg-background px-1.5 xl:h-9"
            >
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain xl:no-scrollbar">
                {leadingTabAction}
                {tabs.map((tab) => {
                  const active = tab.value === pane.tab;

                  return (
                    <button
                      key={tab.value}
                      type="button"
                      aria-pressed={active}
                      data-terminal-tab={tab.value}
                      data-terminal-tab-state={active ? "active" : "inactive"}
                      onClick={() => onTabChange(pane.id, tab.value)}
                      className={cn(
                        "relative inline-flex h-full shrink-0 items-center justify-center rounded-none px-3 text-2xs font-medium tracking-normal transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:text-foreground xl:px-2.5 motion-reduce:transition-none",
                        active
                          ? "text-foreground"
                          : "text-muted-foreground hover:bg-muted/30 hover:text-foreground",
                      )}
                    >
                      <span className="flex items-center gap-1.5 leading-none">
                        {tab.iconSrc && (
                          <Image
                            src={tab.iconSrc}
                            alt=""
                            aria-hidden="true"
                            width={16}
                            height={16}
                            className="h-4 w-4 shrink-0 rounded-full object-cover ring-1 ring-primary/30"
                          />
                        )}
                        <span>{tab.label}</span>
                        {tab.badge && (
                          <span
                            aria-label={tab.badge}
                            className="hidden shrink-0 rounded px-1 py-px text-3xs font-semibold uppercase tracking-wide bg-primary/15 text-primary xl:inline"
                          >
                            {tab.badge}
                          </span>
                        )}
                      </span>
                      <span
                        aria-hidden="true"
                        data-terminal-tab-indicator={
                          active ? "visible" : "hidden"
                        }
                        className={cn(
                          "pointer-events-none absolute inset-x-2 bottom-0 h-0.5 origin-center bg-primary transition-transform duration-200 ease-out motion-reduce:transition-none",
                          active ? "scale-x-100" : "scale-x-0",
                        )}
                      />
                    </button>
                  );
                })}
              </div>

              {isSplit && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  data-terminal-control="close-pane"
                  aria-label={`Close ${title} pane ${index + 1}`}
                  title="Close pane"
                  onClick={() => onClosePane(pane.id)}
                  className="mr-0.5 rounded-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground active:bg-muted focus-visible:ring-inset"
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>

            {renderSubHeader && (
              <div
                data-terminal-pane-subheader={pane.id}
                className="shrink-0 border-b border-border/30 bg-muted/10 px-2 py-1.5"
              >
                {renderSubHeader(pane.tab, pane.id)}
              </div>
            )}

            <div
              data-terminal-pane-content={pane.id}
              data-terminal-pane-tab={pane.tab}
              data-terminal-pane-transition="content"
              className="min-h-0 flex-1 overflow-hidden transition-opacity duration-150 ease-out motion-reduce:transition-none"
            >
              {renderPane(pane.tab, pane.id)}
            </div>
          </section>
        ))}
      </div>

      {resizeHandle}
    </aside>
  );
}
