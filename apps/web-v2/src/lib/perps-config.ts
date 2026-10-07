/**
 * perps-config — the single source of truth for whether the perps feature is
 * wired up in this deployment.
 *
 * Perps require Privy (the embedded-wallet layer). `providers.tsx` renders the
 * `PrivyProvider` ONLY when `NEXT_PUBLIC_PRIVY_APP_ID` is set; otherwise it renders
 * a passthrough. Any component that calls `usePerpsWallet` (which internally uses
 * Privy hooks like `usePrivy`/`useWallets`) will THROW if it mounts under that
 * passthrough. So every perps entry point gates on this flag and renders a small
 * "not configured" placeholder (or hides itself) instead of mounting the hook.
 *
 * `NEXT_PUBLIC_*` vars are inlined at build time by Next, so this evaluates to a
 * constant in the client bundle — the dead branch is stripped.
 */
export const PERPS_ENABLED = !!process.env.NEXT_PUBLIC_PRIVY_APP_ID;
