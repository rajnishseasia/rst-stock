"use client";

import {
  createContext,
  useContext,
  type ReactNode,
} from "react";
import type { JwtAuthFlowState } from "@privy-io/react-auth";

/**
 * The JWT synchronization state is produced in the component that calls
 * Privy's hook, but wallet consumers live deeper in the provider tree. Keep
 * the returned state in a small context so those consumers re-render when the
 * sync reaches `done` instead of inferring readiness from transient Privy
 * flags.
 */
const PrivyJwtAuthStateContext = createContext<JwtAuthFlowState>({
  status: "not-enabled",
});

export function PrivyJwtAuthStateProvider({
  state,
  children,
}: {
  state: JwtAuthFlowState;
  children: ReactNode;
}) {
  return (
    <PrivyJwtAuthStateContext.Provider value={state}>
      {children}
    </PrivyJwtAuthStateContext.Provider>
  );
}

export function usePrivyJwtAuthState(): JwtAuthFlowState {
  return useContext(PrivyJwtAuthStateContext);
}
