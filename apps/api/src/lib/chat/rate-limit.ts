import { getRedisClient } from "@trade-bot/redis";

const CHAT_RATE_LIMIT_WINDOW_SECONDS = 30;
const CHAT_RATE_LIMIT_MAX_REQUESTS = 10;

type ChatRateLimitResult =
  | { status: "allowed"; count: number }
  | { status: "limited"; count: number }
  | { status: "unavailable" };

export async function checkChatRateLimit(
  userId: string,
  logger: NonNullable<Parameters<typeof getRedisClient>[0]>,
): Promise<ChatRateLimitResult> {
  try {
    const redis = await getRedisClient(logger);
    const count = await redis.incrWithTtl(
      `ratelimit:chat:${userId}`,
      CHAT_RATE_LIMIT_WINDOW_SECONDS,
    );

    if (!Number.isSafeInteger(count) || count < 1) {
      logger.warn("api", "[Chat] Redis returned an invalid rate-limit count", {
        count,
        userId,
      });
      return { status: "unavailable" };
    }

    if (count > CHAT_RATE_LIMIT_MAX_REQUESTS) {
      return { status: "limited", count };
    }

    return { status: "allowed", count };
  } catch (error) {
    logger.warn("api", "[Chat] Redis unavailable; rejecting chat request", {
      error: error instanceof Error ? error.message : String(error),
      userId,
    });
    return { status: "unavailable" };
  }
}
