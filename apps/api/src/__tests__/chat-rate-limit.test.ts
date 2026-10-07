import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";

const getRedisClient = vi.fn();

vi.mock("@trade-bot/redis", () => ({ getRedisClient }));

/**
 * A benign rate-limit reading: one request used, far below any limit.
 *
 * This file installs PERSISTENT implementations (`mockResolvedValue`, not
 * `...Once`) on a module mock, and `bun test` loads every test file into ONE
 * process, so `vi.mock` is process-wide rather than file-scoped. Whatever
 * implementation this file leaves behind is therefore inherited by every test
 * file that loads after it.
 *
 * That was a live bug, not a hypothetical. The last case here exercises an
 * overflow count of `2 ** 53`, which is wildly over `RATE_LIMIT_MAX_REQUESTS`
 * (60) in the tRPC middleware. Any later file calling a `protectedProcedure`
 * without its own Redis mock, for instance `perp-trigger-router.test.ts` or
 * `delete-credential-disarm.test.ts`, then failed with TOO_MANY_REQUESTS while
 * passing perfectly well in isolation. The result was an order-dependent flake
 * that turned CI red on work that had nothing to do with rate limiting.
 *
 * Restoring this after every test keeps the leak from crossing the file
 * boundary. It does not weaken anything here: each test sets the value it needs
 * before it calls, so it never reads this default.
 */
const BENIGN_RATE_LIMIT_CLIENT = { incrWithTtl: async () => 1 };

const { checkChatRateLimit } = await import("../lib/chat/rate-limit.js");

const logger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

describe("chat stream rate-limit admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // See BENIGN_RATE_LIMIT_CLIENT: this mock is process-wide, so it must not be
  // left holding an over-limit count for whichever file bun loads next.
  afterEach(() => {
    getRedisClient.mockReset();
    getRedisClient.mockResolvedValue(BENIGN_RATE_LIMIT_CLIENT);
  });

  it("allows a valid count within the limit", async () => {
    getRedisClient.mockResolvedValue({
      incrWithTtl: vi.fn().mockResolvedValue(1),
    });

    await expect(checkChatRateLimit("user-1", logger as any)).resolves.toEqual({
      status: "allowed",
      count: 1,
    });
  });

  it("allows the exact boundary count (count === limit)", async () => {
    getRedisClient.mockResolvedValue({
      incrWithTtl: vi.fn().mockResolvedValue(10),
    });

    await expect(checkChatRateLimit("user-1", logger as any)).resolves.toEqual({
      status: "allowed",
      count: 10,
    });
  });

  it("rejects the first count past the boundary (count === limit + 1)", async () => {
    getRedisClient.mockResolvedValue({
      incrWithTtl: vi.fn().mockResolvedValue(11),
    });

    await expect(checkChatRateLimit("user-1", logger as any)).resolves.toEqual({
      status: "limited",
      count: 11,
    });
  });

  it("fails closed when Redis throws", async () => {
    getRedisClient.mockRejectedValue(new Error("write ECONNRESET"));

    await expect(checkChatRateLimit("user-1", logger as any)).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("fails closed when the Redis helper converts an error to zero", async () => {
    getRedisClient.mockResolvedValue({
      incrWithTtl: vi.fn().mockResolvedValue(0),
    });

    await expect(checkChatRateLimit("user-1", logger as any)).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("fails closed on a negative count", async () => {
    getRedisClient.mockResolvedValue({
      incrWithTtl: vi.fn().mockResolvedValue(-3),
    });

    await expect(checkChatRateLimit("user-1", logger as any)).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("fails closed on a NaN count", async () => {
    getRedisClient.mockResolvedValue({
      incrWithTtl: vi.fn().mockResolvedValue(Number.NaN),
    });

    await expect(checkChatRateLimit("user-1", logger as any)).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("fails closed on a non-safe-integer count", async () => {
    getRedisClient.mockResolvedValue({
      incrWithTtl: vi.fn().mockResolvedValue(2 ** 53),
    });

    await expect(checkChatRateLimit("user-1", logger as any)).resolves.toEqual({
      status: "unavailable",
    });
  });
});
