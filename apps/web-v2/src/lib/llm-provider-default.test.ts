import { describe, expect, it } from "bun:test";

import {
  isLlmCredentialsQuerySettled,
  resolveLlmProviderDefault,
} from "./llm-provider-default";

const providers = [
  { provider: "openai" },
  { provider: "anthropic" },
  { provider: "minimax" },
  { provider: "deepseek" },
];

describe("resolveLlmProviderDefault", () => {
  it("prefers a provider with an existing saved credential", () => {
    expect(
      resolveLlmProviderDefault(providers, [{ provider: "deepseek" }]),
    ).toBe("deepseek");
  });

  it("uses the catalog default when the user has no saved credentials", () => {
    expect(resolveLlmProviderDefault(providers, [])).toBe("openai");
  });

  it("ignores credentials for providers no longer in the catalog", () => {
    expect(
      resolveLlmProviderDefault(providers, [{ provider: "retired-provider" }]),
    ).toBe("openai");
  });

  it("returns an empty selection while no providers are available", () => {
    expect(resolveLlmProviderDefault([], [{ provider: "deepseek" }])).toBe("");
  });
});

describe("isLlmCredentialsQuerySettled", () => {
  it("waits while credentials are loading", () => {
    expect(
      isLlmCredentialsQuerySettled({ isSuccess: false, isError: false }),
    ).toBe(false);
  });

  it("settles on either success or terminal error", () => {
    expect(
      isLlmCredentialsQuerySettled({ isSuccess: true, isError: false }),
    ).toBe(true);
    expect(
      isLlmCredentialsQuerySettled({ isSuccess: false, isError: true }),
    ).toBe(true);
  });
});
