import { describe, expect, it, vi, beforeEach } from "bun:test";

const getRedisClient = vi.fn();

vi.mock("@trade-bot/redis", () => ({
  getRedisClient,
}));

const { router, protectedProcedure } = await import("../trpc.js");

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function createCaller() {
  const testRouter = router({
    ping: protectedProcedure.query(() => "pong"),
  });

  const logger = createLogger();
  const caller = testRouter.createCaller({
    db: {} as any,
    session: { userId: "user-1" },
    userId: "user-1",
    logger: logger as any,
  });

  return { caller, logger };
}

describe("protectedProcedure rate limiter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows the request when Redis rate-limit storage fails", async () => {
    getRedisClient.mockRejectedValueOnce(new Error("write ECONNRESET"));
    const { caller, logger } = createCaller();

    await expect(caller.ping()).resolves.toBe("pong");
    expect(logger.warn).toHaveBeenCalledWith(
      "api",
      "[RateLimit] Redis unavailable; allowing request",
      { error: "write ECONNRESET", userId: "user-1" },
    );
  });

  it("rejects the request when Redis reports the user is over limit", async () => {
    getRedisClient.mockResolvedValueOnce({
      incrWithTtl: vi.fn().mockResolvedValueOnce(61),
    });
    const { caller } = createCaller();

    await expect(caller.ping()).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
  });
});
