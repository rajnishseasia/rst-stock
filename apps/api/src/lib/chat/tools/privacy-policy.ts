import type { ToolHandler, ToolResult } from "./types.js";

export interface ToolPrivacyState {
  tenantPrivateDataSeen: boolean;
}

export function createToolPrivacyState(
  tenantPrivateDataSeen = false,
): ToolPrivacyState {
  return { tenantPrivateDataSeen };
}

export function toolCallPolicy(
  handler: ToolHandler,
  state: ToolPrivacyState,
): { allowed: true } | { allowed: false; error: string } {
  if (handler.trustDomain === "external" && state.tenantPrivateDataSeen) {
    return {
      allowed: false,
      error:
        "External research tools are unavailable after private account data has been loaded. Start a new chat to continue external research.",
    };
  }

  return { allowed: true };
}

export function markToolResult(
  state: ToolPrivacyState,
  handler: ToolHandler,
  result: ToolResult,
): void {
  if (handler.trustDomain === "tenant_private" && result.ok) {
    state.tenantPrivateDataSeen = true;
  }
}
