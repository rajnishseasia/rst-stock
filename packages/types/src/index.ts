/**
 * Shared Types Package
 *
 * Export shared TypeScript types used across apps and packages.
 */

// ============================================================================
// API Types
// ============================================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  nextCursor?: string;
  hasMore: boolean;
}

// ============================================================================
// User Types
// ============================================================================

export interface AuthenticatedUser {
  id: string;
  email?: string;
  walletAddress?: string;
}

// ============================================================================
// Common Types
// ============================================================================

export type Nullable<T> = T | null;

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

// ============================================================================
// Copy-mirror Constants
// ============================================================================

export const COPY_PERP_MAX_LEVERAGE_MIN = 1;
export const COPY_PERP_MAX_LEVERAGE_MAX = 100;

export { MIRROR_MIN_ORDER_NOTIONAL_USD, PERP_PROTECTION_BOUNDS } from "./copy-mirror";
