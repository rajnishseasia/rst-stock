/**
 * perps-private-key: pure validation/normalization for the "import an existing
 * wallet by private key" flow (usePerpsWallet.importWallet). Extracted as a pure
 * function so the hex-key validation is unit-testable without mounting Privy
 * hooks (per the audit note: extract pure logic into a lib/ module rather than
 * regexing a component's source).
 *
 * A valid EVM private key is exactly 32 bytes = 64 hex chars, optionally
 * 0x-prefixed. We trim surrounding whitespace (users paste keys with stray
 * spaces / newlines) and normalize to the 0x-prefixed form Privy's
 * `importWallet` expects. The key is NEVER logged.
 */

/**
 * 32-byte hex key, optional `0x` prefix. Anchored so a 63- or 65-char string
 * (or one with a stray non-hex char) can never slip through. The whole `0x`
 * prefix is optional as a unit. A lone leading `0` with 64 more hex chars
 * (65 chars total) is NOT a valid key and is rejected.
 */
const PRIVATE_KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;

/** True when `input` (after trimming) is a valid 32-byte hex private key. */
export function isValidPrivateKey(input: string): boolean {
  return PRIVATE_KEY_RE.test(input.trim());
}

/**
 * Validate + normalize a pasted private key to the `0x`-prefixed form Privy
 * expects. Throws a user-facing error on anything that is not a 32-byte hex key.
 * Never logs or echoes the key value.
 */
export function normalizeImportedPrivateKey(input: string): `0x${string}` {
  const key = input.trim();
  if (!PRIVATE_KEY_RE.test(key)) {
    throw new Error("Enter a valid 32-byte hex private key.");
  }
  return (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
}
