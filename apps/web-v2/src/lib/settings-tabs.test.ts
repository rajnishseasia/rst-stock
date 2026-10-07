import { describe, expect, test } from "bun:test";
import {
  buildSettingsTabHref,
  DEFAULT_SETTINGS_TAB,
  isSettingsTab,
  navigateToSettingsTab,
  resolveSettingsTab,
  resolveSettingsTabFromSearchParams,
  SETTINGS_TABS,
} from "./settings-tabs";

class MemoryNavigationHistory {
  private entries: string[];
  private index = 0;

  constructor(initialUrl: string) {
    this.entries = [initialUrl];
  }

  get currentUrl() {
    return this.entries[this.index];
  }

  push(url: string) {
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push(url);
    this.index += 1;
  }

  back() {
    this.index = Math.max(0, this.index - 1);
  }

  forward() {
    this.index = Math.min(this.entries.length - 1, this.index + 1);
  }
}

function selectedTabAt(url: string) {
  return resolveSettingsTabFromSearchParams(
    new URL(url, "https://settings.test").searchParams,
  );
}

function searchAt(url: string) {
  return new URL(url, "https://settings.test").search;
}

describe("resolveSettingsTab", () => {
  test("resolves the Copy Trading tab for the copy-trading deep-link", () => {
    expect(resolveSettingsTab("copy-trading")).toBe("copy-trading");
  });

  test("returns the models tab for the chat deep-link (?t=models)", () => {
    expect(resolveSettingsTab("models")).toBe("models");
  });

  test("passes through every known tab value", () => {
    for (const tab of SETTINGS_TABS) {
      expect(resolveSettingsTab(tab)).toBe(tab);
    }
  });

  test("falls back to the default tab for an unknown value", () => {
    expect(resolveSettingsTab("nope")).toBe(DEFAULT_SETTINGS_TAB);
    expect(DEFAULT_SETTINGS_TAB).toBe("broker");
  });

  test("falls back to the default tab when the param is missing", () => {
    expect(resolveSettingsTab(null)).toBe(DEFAULT_SETTINGS_TAB);
    expect(resolveSettingsTab(undefined)).toBe(DEFAULT_SETTINGS_TAB);
  });

  test("is case-sensitive so it never accidentally matches", () => {
    expect(resolveSettingsTab("Models")).toBe(DEFAULT_SETTINGS_TAB);
  });
});

describe("settings tab URL navigation", () => {
  test("pushes tab choices as navigable URLs and restores them with Back/Forward", () => {
    const history = new MemoryNavigationHistory(
      "/settings?t=perps&source=chat&campaign=spring",
    );

    expect(selectedTabAt(history.currentUrl)).toBe("perps");

    navigateToSettingsTab("copy-trading", searchAt(history.currentUrl), (url) =>
      history.push(url),
    );
    expect(history.currentUrl).toBe(
      "/settings?source=chat&campaign=spring&t=copy-trading",
    );
    expect(selectedTabAt(history.currentUrl)).toBe("copy-trading");

    navigateToSettingsTab("models", searchAt(history.currentUrl), (url) =>
      history.push(url),
    );
    expect(history.currentUrl).toBe(
      "/settings?source=chat&campaign=spring&t=models",
    );
    expect(selectedTabAt(history.currentUrl)).toBe("models");

    navigateToSettingsTab("broker", searchAt(history.currentUrl), (url) =>
      history.push(url),
    );
    expect(history.currentUrl).toBe("/settings?source=chat&campaign=spring");
    expect(selectedTabAt(history.currentUrl)).toBe("broker");

    history.back();
    expect(selectedTabAt(history.currentUrl)).toBe("models");
    history.back();
    expect(selectedTabAt(history.currentUrl)).toBe("copy-trading");
    history.back();
    expect(selectedTabAt(history.currentUrl)).toBe("perps");

    history.forward();
    expect(selectedTabAt(history.currentUrl)).toBe("copy-trading");
    history.forward();
    expect(selectedTabAt(history.currentUrl)).toBe("models");
    history.forward();
    expect(selectedTabAt(history.currentUrl)).toBe("broker");
  });

  test("keeps legacy tab and appearance deep links while building canonical URLs", () => {
    const legacyTab = new URLSearchParams("tab=copy-trading");
    const legacyAppearance = new URLSearchParams("tab=appearance");
    const appearanceAlias = new URLSearchParams("t=appearance");

    expect(resolveSettingsTabFromSearchParams(legacyTab)).toBe("copy-trading");
    expect(resolveSettingsTabFromSearchParams(legacyAppearance)).toBe("profile");
    expect(resolveSettingsTabFromSearchParams(appearanceAlias)).toBe("profile");
    expect(buildSettingsTabHref("tab=appearance&source=legacy", "profile")).toBe(
      "/settings?source=legacy&t=profile",
    );
  });

  test("ignores unknown tab selections without navigating", () => {
    let navigations = 0;

    navigateToSettingsTab("unknown", "source=chat", () => {
      navigations += 1;
    });

    expect(navigations).toBe(0);
  });
});

describe("isSettingsTab", () => {
  test("narrows known values", () => {
    expect(isSettingsTab("models")).toBe(true);
    expect(isSettingsTab("profile")).toBe(true);
  });

  test("keeps old appearance deep-links working", () => {
    expect(resolveSettingsTab("appearance")).toBe("profile");
  });

  test("rejects unknown or empty values", () => {
    expect(isSettingsTab("unknown")).toBe(false);
    expect(isSettingsTab(null)).toBe(false);
    expect(isSettingsTab(undefined)).toBe(false);
    expect(isSettingsTab("")).toBe(false);
  });
});
