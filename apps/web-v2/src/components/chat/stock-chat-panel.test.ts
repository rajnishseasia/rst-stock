import { describe, expect, test } from "bun:test";
import { applyGeneratedDraft } from "./stock-chat-draft";
import {
  chatMessageBodyClassName,
  shouldShowChatSuggestions,
} from "./stock-chat-panel";

describe("StockChatPanel draft prompts", () => {
  test("fills an empty composer with the generated prompt", () => {
    expect(applyGeneratedDraft("", null, "Analyze $SPY")).toEqual({
      value: "Analyze $SPY",
      accepted: true,
    });
  });

  test("replaces the prior generated prompt when context changes", () => {
    expect(
      applyGeneratedDraft("Analyze $SPY", "Analyze $SPY", "Analyze $QQQ"),
    ).toEqual({ value: "Analyze $QQQ", accepted: true });
  });

  test("does not clobber user-written input", () => {
    expect(
      applyGeneratedDraft("Compare risk first", "Analyze $SPY", "Analyze $QQQ"),
    ).toEqual({ value: "Compare risk first", accepted: false });
  });
});

describe("StockChatPanel starter suggestions", () => {
  test("shows suggestions for a new conversation and an empty stream placeholder", () => {
    expect(shouldShowChatSuggestions([])).toBe(true);
    expect(
      shouldShowChatSuggestions([{ role: "assistant", content: "" }]),
    ).toBe(true);
  });

  test("hides suggestions once either participant has added real content", () => {
    expect(
      shouldShowChatSuggestions([{ role: "user", content: "Analyze $SPY" }]),
    ).toBe(false);
    expect(
      shouldShowChatSuggestions([
        { role: "assistant", content: "SPY is holding above support." },
      ]),
    ).toBe(false);
  });

  test("treats assistant tool activity as conversation activity", () => {
    expect(
      shouldShowChatSuggestions([
        { role: "assistant", content: "   ", toolCalls: [{ id: "quote-1" }] },
      ]),
    ).toBe(false);
  });
});

describe("StockChatPanel message bubbles", () => {
  // DESIGN.md: gold is a seasoning, not a sauce. Every user turn was a solid
  // `bg-primary` bubble, so a real conversation was a column of gold slabs.
  test("marks the user turn with a gold rail on a neutral bubble, not a gold fill", () => {
    const user = chatMessageBodyClassName(false);

    expect(user).toContain("bg-muted");
    expect(user).toContain("border-l-2");
    expect(user).toContain("border-primary");
    expect(user).toContain("text-foreground");
    expect(user).not.toContain("text-primary-foreground");
    expect(user.split(" ")).not.toContain("bg-primary");
  });

  test("leaves the assistant turn unbubbled", () => {
    const assistant = chatMessageBodyClassName(true);

    expect(assistant).toContain("text-foreground");
    expect(assistant).not.toContain("bg-");
    expect(assistant).not.toContain("border-");
  });

  test("states the same rule on mobile and desktop, with no breakpoint variant", () => {
    // The panel is mounted by both shells, so a bare class list is the whole
    // contract: a stray `xl:` here would mean the two shells disagree.
    for (const isAssistant of [true, false]) {
      expect(chatMessageBodyClassName(isAssistant)).not.toContain("xl:");
    }
  });
});
