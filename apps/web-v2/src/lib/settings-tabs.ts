import type { Route } from "next";

/**
 * Settings-page tab identifiers and the query-param resolver used to deep-link
 * into a specific tab.
 *
 * The settings page renders a Radix `Tabs` whose values live here so both the
 * page and any deep-link source (e.g. the AI chat panel's "Open full settings…"
 * link) agree on the identifiers. `resolveSettingsTab` turns an untrusted
 * `?t=` query value into a known tab, falling back to the default when the
 * value is missing or unrecognized.
 */

export const SETTINGS_TABS = [
  "broker",
  "perps",
  "copy-trading",
  "models",
  "profile",
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const DEFAULT_SETTINGS_TAB: SettingsTab = "broker";

export function isSettingsTab(value: string | null | undefined): value is SettingsTab {
  return value != null && (SETTINGS_TABS as readonly string[]).includes(value);
}

/**
 * Resolve a `?t=` query value to a valid settings tab. Unknown or missing
 * values fall back to the default (broker) tab.
 */
export function resolveSettingsTab(value: string | null | undefined): SettingsTab {
  if (value === "appearance") return "profile";
  return isSettingsTab(value) ? value : DEFAULT_SETTINGS_TAB;
}

/**
 * Resolve the current tab from the settings URL, including the legacy `tab`
 * query parameter used by older links.
 */
export function resolveSettingsTabFromSearchParams(
  searchParams: Pick<URLSearchParams, "get">,
): SettingsTab {
  return resolveSettingsTab(searchParams.get("t") ?? searchParams.get("tab"));
}

/** Build the canonical Settings URL for a tab while retaining other query parameters. */
export function buildSettingsTabHref(search: string, tab: SettingsTab): Route {
  const params = new URLSearchParams(search);
  params.delete("t");
  params.delete("tab");
  if (tab !== DEFAULT_SETTINGS_TAB) params.set("t", tab);
  const query = params.toString();
  return query ? `/settings?${query}` : "/settings";
}

/**
 * Navigate to a selected Settings tab. The caller supplies a push operation so
 * each user choice becomes a browser-history entry and can be revisited.
 */
export function navigateToSettingsTab(
  value: string,
  search: string,
  push: (href: Route) => void,
): void {
  if (!isSettingsTab(value)) return;
  push(buildSettingsTabHref(search, value));
}
