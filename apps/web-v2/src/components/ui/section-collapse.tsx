"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

const STORAGE_PREFIX = "section-collapsed:";

/**
 * Persist a card/section's collapsed state to localStorage so it survives
 * reloads. We start from `defaultCollapsed` on both server and first client
 * render (avoids a hydration mismatch), then reconcile with the stored value
 * in an effect. The brief flash for a stored-collapsed section is acceptable
 * and far cheaper than a hydration error.
 */
export function useCollapsible(storageKey: string, defaultCollapsed = false) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_PREFIX + storageKey);
      if (stored !== null) setCollapsed(stored === "1");
    } catch {
      // localStorage unavailable (private mode, SSR) - keep the default.
    }
    setHydrated(true);
  }, [storageKey]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_PREFIX + storageKey, collapsed ? "1" : "0");
    } catch {
      // Ignore write failures; collapse still works for the session.
    }
  }, [collapsed, hydrated, storageKey]);

  const toggle = useCallback(() => setCollapsed((c) => !c), []);

  return { collapsed, toggle, setCollapsed };
}

export function CollapseButton({
  collapsed,
  onToggle,
  label,
  className,
}: {
  collapsed: boolean;
  onToggle: () => void;
  /** Section name, used for the accessible label (e.g. "X Signals"). */
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-expanded={!collapsed}
      aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
      title={collapsed ? "Expand section" : "Collapse section"}
      className={cn(
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      <ChevronDown
        className={cn("h-4 w-4 transition-transform", collapsed && "-rotate-90")}
      />
    </button>
  );
}
