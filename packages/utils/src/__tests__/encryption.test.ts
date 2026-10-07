/// <reference types="bun" />
import { describe, it, expect, beforeAll, afterAll } from "bun:test";

import { encrypt, decrypt, generateEncryptionKey } from "../utils/encryption.js";

function thrownBy(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  return undefined;
}

function withEncryptionKey<T>(key: string | null, operation: () => T): T {
  const original = process.env.ENCRYPTION_KEY;
  if (key === null) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = key;

  try {
    return operation();
  } finally {
    if (original === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = original;
  }
}

describe("Encryption Utilities", () => {
  const originalEnv = process.env.ENCRYPTION_KEY;

  beforeAll(() => {
    // Generate a valid 64-hex-char key for testing
    process.env.ENCRYPTION_KEY = generateEncryptionKey();
  });

  afterAll(() => {
    // Restore original
    process.env.ENCRYPTION_KEY = originalEnv;
  });

  it("should successfully encrypt and decrypt a valid string", () => {
    const plaintext = "super_secret_api_key_12345";
    const ciphertext = encrypt(plaintext);
    
    expect(ciphertext).not.toBe(plaintext);
    expect(ciphertext.length).toBeGreaterThan(0);

    const decrypted = decrypt(ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it("should fail to encrypt if ENCRYPTION_KEY is unset", () => {
    const temp = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;

    expect(() => encrypt("test")).toThrow("ENCRYPTION_KEY environment variable is not set");

    process.env.ENCRYPTION_KEY = temp;
  });

  it("should fail to encrypt if ENCRYPTION_KEY is invalid length", () => {
    const temp = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "too_short_key";

    expect(() => encrypt("test")).toThrow("ENCRYPTION_KEY must be either 64 hex characters or 32 raw characters");

    process.env.ENCRYPTION_KEY = temp;
  });

  it("should fail to decrypt tampered ciphertext", () => {
    const plaintext = "sensitive_data";
    const ciphertext = encrypt(plaintext);

    const tamperedBytes = Buffer.from(ciphertext, "base64");
    tamperedBytes[tamperedBytes.length - 1] = (tamperedBytes.at(-1) ?? 0) ^ 1;
    const tampered = tamperedBytes.toString("base64");

    const error = thrownBy(() => decrypt(tampered));
    expect(error).toMatchObject({
      name: "DecryptionAuthenticationError",
      message: "Encrypted data could not be authenticated",
    });
  });

  it("classifies ciphertext encrypted with a previous key as an authentication failure", () => {
    const ciphertext = encrypt("sensitive_data");
    const error = withEncryptionKey(generateEncryptionKey(), () =>
      thrownBy(() => decrypt(ciphertext)),
    );

    expect(error).toMatchObject({
      name: "DecryptionAuthenticationError",
      message: "Encrypted data could not be authenticated",
    });
  });

  it("keeps an unset ENCRYPTION_KEY as a configuration error during decryption", () => {
    const ciphertext = encrypt("sensitive_data");
    const error = withEncryptionKey(null, () => thrownBy(() => decrypt(ciphertext)));

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "Error",
      message: "ENCRYPTION_KEY environment variable is not set",
    });
  });

  it("keeps an invalid ENCRYPTION_KEY as a configuration error during decryption", () => {
    const ciphertext = encrypt("sensitive_data");
    const error = withEncryptionKey("too_short_key", () =>
      thrownBy(() => decrypt(ciphertext)),
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "Error",
      message: "ENCRYPTION_KEY must be either 64 hex characters or 32 raw characters",
    });
  });

  it("should throw error on empty input decryption", () => {
    // Empty base64 or invalid format
    expect(() => decrypt("")).toThrow();
  });
});
