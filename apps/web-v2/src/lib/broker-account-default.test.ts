import { describe, expect, test } from "bun:test";
import { DEFAULT_BROKER_ACCOUNT_TYPE } from "./broker-account-default";

describe("broker account defaults", () => {
  test("defaults the add broker account form to live trading", () => {
    expect(DEFAULT_BROKER_ACCOUNT_TYPE).toBe("LIVE");
  });
});
