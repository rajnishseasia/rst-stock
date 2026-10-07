"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

const DEBOUNCE_MS = 150;
const DEFAULT_SUGGESTION_LIMIT = 8;

type SymbolSuggestion = {
  symbol: string;
  name: string;
  exchange: string;
  tradable: boolean;
};

interface UseSymbolSearchArgs {
  value: string;
  onPick: (symbol: string) => void;
  limit?: number;
}

interface UseSymbolSearchResult {
  /** Attach to the wrapper element so click-outside can close the popup. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** Pass-through `id` for ARIA `aria-controls` on the input. */
  listboxId: string;
  /** Whether the floating list should render. */
  showList: boolean;
  /** Suggestions to render in the popup (already debounced + ranked). */
  suggestions: SymbolSuggestion[];
  /** Index of the currently-highlighted suggestion (keyboard nav target). */
  highlight: number;
  setHighlight: (index: number) => void;
  /** Computed `aria-activedescendant` value for the input. */
  activeDescendantId: string | undefined;
  /** Wire to the input's `onKeyDown`. Handles ↑/↓/Enter/Esc. */
  handleKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  /** Wire to the input's `onFocus` so the popup opens when the user returns. */
  handleFocus: () => void;
  /**
   * Called by the popup when the user clicks/picks an item. The default
   * implementation also closes the popup; expose it in case the input wrapper
   * needs to fire it programmatically (e.g. from Enter on the raw input).
   */
  commitPick: (symbol: string) => void;
  /** Manually force the popup closed (e.g. after a successful submit). */
  close: () => void;
}

/**
 * Headless search-state hook for the symbol typeahead.
 *
 * Owns: debounce, the tRPC `symbols.search` query, highlight index, open/close,
 * click-outside dismissal, keyboard nav.
 *
 * Doesn't own: the input chrome or the popup styling - those are rendered by
 * the consumer (either `<SymbolSearchInput>` for the watchlist or inline JSX
 * for the mobile search panel, which has its own chrome).
 */
export function useSymbolSearch({
  value,
  onPick,
  limit = DEFAULT_SUGGESTION_LIMIT,
}: UseSymbolSearchArgs): UseSymbolSearchResult {
  const listboxId = useId();
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Debounce so we don't fire on every keystroke. 150ms is a good
  // "feels instant but doesn't thrash" sweet spot for typeaheads.
  useEffect(() => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      setDebouncedQuery("");
      return;
    }
    const handle = setTimeout(() => setDebouncedQuery(trimmed), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [value]);

  const searchQuery = trpc.symbols.search.useQuery(
    { q: debouncedQuery, limit },
    {
      enabled: debouncedQuery.length > 0,
      // Keep results around for a minute so repeat keystrokes feel instant.
      staleTime: 60_000,
    }
  );

  const suggestions = useMemo<SymbolSuggestion[]>(
    () => searchQuery.data ?? [],
    [searchQuery.data]
  );

  // Reset highlight whenever the result set changes - otherwise the
  // previously-highlighted index can point past the end of the new list.
  useEffect(() => {
    setHighlight(0);
  }, [suggestions]);

  // Close the dropdown when the user clicks outside the wrapper. mousedown
  // fires before click, so the dropdown disappears before any outside-click
  // handler runs.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function commitPick(symbol: string) {
    onPick(symbol);
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) {
      // Let the parent form handle Enter on the raw input (existing behavior).
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((highlight + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((highlight - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === "Enter") {
      const picked = suggestions[highlight];
      if (picked) {
        event.preventDefault();
        commitPick(picked.symbol);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  }

  function handleFocus() {
    setOpen(true);
  }

  const showList = open && value.trim().length > 0 && suggestions.length > 0;
  const activeDescendantId = showList ? `${listboxId}-opt-${highlight}` : undefined;

  return {
    containerRef,
    listboxId,
    showList,
    suggestions,
    highlight,
    setHighlight,
    activeDescendantId,
    handleKeyDown,
    handleFocus,
    commitPick,
    close: () => setOpen(false),
  };
}

interface SymbolSuggestionsListProps {
  listboxId: string;
  suggestions: SymbolSuggestion[];
  highlight: number;
  setHighlight: (index: number) => void;
  onPick: (symbol: string) => void;
  /**
   * Override the popup's positioning classes if the default
   * `absolute left-0 right-0 top-full` doesn't fit the parent layout.
   */
  className?: string;
}

/**
 * Floating suggestion popup. Renders nothing if `suggestions` is empty -
 * the consumer controls visibility via `showList` from `useSymbolSearch`.
 */
export function SymbolSuggestionsList({
  listboxId,
  suggestions,
  highlight,
  setHighlight,
  onPick,
  className,
}: SymbolSuggestionsListProps) {
  return (
    <ul
      id={listboxId}
      role="listbox"
      className={cn(
        "absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-md border bg-popover py-1 text-sm shadow-floating",
        className
      )}
    >
      {suggestions.map((entry, index) => {
        const isActive = index === highlight;
        return (
          <li
            key={entry.symbol}
            id={`${listboxId}-opt-${index}`}
            role="option"
            aria-selected={isActive}
            // mousedown (not click) fires before the input's blur, so the
            // pick lands before our outside-click closes the popup.
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(entry.symbol);
            }}
            onMouseEnter={() => setHighlight(index)}
            className={cn(
              "flex cursor-pointer items-center justify-between gap-3 px-2 py-1.5",
              isActive && "bg-accent text-accent-foreground"
            )}
          >
            <div className="flex min-w-0 flex-col">
              <span className="font-mono text-xs font-semibold">{entry.symbol}</span>
              {entry.name && (
                <span className="truncate text-xs text-muted-foreground">{entry.name}</span>
              )}
            </div>
            {entry.exchange && (
              <span className="shrink-0 text-3xs uppercase tracking-wide text-muted-foreground">
                {entry.exchange}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

interface SymbolSearchInputProps {
  value: string;
  onChange: (value: string) => void;
  /**
   * Fires when the user picks a suggestion (click or Enter on a highlighted
   * row). Receives the picked symbol so the parent can submit immediately
   * without waiting for a form roundtrip.
   */
  onPick: (symbol: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Symbol-aware text input with a floating suggestion list. Used by the
 * Watchlist "Add symbol" form. For inputs with custom chrome (e.g. the
 * mobile search bar), compose `useSymbolSearch` + `SymbolSuggestionsList`
 * yourself.
 */
export function SymbolSearchInput({
  value,
  onChange,
  onPick,
  placeholder = "Add symbol...",
  ariaLabel = "Add symbol",
  disabled = false,
  className,
}: SymbolSearchInputProps) {
  const search = useSymbolSearch({ value, onPick });

  return (
    <div ref={search.containerRef} className="relative flex-1">
      <Input
        value={value}
        onChange={(event) => {
          onChange(event.target.value.toUpperCase());
          search.handleFocus();
        }}
        onFocus={search.handleFocus}
        onKeyDown={search.handleKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
        disabled={disabled}
        className={cn("h-8", className)}
        role="combobox"
        aria-expanded={search.showList}
        aria-controls={search.showList ? search.listboxId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={search.activeDescendantId}
      />
      {search.showList && (
        <SymbolSuggestionsList
          listboxId={search.listboxId}
          suggestions={search.suggestions}
          highlight={search.highlight}
          setHighlight={search.setHighlight}
          onPick={search.commitPick}
        />
      )}
    </div>
  );
}
