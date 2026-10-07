import { describe, expect, test } from "bun:test";
import { buildSaveBrokerCredentialsInput } from "./broker-credentials-form";

describe("broker credentials form", () => {
  test("omits accountId from the frontend save payload", () => {
    const input = buildSaveBrokerCredentialsInput({
      provider: "alpaca",
      accountType: "LIVE",
      accessToken: "secret-key",
      username: "api-key-id",
    });

    expect(input).toEqual({
      provider: "alpaca",
      accountType: "LIVE",
      accessToken: "secret-key",
      username: "api-key-id",
    });
    expect("accountId" in input).toBe(false);
  });
});
