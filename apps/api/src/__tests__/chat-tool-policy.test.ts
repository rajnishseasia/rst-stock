import { describe, expect, it } from "bun:test";
import { ALPACA_TOOLS } from "../lib/chat/tools/alpaca-tools.js";
import {
  createToolPrivacyState,
  markToolResult,
  toolCallPolicy,
} from "../lib/chat/tools/privacy-policy.js";
import type { ToolHandler } from "../lib/chat/tools/types.js";

function handler(trustDomain: ToolHandler["trustDomain"]): ToolHandler {
  return {
    trustDomain,
    definition: {
      type: "function",
      function: {
        name: `test_${trustDomain}`,
        description: "test",
        parameters: { type: "object" },
      },
    },
    async execute() {
      return { ok: true };
    },
  };
}

describe("chat tool privacy policy", () => {
  it("allows external research before private account data is loaded", () => {
    expect(toolCallPolicy(handler("external"), createToolPrivacyState())).toEqual({
      allowed: true,
    });
  });

  it("blocks external tools after a successful tenant-private result", () => {
    const state = createToolPrivacyState();
    markToolResult(state, handler("tenant_private"), { ok: true, data: { cash: 100 } });

    expect(toolCallPolicy(handler("external"), state)).toMatchObject({
      allowed: false,
    });
  });

  it("does not raise the boundary from a FAILED tenant-private result", () => {
    const state = createToolPrivacyState();
    markToolResult(state, handler("tenant_private"), {
      ok: false,
      error: "alpaca returned 500",
    });

    expect(state.tenantPrivateDataSeen).toBe(false);
    expect(toolCallPolicy(handler("external"), state)).toEqual({ allowed: true });
  });

  it("blocks external tools when private broker context seeded the conversation", () => {
    const state = createToolPrivacyState(true);

    expect(toolCallPolicy(handler("external"), state)).toMatchObject({
      allowed: false,
    });
  });

  it("does not treat public market data as tenant-private", () => {
    const state = createToolPrivacyState();
    markToolResult(state, handler("public_market"), { ok: true, data: { price: 100 } });

    expect(toolCallPolicy(handler("external"), state)).toEqual({ allowed: true });
  });

  it("classifies Alpaca account tools separately from public market tools", () => {
    const domains = Object.fromEntries(
      ALPACA_TOOLS.map((tool) => [tool.definition.function.name, tool.trustDomain]),
    );

    expect(domains.alpaca_get_account).toBe("tenant_private");
    expect(domains.alpaca_list_positions).toBe("tenant_private");
    expect(domains.alpaca_list_orders).toBe("tenant_private");
    expect(domains.alpaca_get_watchlist).toBe("tenant_private");
    expect(domains.alpaca_get_bars).toBe("public_market");
    expect(domains.alpaca_get_quote).toBe("public_market");
  });
});
