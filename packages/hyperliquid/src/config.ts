import { z } from "zod";

/**
 * Hyperliquid network selector. Drives the HL SDK `HttpTransport` `isTestnet`
 * flag and, downstream, the withdrawal-policy `hyperliquidChain` value.
 * Read from the `HYPERLIQUID_NETWORK` env var by the api/worker factories.
 *
 * v1 is MAINNET-ONLY (real funds). The `testnet` member is retained in the type
 * so the network switch keeps compiling, but `networkFromEnv` hard-defaults to
 * mainnet and requires an explicit opt-in flag to ever resolve testnet (see
 * `networkFromEnv`). This honors the plan's "mainnet from the start" stance
 * without deleting the mechanism we'll need later.
 */
export const HyperliquidNetworkSchema = z.enum(["mainnet", "testnet"]).default("mainnet");
export type HyperliquidNetwork = z.infer<typeof HyperliquidNetworkSchema>;

/**
 * Default builder fee applied when a builder address is configured but no
 * explicit `HL_BUILDER_FEE_BPS` is set. Expressed in tenths-of-a-basis-point
 * (the HL wire unit): 100 tenths-of-bp = 10 bps = 0.10%. Builder attachment
 * stays fully OFF whenever `HL_BUILDER_ADDRESS` is unset. This default only
 * takes effect once an address is present.
 */
export const DEFAULT_BUILDER_FEE_TENTHS_BPS = 100;

/**
 * Builder-code config. Attached to EVERY order as `builder: { b, f }`:
 *   b = builder address (`HL_BUILDER_ADDRESS`)
 *   f = fee in tenths of a basis point (`HL_BUILDER_FEE_BPS` interpreted as
 *       tenths-of-a-bp per the HL wire format; e.g. 50 = 5 bps = 0.05%,
 *       100 = 10 bps = 0.10% which is the configured default).
 * HL caps `f` at 1000 (= 100 bps = 1%). The value is clamped defensively.
 */
export const BuilderCodeSchema = z.object({
  /** Builder wallet address that collects the fee. */
  address: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "HL_BUILDER_ADDRESS must be a 0x-prefixed 20-byte address"),
  /** Fee in tenths of a basis point (0..1000). */
  feeTenthsBps: z.number().int().min(0).max(1000),
});
export type BuilderCode = z.infer<typeof BuilderCodeSchema>;

export const HyperliquidConfigSchema = z.object({
  network: HyperliquidNetworkSchema,
  builder: BuilderCodeSchema.optional(),
});
export type HyperliquidConfig = z.infer<typeof HyperliquidConfigSchema>;

/**
 * Agent name registered via `approveAgent`. Shared by the server wrapper and the
 * CLIENT-SIDE onboarding flow so the embedded master approves the agent under the
 * same name the backend expects.
 */
export const DEFAULT_AGENT_NAME = "readysettrade";

/** `true` when the network is testnet — passed to the SDK `HttpTransport`. */
export function isTestnet(network: HyperliquidNetwork): boolean {
  return network === "testnet";
}

/**
 * Format a builder's `feeTenthsBps` as HL's percent string (e.g. `"0.05%"`),
 * the shape `approveBuilderFee`'s `maxFeeRate` expects. `feeTenthsBps` is in
 * tenths of a basis point, so percent = `feeTenthsBps / 1000` (1000 = 1%).
 *
 * Shared by the server (agent-signed wrapper) and the CLIENT-SIDE onboarding
 * flow (embedded master signs `approveBuilderFee`) so both approve the exact
 * same max fee rate.
 */
export function builderMaxFeeRate(builder: BuilderCode): `${string}%` {
  // Divide by 1000 to go tenths-of-bp -> percent. `String(Number)` already
  // trims trailing zeros: 50 -> "0.05%", 1000 -> "1%", 0 -> "0%".
  return `${String(builder.feeTenthsBps / 1000)}%`;
}

/**
 * The `hyperliquidChain` string HL expects in signed actions for a given
 * network. Also the value the withdrawal-DENY Privy policy matches on.
 */
export function hyperliquidChain(network: HyperliquidNetwork): "Mainnet" | "Testnet" {
  return network === "testnet" ? "Testnet" : "Mainnet";
}

/**
 * Resolve the builder code from environment. Returns `undefined` when the
 * builder address is not configured (e.g. local dev without revenue wiring),
 * so builder attachment stays fully OFF unless `HL_BUILDER_ADDRESS` is set;
 * callers decide whether that is acceptable. When the address IS set but no
 * explicit `HL_BUILDER_FEE_BPS` is provided, the fee defaults to
 * `DEFAULT_BUILDER_FEE_TENTHS_BPS` (100 tenths-of-bp = 10 bps = 0.10%).
 * Secrets are referenced by NAME only, never hardcoded.
 */
export function builderCodeFromEnv(env: NodeJS.ProcessEnv = process.env): BuilderCode | undefined {
  const address = env.HL_BUILDER_ADDRESS;
  if (!address) return undefined;
  const feeRaw = env.HL_BUILDER_FEE_BPS;
  const feeTenthsBps =
    feeRaw !== undefined && feeRaw !== "" ? Number(feeRaw) : DEFAULT_BUILDER_FEE_TENTHS_BPS;
  return BuilderCodeSchema.parse({ address, feeTenthsBps });
}

/**
 * Resolve the network from environment. MAINNET-ONLY for v1: the hard default is
 * mainnet, and testnet is only honored when BOTH `HYPERLIQUID_NETWORK=testnet`
 * AND the explicit opt-in `HYPERLIQUID_ALLOW_TESTNET=true` are set. Requesting
 * testnet without the opt-in emits a warning and falls back to mainnet, so a
 * stray env var can never silently point real order flow at testnet — or, worse,
 * point testnet setup at mainnet funds. The network switch itself is preserved
 * for when testnet is deliberately re-enabled.
 */
export function networkFromEnv(env: NodeJS.ProcessEnv = process.env): HyperliquidNetwork {
  const raw = env.HYPERLIQUID_NETWORK;
  const requested = HyperliquidNetworkSchema.parse(raw ?? undefined);
  if (requested === "testnet") {
    const allowTestnet = env.HYPERLIQUID_ALLOW_TESTNET === "true";
    if (!allowTestnet) {
      console.warn(
        "[hyperliquid] HYPERLIQUID_NETWORK=testnet ignored: v1 is mainnet-only. " +
          "Set HYPERLIQUID_ALLOW_TESTNET=true to explicitly opt in to testnet. Falling back to mainnet.",
      );
      return "mainnet";
    }
  }
  return requested;
}
