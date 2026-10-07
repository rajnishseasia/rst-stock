/**
 * Encryption Utilities
 *
 * AES-256-GCM encryption for sensitive data like API keys.
 * Uses the ENCRYPTION_KEY environment variable from Vercel.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits

/** Internal signal that AES-GCM rejected the stored ciphertext or key. */
export class DecryptionAuthenticationError extends Error {
  constructor() {
    super("Encrypted data could not be authenticated");
    this.name = "DecryptionAuthenticationError";
  }
}

function isGcmAuthenticationFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "ERR_OSSL_EVP_BAD_DECRYPT" ||
    error.message === "Unsupported state or unable to authenticate data"
  );
}

/**
 * Get the encryption key from environment variables.
 * Key should be a 32-byte hex string (64 characters).
 */
function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error("ENCRYPTION_KEY environment variable is not set");
  }

  // If key is hex-encoded (64 chars = 32 bytes)
  if (key.length === 64) {
    return Buffer.from(key, "hex");
  }

  // If key is raw 32 bytes
  if (key.length === 32) {
    return Buffer.from(key, "utf-8");
  }

  throw new Error(
    "ENCRYPTION_KEY must be either 64 hex characters or 32 raw characters",
  );
}

/**
 * Encrypt a string using AES-256-GCM.
 *
 * Returns a base64-encoded string containing: IV + ciphertext + auth tag
 *
 * @param plaintext - The text to encrypt
 * @returns Base64-encoded encrypted string
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key as any, iv as any);

  let ciphertext = (cipher as any).update(plaintext, "utf-8");
  ciphertext = Buffer.concat([ciphertext, (cipher as any).final()]);

  const authTag = (cipher as any).getAuthTag();

  // Combine IV + ciphertext + authTag and encode as base64
  const combined = Buffer.concat([iv, ciphertext, authTag]);
  return combined.toString("base64");
}

/**
 * Decrypt a string that was encrypted with AES-256-GCM.
 *
 * @param encryptedData - Base64-encoded encrypted string (IV + ciphertext + auth tag)
 * @returns Decrypted plaintext string
 */
export function decrypt(encryptedData: string): string {
  const key = getEncryptionKey();

  // Decode from base64
  const combined = Buffer.from(encryptedData, "base64");

  // Extract IV, ciphertext, and auth tag
  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH, combined.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key as any, iv as any);
  (decipher as any).setAuthTag(authTag);

  const plaintext = (decipher as any).update(ciphertext);
  let finalBlock: Buffer;
  try {
    finalBlock = (decipher as any).final();
  } catch (error) {
    if (isGcmAuthenticationFailure(error)) {
      throw new DecryptionAuthenticationError();
    }
    throw error;
  }

  return Buffer.concat([plaintext, finalBlock]).toString("utf-8");
}

/**
 * Generate a random encryption key.
 * Use this to generate ENCRYPTION_KEY for your environment.
 *
 * @returns 64-character hex string
 */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Safely encrypt a value, returning null if the value is empty.
 */
export function encryptIfPresent(value: string | null | undefined): string | null {
  if (!value) return null;
  return encrypt(value);
}

/**
 * Safely decrypt a value, returning null if the value is empty.
 */
export function decryptIfPresent(value: string | null | undefined): string | null {
  if (!value) return null;
  return decrypt(value);
}
