/**
 * The equity ticket's primary-button label (plan A3).
 *
 * `getSubmitBlocker` in `trade-form.tsx` already enumerates every reason a
 * ticket cannot submit, but it only speaks AFTER the tap: the button reads
 * "Review buy", the user taps, and an error banner explains they never had a
 * broker connected. Only the signed-out case was ever surfaced up front.
 *
 * This lifts the same branches into the label so the button states the next
 * action instead of pretending to be a submit control, matching the idiom the
 * mobile chart CTA already uses ("Connect Broker to Trade", `page.tsx`).
 *
 * Label only. Nothing here gates, validates or changes what is submitted:
 * `getSubmitBlocker` remains the sole authority on that, and the button stays a
 * real submit so its blocker message still fires for anything this cannot know.
 *
 * The `known` flags exist because both blockers are ALSO true while their query
 * is still in flight. Labelling an unresolved query "Connect Broker to Trade"
 * would flash a false accusation at every user on a cold mount, so an unknown
 * state falls through to the normal action label.
 */

export interface EquityCtaState {
  /** Platform session present. */
  isSignedIn: boolean;
  /** True once `userSettings.hasApiCredentials` has resolved. */
  credentialsKnown: boolean;
  /** Whether the user has stored Alpaca API keys. */
  hasCredentials: boolean;
  /** Whether an enabled Paper/Live account is currently selected. */
  hasActiveAccount: boolean;
  /** A submit is in flight. */
  isSubmitting: boolean;
  /** The label to use when nothing blocks the ticket ("Review buy", ...). */
  actionLabel: string;
}

export function equityCtaLabel(state: EquityCtaState): string {
  if (!state.isSignedIn) return "Sign in to Trade";
  if (state.credentialsKnown && !state.hasCredentials) {
    return "Connect Broker to Trade";
  }
  if (state.credentialsKnown && state.hasCredentials && !state.hasActiveAccount) {
    return "Select an Account to Trade";
  }
  if (state.isSubmitting) return "Submitting...";
  return state.actionLabel;
}
