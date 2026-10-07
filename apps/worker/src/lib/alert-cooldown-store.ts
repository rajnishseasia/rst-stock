/**
 * A burst-alert cooldown that survives a worker restart.
 *
 * The ErrorBurstAlerter's suppression window used to be a field on an object
 * living in worker memory. Every restart handed it a clean slate, so the
 * documented "one alert per day" was really "one alert per process per day".
 * A worker that redeploys, or crash-loops, or is restarted by hand while
 * someone investigates the very burst that alerted, reported the same known
 * error source again and again. That is the noise the daily cooldown exists to
 * prevent, so the fact has to outlive the process that learned it.
 *
 * Redis is already a hard dependency of this worker and is where cross-restart
 * state belongs. The lease is a single `SET NX PX`: atomic, self-expiring, and
 * correct across concurrent workers, none of which is true of reading a
 * timestamp and writing it back.
 */

import {
  ERROR_BURST_COOLDOWN_KEY,
  InMemoryAlertCooldownStore,
  type AlertCooldownStore,
} from "@trade-bot/logger";
import type { RedisClient } from "@trade-bot/redis";

export interface RedisAlertCooldownStoreOptions {
  key?: string;
  /** Injected for tests. */
  fallback?: AlertCooldownStore;
}

export class RedisAlertCooldownStore implements AlertCooldownStore {
  private readonly key: string;
  /** Used only while Redis cannot answer. See `claim`. */
  private readonly fallback: AlertCooldownStore;

  constructor(
    private readonly redis: RedisClient,
    options: RedisAlertCooldownStoreOptions = {},
  ) {
    this.key = options.key ?? ERROR_BURST_COOLDOWN_KEY;
    this.fallback = options.fallback ?? new InMemoryAlertCooldownStore();
  }

  /**
   * Take the lease, or report that someone already holds it.
   *
   * When Redis cannot answer (`setIfNotExists` resolves null) this defers to a
   * process-local window instead of suppressing. An alerting path must not go
   * silent because its bookkeeping store is unreachable: a duplicate alert is
   * a nuisance, a missed burst is the incident. The local window means the
   * degraded mode is the old per-process behaviour, not a flood, and a Redis
   * outage is itself the kind of thing that produces a burst worth hearing
   * about.
   */
  async claim(cooldownMs: number): Promise<boolean> {
    const claimed = await this.redis.setIfNotExists(this.key, "1", cooldownMs);
    if (claimed === null) return this.fallback.claim(cooldownMs);
    return claimed;
  }

  async release(): Promise<void> {
    await this.redis.del(this.key);
    await this.fallback.release();
  }
}
