import type { Logger, LoggerContext } from "../types.js";

/**
 * Every worker alert is prefixed so it is attributable at a glance in a Discord
 * channel that also carries alerts from other deployments. The prefix goes on
 * BOTH the webhook username and the message body: Discord collapses the
 * username on consecutive messages from the same webhook, so the body is the
 * only part that always carries it.
 */
export const ALERT_PREFIX = "RST";
export const ALERT_USERNAME = `${ALERT_PREFIX} TradeBot Worker Alerts`;

export const ERROR_BURST_THRESHOLD = 20;
export const ERROR_BURST_WINDOW_MS = 60 * 60 * 1_000;
/**
 * One alert per day, not one per hour.
 *
 * A known, accepted, unfixed error source (see
 * `docs/HANDOFF-2026-08-26-worker-error-sources.md`) clears the hourly
 * threshold on its own, so an hourly cooldown means 24 identical alerts a day
 * and a channel nobody reads. The counting window stays at one hour: the alert
 * still reports a real hourly rate, it just says it at most once a day.
 *
 * The cost is real and deliberate: a NEW error source that appears an hour
 * after an alert stays silent until the window reopens. Railway's own
 * "Deployment Crashed" webhook and the awaited fatal-startup alert both bypass
 * this cooldown, so the failures that need immediate attention still arrive.
 */
export const ERROR_BURST_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
export const ERROR_BURST_RETRY_DELAY_MS = 30 * 1_000;
export const ERROR_BURST_MAX_EVENTS = 1_000;

/** Redis key holding the cross-restart alert lease. */
export const ERROR_BURST_COOLDOWN_KEY = "worker:error-burst:cooldown";

/**
 * Where the "already alerted recently" fact lives.
 *
 * The cooldown used to be a plain field on the alerter, which meant it died
 * with the process. A worker that restarts, for any reason, came back with an
 * empty cooldown and alerted again on the next burst, so "at most one alert a
 * day" was really "at most one alert per process per day". On a service that
 * redeploys or crash-restarts a few times a day that is not a cooldown at all,
 * and it is exactly what was observed: a second identical burst alert well
 * inside the suppression window, with a restart in between.
 *
 * Modelled as a lease rather than a timestamp so the check and the write are
 * one atomic step. Two workers hitting the threshold at the same moment would
 * both read "no recent alert" and both post, which a compare-then-write cannot
 * prevent.
 */
export interface AlertCooldownStore {
  /**
   * Try to take the lease for `cooldownMs`.
   *
   * Resolves true only for the caller that actually took it. Resolving false
   * means someone else holds it and this alert must be suppressed.
   */
  claim(cooldownMs: number): Promise<boolean>;
  /**
   * Give the lease back after an alert failed to deliver.
   *
   * Without this a rejected webhook would burn the whole suppression window
   * having told nobody, which is worse than the noise the window prevents.
   */
  release(): Promise<void>;
}

/**
 * Process-local fallback. Behaviourally identical to the old inline field, so
 * an unconfigured deployment keeps working exactly as it did.
 */
export class InMemoryAlertCooldownStore implements AlertCooldownStore {
  private heldUntil: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  async claim(cooldownMs: number): Promise<boolean> {
    const now = this.now();
    if (this.heldUntil !== null && now < this.heldUntil) return false;
    this.heldUntil = now + cooldownMs;
    return true;
  }

  async release(): Promise<void> {
    this.heldUntil = null;
  }
}

let sharedCooldownStore: AlertCooldownStore | null = null;

/**
 * Install the process-wide cooldown store. Call once, at entry point startup.
 *
 * Read at claim time rather than at construction: the alerter is built by
 * `createProductionLogger`, which runs long before the worker has a Redis
 * connection to back the store with.
 */
export function setAlertCooldownStore(store: AlertCooldownStore | null): void {
  sharedCooldownStore = store;
}

export function clearAlertCooldownStore(): void {
  sharedCooldownStore = null;
}

export function getAlertCooldownStore(): AlertCooldownStore | null {
  return sharedCooldownStore;
}

interface ErrorEvent {
  at: number;
  service: string;
}

export interface ErrorBurstAlerterOptions {
  webhookUrl: string;
  logger: Logger;
  now?: () => number;
  fetch?: typeof fetch;
  threshold?: number;
  windowMs?: number;
  cooldownMs?: number;
  retryDelayMs?: number;
  /** Overrides the shared store. Injected for tests. */
  cooldownStore?: AlertCooldownStore;
}

/**
 * Render a cooldown as the largest whole unit that describes it exactly.
 *
 * "1440 minutes" is technically right and useless to the person reading the
 * alert at 3am. Falls back to the next unit down when the value is not whole,
 * so a custom cooldown is never rounded into a lie.
 */
export function formatSuppressionWindow(ms: number): string {
  const plural = (value: number, unit: string) =>
    `${value} ${unit}${value === 1 ? "" : "s"}`;
  const minutes = Math.round(ms / 60_000);
  if (minutes <= 0) return plural(minutes, "minute");
  if (minutes % (24 * 60) === 0) return plural(minutes / (24 * 60), "day");
  if (minutes % 60 === 0) return plural(minutes / 60, "hour");
  return plural(minutes, "minute");
}

/**
 * Tracks process-local error volume and sends one redacted webhook notification
 * when the rolling threshold is reached. Alert delivery failures are warnings,
 * so they cannot recursively contribute to the error count.
 */
export class ErrorBurstAlerter {
  private readonly webhookUrl: string;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private readonly retryDelayMs: number;
  private readonly injectedCooldownStore: AlertCooldownStore | undefined;
  private readonly fallbackCooldownStore: AlertCooldownStore;
  private events: ErrorEvent[] = [];
  private nextAttemptAt = 0;
  private deliveryInFlight = false;

  constructor(options: ErrorBurstAlerterOptions) {
    this.webhookUrl = options.webhookUrl;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.fetchFn = options.fetch ?? fetch;
    this.threshold = options.threshold ?? ERROR_BURST_THRESHOLD;
    this.windowMs = options.windowMs ?? ERROR_BURST_WINDOW_MS;
    this.cooldownMs = options.cooldownMs ?? ERROR_BURST_COOLDOWN_MS;
    this.retryDelayMs = options.retryDelayMs ?? ERROR_BURST_RETRY_DELAY_MS;
    this.injectedCooldownStore = options.cooldownStore;
    this.fallbackCooldownStore = new InMemoryAlertCooldownStore(this.now);
  }

  /**
   * Resolve the store for this attempt.
   *
   * Falls back to the process-local store when nothing durable is installed,
   * which keeps a deployment without Redis on the old behaviour rather than
   * alerting on every burst.
   */
  private cooldownStore(): AlertCooldownStore {
    return this.injectedCooldownStore ?? sharedCooldownStore ?? this.fallbackCooldownStore;
  }

  record(service: string): void {
    const now = this.now();
    const windowStart = now - this.windowMs;
    this.events = this.events.filter((event) => event.at > windowStart);
    this.events.push({ at: now, service });
    if (this.events.length > ERROR_BURST_MAX_EVENTS) {
      this.events = this.events.slice(-ERROR_BURST_MAX_EVENTS);
    }

    if (this.events.length <= this.threshold) return;
    if (this.deliveryInFlight || now < this.nextAttemptAt) return;

    // Reserve only the in-flight attempt. The durable cooldown is claimed
    // inside the attempt, because taking it is asynchronous.
    this.deliveryInFlight = true;
    const serviceCounts = this.events.reduce<Record<string, number>>((counts, event) => {
      counts[event.service] = (counts[event.service] ?? 0) + 1;
      return counts;
    }, {});
    void this.attempt(this.events.length, serviceCounts);
  }

  /**
   * Take the cooldown lease, post if it was won, hand it back if the post
   * failed. Always clears the in-flight reservation.
   */
  private async attempt(
    errorCount: number,
    serviceCounts: Record<string, number>,
  ): Promise<void> {
    const store = this.cooldownStore();
    try {
      if (!(await store.claim(this.cooldownMs))) return;

      if (await this.send(errorCount, serviceCounts)) {
        this.nextAttemptAt = 0;
        return;
      }

      // Delivery failed, so nobody was told. Hand the lease back and retry
      // shortly, rather than sitting out the whole suppression window.
      await store.release();
      this.nextAttemptAt = this.now() + this.retryDelayMs;
    } catch {
      // A cooldown store that throws must not take the alerter down with it.
      this.logger.warn("worker-alert", "Error burst cooldown store failed", {
        reason: "store_error",
      });
      this.nextAttemptAt = this.now() + this.retryDelayMs;
    } finally {
      this.deliveryInFlight = false;
    }
  }

  private async send(errorCount: number, serviceCounts: Record<string, number>): Promise<boolean> {
    const services = Object.entries(serviceCounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([service, count]) => `${service}: ${count}`)
      .join(", ");
    const content = [
      `${ALERT_PREFIX} Worker error burst: ${errorCount} errors in the last hour (threshold >${this.threshold}).`,
      `Services: ${services || "unknown"}.`,
      `Further alerts are suppressed for ${formatSuppressionWindow(this.cooldownMs)}.`,
    ].join(" ");

    try {
      const response = await this.fetchFn(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: ALERT_USERNAME, content }),
      });
      if (!response.ok) {
        this.logger.warn("worker-alert", "Error burst alert webhook rejected", {
          status: response.status,
        });
        return false;
      }
      return true;
    } catch {
      this.logger.warn("worker-alert", "Error burst alert webhook delivery failed", {
        reason: "network_error",
      });
      return false;
    }
  }
}

class ErrorBurstLogger implements Logger {
  constructor(
    private readonly base: Logger,
    private readonly alerter: ErrorBurstAlerter,
  ) {}

  error(service: string, message: string, context?: LoggerContext): void {
    this.base.error(service, message, context);
    this.alerter.record(service);
  }

  warn(service: string, message: string, context?: LoggerContext): void {
    this.base.warn(service, message, context);
  }

  notice(service: string, message: string, context?: LoggerContext): void {
    this.base.notice(service, message, context);
  }

  info(service: string, message: string, context?: LoggerContext): void {
    this.base.info(service, message, context);
  }

  debug(service: string, message: string, context?: LoggerContext): void {
    this.base.debug(service, message, context);
  }

  child(context: LoggerContext = {}): Logger {
    return new ErrorBurstLogger(this.base.child(context), this.alerter);
  }

  withDefaultService(service: string): Logger {
    return new ErrorBurstLogger(this.base.withDefaultService(service), this.alerter);
  }

  get raw(): Logger["raw"] {
    return this.base.raw;
  }
}

export function withErrorBurstAlerts(base: Logger, alerter: ErrorBurstAlerter): Logger {
  return new ErrorBurstLogger(base, alerter);
}
