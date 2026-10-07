import { describe, expect, it } from "bun:test";
import {
  SubmitIntentStore,
  createOrderClientId,
  deriveOrderClientId,
} from "../order-idempotency";

function ids(...values: string[]) {
  let index = 0;
  return () => values[index++]!;
}

describe("trade submit intent IDs", () => {
  it("provides bounded random base IDs and deterministic bounded leg IDs", () => {
    const base = createOrderClientId(() => "12345678-1234-1234-1234-123456789012");
    const first = deriveOrderClientId(base, "br0");
    const second = deriveOrderClientId(base, "br1");

    expect(base).toBe("ord_12345678-1234-1234-1234-123456789012");
    expect(base.length).toBeLessThanOrEqual(48);
    expect(first).toBe(deriveOrderClientId(base, "br0"));
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(48);
  });

  it("retains one ID after a failed or lost-response retry", () => {
    const store = new SubmitIntentStore(ids("first", "second"));

    expect(store.get("AAPL:buy:1")).toBe("first");
    expect(store.get("AAPL:buy:1")).toBe("first");
  });

  it("rotates after a material change or successful completion", () => {
    const store = new SubmitIntentStore(ids("first", "second", "third"));
    const first = store.get("AAPL:buy:1");

    expect(store.get("AAPL:buy:2")).toBe("second");
    store.complete("second");
    expect(store.get("AAPL:buy:2")).toBe("third");
    store.complete(first);
    expect(store.get("AAPL:buy:2")).toBe("third");
  });

  it("reuses sequential bracket leg IDs so an earlier successful leg is not duplicated", async () => {
    const store = new SubmitIntentStore(ids("intent-a", "intent-b"));
    const brokerRows = new Map<string, string>();
    const posts: string[] = [];
    let loseSecondResponse = true;

    async function submit(fingerprint: string) {
      const intent = store.get(fingerprint);
      for (let index = 0; index < 2; index++) {
        const legId = deriveOrderClientId(intent, `br${index}`);
        if (!brokerRows.has(legId)) {
          posts.push(legId);
          brokerRows.set(legId, `broker-${index}`);
          if (index === 1 && loseSecondResponse) {
            loseSecondResponse = false;
            throw new Error("lost response");
          }
        }
      }
      store.complete(intent);
    }

    await expect(submit("same-bracket-form")).rejects.toThrow("lost response");
    await submit("same-bracket-form");

    expect(posts).toEqual([
      deriveOrderClientId("intent-a", "br0"),
      deriveOrderClientId("intent-a", "br1"),
    ]);
    expect(store.get("same-bracket-form")).toBe("intent-b");
  });
});
