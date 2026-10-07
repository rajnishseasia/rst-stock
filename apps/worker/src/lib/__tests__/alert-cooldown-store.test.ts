import { describe, expect, test } from "bun:test";
import { ERROR_BURST_COOLDOWN_KEY } from "@trade-bot/logger";
import type { RedisClient } from "@trade-bot/redis";
import { RedisAlertCooldownStore } from "../alert-cooldown-store";

interface FakeRedis {
  client: RedisClient;
  calls: Array<{ op: string; key: string; expireMs?: number }>;
  deleted: string[];
}

function makeRedis(result: boolean | null): FakeRedis {
  const calls: FakeRedis["calls"] = [];
  const deleted: string[] = [];
  const client = {
    setIfNotExists: async (key: string, _value: string, expireMs: number) => {
      calls.push({ op: "setnx", key, expireMs });
      return result;
    },
    del: async (key: string) => {
      deleted.push(key);
      return true;
    },
  } as unknown as RedisClient;
  return { client, calls, deleted };
}

describe("RedisAlertCooldownStore", () => {
  test("claims the lease with the cooldown as its TTL", async () => {
    const redis = makeRedis(true);
    const store = new RedisAlertCooldownStore(redis.client);

    expect(await store.claim(86_400_000)).toBe(true);
    expect(redis.calls).toEqual([
      { op: "setnx", key: ERROR_BURST_COOLDOWN_KEY, expireMs: 86_400_000 },
    ]);
  });

  // The whole point: the key outlives the process that set it.
  test("reports suppression when the key is already held", async () => {
    const store = new RedisAlertCooldownStore(makeRedis(false).client);
    expect(await store.claim(86_400_000)).toBe(false);
  });

  test("release deletes the key", async () => {
    const redis = makeRedis(true);
    await new RedisAlertCooldownStore(redis.client).release();
    expect(redis.deleted).toEqual([ERROR_BURST_COOLDOWN_KEY]);
  });

  // An unreachable Redis must not silence alerting, but must not uncork it
  // either: the local window keeps the degraded mode at the old behaviour.
  describe("when Redis cannot answer", () => {
    test("the first claim still succeeds", async () => {
      const store = new RedisAlertCooldownStore(makeRedis(null).client);
      expect(await store.claim(86_400_000)).toBe(true);
    });

    test("a second claim inside the window is suppressed locally", async () => {
      const store = new RedisAlertCooldownStore(makeRedis(null).client);
      await store.claim(86_400_000);
      expect(await store.claim(86_400_000)).toBe(false);
    });
  });
});
