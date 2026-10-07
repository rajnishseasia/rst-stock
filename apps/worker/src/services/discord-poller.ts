/**
 * Discord Channel Poller
 *
 * Uses the Discord REST API to poll for new messages in the stock-calls channel.
 * This approach does NOT require gateway intents — only the bot's "Read Message History"
 * permission on the channel, which the bot owner has already granted.
 */

import { schema, createWorkerPoolDb } from '@trade-bot/db';
import { createProductionLogger } from '@trade-bot/logger';
import { parseCanonicalPerpCoin } from '@trade-bot/hyperliquid';
import { eq, sql } from 'drizzle-orm';
import {
  isPlausibleSourceEventTimestamp,
} from '@trade-bot/utils';
import {
  extractFirstDiscordImageUrl,
  mergeDiscordSignalMetadata,
  stripLeadingTweeted,
  type DiscordAttachment,
  type DiscordMediaEmbed,
  type DiscordSignalMetadataInput,
} from './discord-signal-parser';
import { tryObserveCanonicalAuthor } from './canonical-author-store';
import { applySourceEventDedup } from './ingestion-dedup';

const logger = createProductionLogger();

const DISCORD_CHANNEL_ID = '966888471883055104'; // 🚀・stock-calls
const DISCORD_API_BASE = 'https://discord.com/api/v10';
const POLL_INTERVAL_MS = 15_000; // Poll every 15 seconds
const DISCORD_PAGE_SIZE = 100;
const DEFAULT_HISTORY_PAGES = 10;
const MAX_HISTORY_PAGES = 100;
const MAX_RECOVERY_MESSAGES = 5_000;
const MAX_EVENT_FUTURE_SKEW_MS = 5 * 60 * 1000;
const DISCORD_CURSOR_SOURCE = `discord:channel:${DISCORD_CHANNEL_ID}`;

/**
 * Discord answers a burst of message reads with 429 and a `retry_after` that is
 * routinely under a second. Treating that as a failed poll threw away the whole
 * recovery cycle and logged an error, which is how a handful of sub-second
 * waits became a share of the hourly error-burst alert. Wait and re-issue
 * instead: the poller is the only reader of this channel, so the backlog is
 * still there a moment later.
 */
const DISCORD_RATE_LIMIT_MAX_RETRIES = 3;
/**
 * Longest wait this poller will absorb for one rate-limited page. A longer
 * `retry_after` means a global limit rather than a per-route burst, and Discord
 * escalates to a Cloudflare-level ban for clients that retry through one. Above
 * this bound the 429 is surfaced instead: the next tick is only 15s away.
 */
const DISCORD_RATE_LIMIT_MAX_WAIT_MS = 5_000;
/** Used when Discord rate-limits without a parseable delay. */
const DISCORD_RATE_LIMIT_FALLBACK_WAIT_MS = 1_000;

/**
 * Resolve how long Discord asked the caller to wait, in milliseconds.
 *
 * `retry_after` is JSON seconds as a float ("0.417"); the `Retry-After` header
 * carries the same value and is the only source on a Cloudflare-level 429,
 * whose body is HTML. The value is returned as requested, not clamped: the
 * caller has to see a long wait to decide it is not worth retrying at all.
 */
export function resolveDiscordRetryAfterMs(
  body: string,
  header: string | null,
): number {
  const fromBody = (() => {
    try {
      const parsed: unknown = JSON.parse(body);
      const value = (parsed as { retry_after?: unknown } | null)?.retry_after;
      return typeof value === 'number' ? value : null;
    } catch {
      return null;
    }
  })();
  const fromHeader = header !== null && header.trim() !== '' ? Number(header) : null;
  const seconds = fromBody ?? fromHeader;
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return DISCORD_RATE_LIMIT_FALLBACK_WAIT_MS;
  }
  return Math.ceil(seconds * 1_000);
}

/** Discord's `before` cursor is exclusive; advance it to replay the max ID. */
function inclusiveDiscordBeforeCursor(messageId: string): string {
  return (BigInt(messageId) + 1n).toString();
}
type DiscordFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type DiscordSleep = (ms: number) => Promise<void>;

export function parseDiscordHistoryPages(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_HISTORY_PAGES;
  if (!/^\d+$/.test(value.trim())) return 1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_HISTORY_PAGES
    ? parsed
    : 1;
}

export function sortDiscordMessagesOldestFirst<T extends { id: string }>(
  messages: T[],
): T[] {
  return [...messages].sort((a, b) => {
    const aId = BigInt(a.id);
    const bId = BigInt(b.id);
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });
}

interface DiscordEmbed extends DiscordMediaEmbed {
  title?: string;
  description?: string;
  url?: string;
  author?: { name?: string; url?: string; icon_url?: string };
  fields?: { name: string; value: string }[];
}

interface DiscordMessage {
  id: string;
  content: string;
  author: {
    id: string;
    username: string;
    avatar?: string | null;
    bot?: boolean;
  };
  timestamp: string;
  channel_id: string;
  guild_id?: string;
  /** Present for webhook messages; author.id is then the webhook, not the X caller. */
  webhook_id?: string;
  attachments?: DiscordAttachment[];
  embeds?: DiscordEmbed[];
}

interface DiscordCursorRow {
  cursor?: string | null;
  backfillCursor?: string | null;
  backfillComplete?: boolean | null;
}

type DiscordProcessResult = 'inserted' | 'duplicate' | 'ignored' | 'skipped';

export class DiscordPoller {
  private db: ReturnType<typeof createWorkerPoolDb>;
  private token: string | undefined;
  private lastMessageId: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private historyLoading = false;
  private readonly historyPages: number;
  private readonly fetchImpl: DiscordFetch;
  private readonly sleepImpl: DiscordSleep;
  private readonly recoveryMessageCap: number;
  private cursorLoaded = false;
  private polling = false;
  private lastPageWasFull = false;
  private lastRejectedMessageCount = 0;
  private lastPageMinMessageId: string | null = null;
  private lastPageMaxMessageId: string | null = null;
  private backfillCursor: string | null = null;
  private backfillComplete = false;
  private readonly now: () => Date;

  constructor(
    db: ReturnType<typeof createWorkerPoolDb>,
    options: {
      historyPages?: number;
      fetchImpl?: DiscordFetch;
      sleepImpl?: DiscordSleep;
      recoveryMessageCap?: number;
      now?: () => Date;
    } = {},
  ) {
    this.db = db;
    this.token = process.env.DISCORD_BOT_TOKEN;
    this.historyPages = options.historyPages ?? parseDiscordHistoryPages(
      process.env.DISCORD_HISTORY_BACKFILL_PAGES,
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => new Date());
    this.recoveryMessageCap = Math.max(
      DISCORD_PAGE_SIZE,
      Math.min(MAX_RECOVERY_MESSAGES, Math.floor(options.recoveryMessageCap ?? MAX_RECOVERY_MESSAGES)),
    );
  }

  /**
   * Extract $TICKER symbols from message text
   */
  private extractSymbols(text: string): string[] {
    const cashtagRegex = /\$([A-Za-z0-9]+(?:(?:[.:-])[A-Za-z0-9]+)*)(?![A-Za-z0-9./:-])/g;
    const symbols = new Set<string>();

    let match;
    while ((match = cashtagRegex.exec(text)) !== null) {
      const raw = match[1];
      const normalized = text[cashtagRegex.lastIndex] === '$'
        ? null
        : this.parseTicker(raw);
      if (normalized) symbols.add(normalized);
    }

    return Array.from(symbols);
  }

  /** Normalize only explicit, syntactically valid symbols. Never infer an HL prefix. */
  private parseTicker(raw: string | undefined): string | null {
    if (!raw || raw.length > 21 || !/[A-Za-z]/.test(raw)) return null;
    if (raw.includes(':')) return parseCanonicalPerpCoin(raw);
    if (raw.startsWith('k')) {
      if (!/^k[A-Z0-9]+$/.test(raw)) return null;
      return parseCanonicalPerpCoin(raw);
    }
    return /^[A-Za-z0-9.-]+$/.test(raw) ? raw.toUpperCase() : null;
  }

  /**
   * Extract the original tweet URL from a TweetShift Discord message.
   *
   * TweetShift sets the embed URL to the tweet permalink and also embeds tweet
   * links in the content/description. We scan those for a real tweet status link
   * and normalise known proxy domains (fxtwitter/vxtwitter/etc.) back to the
   * canonical x.com URL so "View Original" opens the actual tweet — never Discord.
   * Returns null when no tweet link is present.
   */
  private extractTweetUrl(msg: DiscordMessage): string | null {
    const statusRegex =
      /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com|fxtwitter\.com|vxtwitter\.com|fixupx\.com|fixvx\.com|nitter\.[^/]+)\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/i;

    const candidates: string[] = [];
    if (msg.embeds) {
      for (const embed of msg.embeds) {
        if (embed.url) candidates.push(embed.url);
        if (embed.description) candidates.push(embed.description);
        if (embed.title) candidates.push(embed.title);
        if (embed.author?.url) candidates.push(embed.author.url);
        if (embed.fields) {
          for (const field of embed.fields) {
            candidates.push(field.name, field.value);
          }
        }
      }
    }
    if (msg.content) candidates.push(msg.content);

    for (const candidate of candidates) {
      const match = candidate.match(statusRegex);
      if (match) {
        const handle = match[1];
        const tweetId = match[2];
        return `https://x.com/${handle}/status/${tweetId}`;
      }
    }

    return null;
  }

  /**
   * Issue one Discord read, re-issuing it while the API answers 429.
   *
   * Returns the last response either way, so a non-429 failure and an exhausted
   * retry budget both surface through the caller's existing error path.
   */
  private async fetchWithRateLimitRetry(url: URL): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchImpl(url, {
        headers: {
          Authorization: `Bot ${this.token}`,
        },
      });
      if (response.status !== 429 || attempt >= DISCORD_RATE_LIMIT_MAX_RETRIES) {
        return response;
      }
      // Clone before reading: the caller reads the body of whatever this
      // returns, and a body can only be consumed once.
      const waitMs = resolveDiscordRetryAfterMs(
        await response.clone().text(),
        response.headers.get('retry-after'),
      );
      if (waitMs > DISCORD_RATE_LIMIT_MAX_WAIT_MS) {
        logger.warn('discord', 'Discord rate limit is too long to wait out; failing the read', {
          attempt: attempt + 1,
          waitMs,
        });
        return response;
      }
      logger.warn('discord', 'Discord rate limited the message read; retrying', {
        attempt: attempt + 1,
        waitMs,
      });
      await this.sleepImpl(waitMs);
    }
  }

  /**
   * Fetch messages from the Discord channel using the REST API
   */
  private async fetchMessages(cursor?: {
    after?: string;
    before?: string;
  }): Promise<DiscordMessage[]> {
    const url = new URL(`${DISCORD_API_BASE}/channels/${DISCORD_CHANNEL_ID}/messages`);
    url.searchParams.set('limit', String(DISCORD_PAGE_SIZE));
    if (cursor?.after) url.searchParams.set('after', cursor.after);
    if (cursor?.before) url.searchParams.set('before', cursor.before);

    const response = await this.fetchWithRateLimitRetry(url);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Discord API error ${response.status}: ${errorBody}`);
    }

    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new Error('Discord API returned a non-array message page');

    this.lastPageWasFull = body.length === DISCORD_PAGE_SIZE;
    this.lastRejectedMessageCount = 0;
    const numericIds = body
      .map((candidate) =>
        candidate && typeof candidate === 'object' && typeof (candidate as { id?: unknown }).id === 'string'
          ? (candidate as { id: string }).id
          : null,
      )
      .filter((id): id is string => id !== null && /^\d+$/.test(id));
    const sortedNumericIds = [...numericIds].sort((a, b) => {
      const left = BigInt(a);
      const right = BigInt(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    this.lastPageMinMessageId = sortedNumericIds[0] ?? null;
    this.lastPageMaxMessageId = sortedNumericIds.at(-1) ?? null;
    const messages: DiscordMessage[] = [];
    for (const candidate of body) {
      if (this.isValidDiscordMessage(candidate)) {
        messages.push(candidate);
      } else {
        this.lastRejectedMessageCount += 1;
      }
    }
    if (this.lastRejectedMessageCount > 0) {
      logger.warn('discord', 'Skipped malformed Discord events', {
        rejectedMessageCount: this.lastRejectedMessageCount,
        returnedMessageCount: body.length,
        cursor: cursor?.after ?? cursor?.before ?? null,
      });
    }
    return messages;
  }

  private isValidDiscordMessage(value: unknown): value is DiscordMessage {
    if (!value || typeof value !== 'object') return false;
    const message = value as Partial<DiscordMessage>;
    return (
      typeof message.id === 'string' &&
      /^\d+$/.test(message.id) &&
      typeof message.content === 'string' &&
      typeof message.timestamp === 'string' &&
      typeof message.channel_id === 'string' &&
      Boolean(message.author) &&
      typeof message.author === 'object' &&
      typeof message.author.id === 'string' &&
      message.author.id.trim().length > 0 &&
      typeof message.author.username === 'string'
    );
  }

  /**
   * Process a single Discord message and insert matching signals
   */
  private async processMessage(msg: DiscordMessage): Promise<DiscordProcessResult> {
    // Combine message content + all embed text to find tickers
    let fullText = msg.content || '';
    if (msg.embeds && msg.embeds.length > 0) {
      for (const embed of msg.embeds) {
        if (embed.title) fullText += ' ' + embed.title;
        if (embed.description) fullText += ' ' + embed.description;
        if (embed.fields) {
          for (const field of embed.fields) {
            fullText += ' ' + field.name + ' ' + field.value;
          }
        }
      }
    }

    // Clean up markdown links like [Text](https://...) -> "Text"
    fullText = fullText.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    // Remove raw floating URLs
    fullText = fullText.replace(/https?:\/\/[^\s]+/g, '');
    // Condense multiple spaces and remove TweetShift's leading relay label
    fullText = stripLeadingTweeted(fullText.replace(/\s+/g, ' ').trim());

    if (!fullText) return 'ignored';

    const symbols = this.extractSymbols(fullText);
    if (symbols.length === 0) return 'ignored';

    const messageTimestamp = new Date(msg.timestamp);
    if (Number.isNaN(messageTimestamp.getTime())) {
      logger.warn('discord', 'Skipping event with invalid timestamp', {
        messageId: msg.id,
        timestamp: msg.timestamp.slice(0, 80),
      });
      return 'skipped';
    }
    if (!isPlausibleSourceEventTimestamp(messageTimestamp, this.now())) {
      logger.warn('discord', 'Skipping implausibly future event', {
        messageId: msg.id,
        timestamp: msg.timestamp.slice(0, 80),
        maxFutureSkewMs: MAX_EVENT_FUTURE_SKEW_MS,
      });
      return 'skipped';
    }

    const imageUrl = extractFirstDiscordImageUrl(msg);

    // The link we surface to users is the ORIGINAL tweet, not the Discord
    // message. We intentionally do not record the Discord URL.
    const tweetUrl = this.extractTweetUrl(msg);

    // TweetShift relays tweets via Discord webhooks and sets the message author's
    // avatar to the tweet author's Twitter profile picture. Fall back to the
    // embed author icon if the webhook avatar is absent.
    const embedAuthorIcon =
      msg.embeds?.find((e) => e.author?.icon_url)?.author?.icon_url || null;
    const authorAvatar = msg.author.avatar
      ? `https://cdn.discordapp.com/avatars/${msg.author.id}/${msg.author.avatar}.png?size=128`
      : embedAuthorIcon;

    // Store the FULL tweet text. The content column is TEXT (unbounded); this cap
    // is only a sanity limit so a pathological payload can't bloat a row. (X
    // premium posts can be long — the old 500-char cap chopped multi-paragraph
    // tweets after ~2 paragraphs.)
    const content = fullText.slice(0, 8000);
    // Discord webhook/bot IDs identify the relay, not the caller named by the
    // embedded X post. Treating one relay ID as an author would merge unrelated
    // callers. A human-authored Discord event can use its immutable Discord ID;
    // relay events remain safely name/handle based until an upstream caller ID is
    // available.
    const isRelay = Boolean(msg.webhook_id || msg.author.bot);
    const sourceAuthorId = isRelay ? null : msg.author.id;
    const baseMetadata: DiscordSignalMetadataInput = {
      authorId: msg.author.id,
      authorName: msg.author.username,
      authorHandle: msg.author.username,
      authorAvatar,
      messageId: msg.id,
      tweetUrl,
      imageUrl,
      authorIdentityKind: isRelay ? 'relay' : 'source_author',
    };
    const observedAuthor = await tryObserveCanonicalAuthor(this.db, baseMetadata, {
      source: 'discord',
      sourceAuthorId,
      identityKind: isRelay ? 'relay' : 'source_author',
      currentHandle: msg.author.username,
      displayName: msg.author.username,
      avatar: authorAvatar,
    });
    const metadata = observedAuthor.metadata as DiscordSignalMetadataInput & Record<string, unknown>;

    let inserted = false;
    for (const symbol of symbols) {
      const sourceEventId = `discord:${msg.channel_id}:${msg.id}:${symbol}`;
      const existing = await this.db.query.signals.findFirst({
        where: (signals: any, { and, eq: eqOp, isNull: isNullOp, or }: any) =>
          and(
            eqOp(signals.source, 'discord'),
            eqOp(signals.symbol, symbol),
            or(
              eqOp(signals.sourceEventId, sourceEventId),
              and(
                isNullOp(signals.sourceEventId),
                or(
                  eqOp(signals.timestamp, messageTimestamp),
                  ...(tweetUrl ? [eqOp(signals.url, tweetUrl)] : []),
                ),
              ),
            ),
          ),
      });

      if (existing) {
        // Repair rows backfilled before recent changes: swap in the resolved
        // tweet URL and refresh content and metadata.
        const mergedMetadata = mergeDiscordSignalMetadata(
          existing.metadata,
          metadata
        );
        const updates: {
          url?: string | null;
          content?: string;
          sourceEventId?: string;
          sourceAuthorId?: string | null;
          metadata?: Record<string, unknown>;
        } = {};
        if (tweetUrl && existing.url !== tweetUrl) updates.url = tweetUrl;
        if (existing.content !== content) updates.content = content;
        if (!existing.sourceEventId) updates.sourceEventId = sourceEventId;
        if (!existing.sourceAuthorId && observedAuthor.sourceAuthorId) {
          updates.sourceAuthorId = observedAuthor.sourceAuthorId;
        }
        if (
          existing.sourceAuthorId &&
          !observedAuthor.sourceAuthorId &&
          mergedMetadata.metadata.authorIdentityKind === 'relay'
        ) {
          updates.sourceAuthorId = null;
        }
        if (mergedMetadata.changed) updates.metadata = mergedMetadata.metadata;
        if (Object.keys(updates).length > 0) {
          await this.db
            .update(schema.signals)
            .set(updates)
            .where(eq(schema.signals.id, existing.id));
        }
        continue;
      }

      const values = {
        source: 'discord',
        sourceEventId,
        sourceAuthorId: observedAuthor.sourceAuthorId,
        symbol,
        content,
        url: tweetUrl,
        timestamp: messageTimestamp,
        metadata,
      };
      const insertBuilder = (this.db.insert(schema.signals).values(values) as any);
      await applySourceEventDedup(insertBuilder);

      inserted = true;
      logger.info('discord', `Inserted signal: ${symbol} from ${msg.author.username}`);
    }
    return inserted ? 'inserted' : 'duplicate';
  }

  private hasDurableCursorSupport(): boolean {
    const dbAny = this.db as any;
    return Boolean(
      dbAny.query?.signalIngestionCursors?.findFirst &&
        typeof dbAny.insert === 'function',
    );
  }

  private async readCursor(): Promise<DiscordCursorRow | undefined> {
    return (await (this.db as any).query.signalIngestionCursors.findFirst({
      where: eq(schema.signalIngestionCursors.source, DISCORD_CURSOR_SOURCE),
      columns: { cursor: true, backfillCursor: true, backfillComplete: true },
    })) as DiscordCursorRow | undefined;
  }

  private adoptDurableCursorState(row: DiscordCursorRow | undefined): void {
    this.lastMessageId = typeof row?.cursor === 'string' && /^\d+$/.test(row.cursor)
      ? row.cursor
      : null;
    this.backfillCursor = typeof row?.backfillCursor === 'string' && /^\d+$/.test(row.backfillCursor)
      ? row.backfillCursor
      : null;
    this.backfillComplete = row?.backfillComplete === true;
    if (this.lastMessageId && !this.backfillComplete && !this.backfillCursor) {
      this.backfillCursor = this.lastMessageId;
    }
  }

  private async loadCursor(): Promise<void> {
    if (this.cursorLoaded) return;
    if (!this.hasDurableCursorSupport()) {
      this.cursorLoaded = true;
      return;
    }
    const row = await this.readCursor();
    this.adoptDurableCursorState(row);
    // Rows written before the corrective migration have a forward cursor but
    // no backward boundary. Start a lossless bounded sweep immediately before
    // that cursor instead of treating the old bounded startup pass as done.
    this.cursorLoaded = true;
  }

  private async refreshDurableCursorState(): Promise<void> {
    if (!this.hasDurableCursorSupport()) return;
    this.adoptDurableCursorState(await this.readCursor());
  }

  private async persistCursor(
    cursor: string,
    status: 'healthy' | 'skipped_malformed' | 'skipped_invalid',
  ): Promise<boolean> {
    if (!this.hasDurableCursorSupport()) return false;
    const now = new Date();
    const builder = (this.db as any)
      .insert(schema.signalIngestionCursors)
      .values({
        source: DISCORD_CURSOR_SOURCE,
        cursor,
        cursorSequence: cursor,
        backfillCursor: this.backfillCursor,
        backfillComplete: this.backfillComplete,
        watermark: now,
        status,
        lastError: null,
        updatedAt: now,
      });
    if (typeof builder.onConflictDoUpdate === 'function') {
      const conflictBuilder = builder.onConflictDoUpdate({
        target: schema.signalIngestionCursors.source,
        set: {
          cursor,
          cursorSequence: cursor,
          watermark: now,
          status,
          lastError: null,
          updatedAt: now,
        },
        setWhere: sql`
          ${schema.signalIngestionCursors.cursorSequence} is null
          or ${schema.signalIngestionCursors.cursorSequence}::numeric <= excluded."cursor_sequence"::numeric
        `,
      });
      if (typeof conflictBuilder.returning === 'function') {
        const rows = await conflictBuilder.returning({
          source: schema.signalIngestionCursors.source,
        });
        if (!Array.isArray(rows) || rows.length > 0) return true;
        // Another replica won the monotonic cursor race. Read its complete
        // state before the next request so this process cannot poll from a
        // stale cursor and replay an unbounded window.
        await this.refreshDurableCursorState();
        return false;
      }
      await conflictBuilder;
    } else {
      await builder;
    }
    return true;
  }

  private async persistBackfillState(
    backfillCursor: string | null,
    backfillComplete: boolean,
  ): Promise<void> {
    this.backfillCursor = backfillCursor;
    this.backfillComplete = backfillComplete;
    if (!this.hasDurableCursorSupport()) return;
    const dbAny = this.db as any;
    const now = new Date();
    const builder = dbAny.insert(schema.signalIngestionCursors).values({
      source: DISCORD_CURSOR_SOURCE,
      cursor: this.lastMessageId,
      cursorSequence: this.lastMessageId,
      backfillCursor,
      backfillComplete,
      watermark: now,
      status: 'healthy',
      lastError: null,
      updatedAt: now,
    });
    if (typeof builder.onConflictDoUpdate === 'function') {
      const conflictBuilder = builder.onConflictDoUpdate({
        target: schema.signalIngestionCursors.source,
        set: { backfillCursor, backfillComplete, updatedAt: now },
        setWhere: sql`
          not ${schema.signalIngestionCursors.backfillComplete}
          and (
            excluded."backfill_complete"
            or (
              excluded."backfill_cursor" is not null
              and (
                ${schema.signalIngestionCursors.backfillCursor} is null
                or ${schema.signalIngestionCursors.backfillCursor}::numeric > excluded."backfill_cursor"::numeric
              )
            )
          )
        `,
      });
      if (typeof conflictBuilder.returning === 'function') {
        const rows = await conflictBuilder.returning({
          source: schema.signalIngestionCursors.source,
        });
        if (!Array.isArray(rows) || rows.length > 0) return;
        // A second replica may have completed or moved the durable backward
        // boundary. Adopt that state before issuing another Discord request.
        await this.refreshDurableCursorState();
        return;
      }
      await conflictBuilder;
    } else {
      await builder;
    }
  }

  private async advanceCursor(
    cursor: string,
    status: 'healthy' | 'skipped_malformed' | 'skipped_invalid' = 'healthy',
  ): Promise<void> {
    if (this.lastMessageId && BigInt(cursor) <= BigInt(this.lastMessageId)) return;
    const persisted = await this.persistCursor(cursor, status);
    // Unit-test doubles and pre-gate development instances have no cursor API;
    // keep their historical in-memory behavior. Production has the schema gate.
    if (persisted || !this.hasDurableCursorSupport()) this.lastMessageId = cursor;
  }

  private async processMessagesInOrder(
    messages: DiscordMessage[],
    options: { advanceMainCursor?: boolean } = {},
  ): Promise<number> {
    const advanceMainCursor = options.advanceMainCursor !== false;
    let processed = 0;
    for (const message of sortDiscordMessagesOldestFirst(messages)) {
      if (processed >= this.recoveryMessageCap) break;
      const result = await this.processMessage(message);
      if (advanceMainCursor) {
        await this.advanceCursor(message.id, result === 'skipped' ? 'skipped_invalid' : 'healthy');
      }
      processed += 1;
    }
    return processed;
  }

  private async advanceMalformedPageBoundary(
    boundary = this.lastPageMaxMessageId,
    allValidRowsProcessed = true,
  ): Promise<boolean> {
    if (!allValidRowsProcessed) return false;
    if (!boundary || (this.lastMessageId && BigInt(boundary) <= BigInt(this.lastMessageId))) return false;
    const previous = this.lastMessageId;
    await this.advanceCursor(boundary, 'skipped_malformed');
    logger.warn('discord', 'Advanced past malformed Discord events', {
      cursor: boundary,
      rejectedMessageCount: this.lastRejectedMessageCount,
    });
    return this.lastMessageId !== previous;
  }

  /** Initial bounded history sweep, or forward recovery from the durable cursor. */
  private async fetchHistory() {
    if (this.historyLoading) return;
    this.historyLoading = true;
    try {
      await this.loadCursor();
      if (this.lastMessageId) {
        if (this.backfillCursor && !this.backfillComplete) {
          await this.recoverBackfill();
        }
        await this.recoverForward();
        return;
      }
      logger.info(
        'discord',
        `Recovering up to ${Math.min(this.historyPages * DISCORD_PAGE_SIZE, this.recoveryMessageCap)} historical messages ` +
          `(${this.historyPages} page${this.historyPages === 1 ? '' : 's'})...`,
      );
      const messagesById = new Map<string, DiscordMessage>();
      let before: string | undefined;
      let pagesFetched = 0;
      let recoveryCapped = false;
      let rejectedMessageCount = 0;
      let rawMaxMessageId: string | null = null;
      for (let pageNumber = 0; pageNumber < this.historyPages; pageNumber++) {
        const page = await this.fetchMessages(before ? { before } : undefined);
        pagesFetched += 1;
        rejectedMessageCount += this.lastRejectedMessageCount;
        if (page.length === 0 && !this.lastPageMaxMessageId) break;
        for (const message of page) messagesById.set(message.id, message);
        if (this.lastPageMaxMessageId && (!rawMaxMessageId || BigInt(this.lastPageMaxMessageId) > BigInt(rawMaxMessageId))) {
          rawMaxMessageId = this.lastPageMaxMessageId;
        }

        before = this.lastPageMinMessageId ?? sortDiscordMessagesOldestFirst(page)[0]?.id;
        if (!before || !this.lastPageWasFull) break;
      }

      const allSorted = sortDiscordMessagesOldestFirst([...messagesById.values()]);
      const sorted = allSorted.slice(0, this.recoveryMessageCap);
      recoveryCapped = allSorted.length > sorted.length;
      // This is the raw page boundary, not the last successfully inserted
      // event. Discord's `before` parameter is exclusive, so use the numeric
      // successor of the raw max to replay that entire page on a retry.
      if (rawMaxMessageId) {
        await this.persistBackfillState(
          inclusiveDiscordBeforeCursor(rawMaxMessageId),
          false,
        );
      }
      const count = await this.processMessagesInOrder(sorted);
      const allValidRowsProcessed = sorted.length === allSorted.length;
      if (allValidRowsProcessed && rawMaxMessageId) {
        await this.advanceMalformedPageBoundary(rawMaxMessageId);
      }
      const backfillComplete = pagesFetched === 0 || !this.lastPageWasFull || !before;
      await this.persistBackfillState(backfillComplete ? null : before ?? null, backfillComplete);
      logger.info('discord', 'Discord history recovery completed', {
        state: 'healthy',
        pagesFetched,
        fetchedMessageCount: messagesById.size,
        processedMessageCount: count,
        rejectedMessageCount,
        recoveryCapped,
        cursor: this.lastMessageId,
      });
    } catch (error) {
      logger.error('discord', 'Failed to fetch history', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.historyLoading = false;
    }
  }

  /** Continue a bounded backward sweep from the durable raw boundary. */
  private async recoverBackfill(): Promise<void> {
    let before = this.backfillCursor;
    let pagesFetched = 0;
    let processedMessageCount = 0;
    let recoveryCapped = false;
    let rejectedMessageCount = 0;
    while (before && pagesFetched < this.historyPages) {
      if (processedMessageCount >= this.recoveryMessageCap) {
        recoveryCapped = true;
        break;
      }
      const page = await this.fetchMessages({ before });
      pagesFetched += 1;
      rejectedMessageCount += this.lastRejectedMessageCount;
      if (page.length === 0 && !this.lastPageMaxMessageId) {
        await this.persistBackfillState(null, true);
        break;
      }
      const sorted = sortDiscordMessagesOldestFirst(page);
      const remaining = this.recoveryMessageCap - processedMessageCount;
      if (sorted.length > remaining) {
        // Discord's `before` cursor cannot resume the unprocessed newer suffix
        // of this page. Leave the same raw boundary in place and retry the
        // entire page on the next pass rather than skipping valid events.
        recoveryCapped = true;
        await this.persistBackfillState(before, false);
        break;
      }
      processedMessageCount += await this.processMessagesInOrder(sorted, {
        advanceMainCursor: false,
      });

      const nextBefore = this.lastPageMinMessageId;
      if (!nextBefore || !this.lastPageWasFull) {
        await this.persistBackfillState(null, true);
        break;
      }
      if (BigInt(nextBefore) >= BigInt(before)) {
        logger.error('discord', 'Discord backfill boundary did not move', {
          before,
          nextBefore,
        });
        break;
      }
      before = nextBefore;
      await this.persistBackfillState(before, false);
    }
    logger.info('discord', 'Discord backfill recovery completed', {
      state: 'healthy',
      pagesFetched,
      processedMessageCount,
      rejectedMessageCount,
      recoveryCapped,
      backfillCursor: this.backfillCursor,
      backfillComplete: this.backfillComplete,
    });
  }

  private async recoverForward(): Promise<void> {
    let pagesFetched = 0;
    let processedMessageCount = 0;
    let recoveryCapped = false;
    let rejectedMessageCount = 0;
    let after = this.lastMessageId;
    while (after && pagesFetched < this.historyPages) {
      const page = await this.fetchMessages({ after });
      pagesFetched += 1;
      rejectedMessageCount += this.lastRejectedMessageCount;
      if (page.length === 0 && !this.lastPageMaxMessageId) break;

      const sorted = sortDiscordMessagesOldestFirst(page).filter(
        (message) => BigInt(message.id) > BigInt(after!),
      );
      const pageCursor = after;
      if (sorted.length > 0) {
        const remaining = this.recoveryMessageCap - processedMessageCount;
        if (remaining <= 0) {
          recoveryCapped = true;
          break;
        }
        const slice = sorted.slice(0, remaining);
        processedMessageCount += await this.processMessagesInOrder(slice);
        if (slice.length < sorted.length) {
          recoveryCapped = true;
          break;
        }
        after = this.lastMessageId;
      }
      const progressed = await this.advanceMalformedPageBoundary(
        this.lastPageMaxMessageId,
        true,
      );
      after = this.lastMessageId;
      if (after === pageCursor && !progressed) break;
      if (!after || !this.lastPageWasFull) break;
      if (processedMessageCount >= this.recoveryMessageCap) {
        recoveryCapped = true;
        break;
      }
    }
    logger.info('discord', 'Discord forward recovery completed', {
      state: 'healthy',
      pagesFetched,
      processedMessageCount,
      rejectedMessageCount,
      recoveryCapped,
      cursor: this.lastMessageId,
    });
  }

  /**
   * Poll for new messages since the last known message ID
   */
  private async pollNewMessages() {
    if (this.polling) {
      logger.info('discord', 'Skipping poll tick: previous cycle still in flight', {
        state: 'unchanged',
        reason: 'in_flight',
      });
      return;
    }
    this.polling = true;
    try {
      await this.loadCursor();
      if (!this.lastMessageId) {
        await this.fetchHistory();
        return;
      }

      if (this.backfillCursor && !this.backfillComplete) {
        await this.recoverBackfill();
      }
      await this.recoverForward();
    } catch (error) {
      logger.error('discord', 'Poll failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.polling = false;
    }
  }

  /**
   * Start the poller
   */
  public async start() {
    if (!this.token) {
      logger.warn('discord', 'DISCORD_BOT_TOKEN is not set. Discord poller will not start.');
      return;
    }

    // Verify the token works
    try {
      const res = await this.fetchImpl(`${DISCORD_API_BASE}/users/@me`, {
        headers: { Authorization: `Bot ${this.token}` },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Token verification failed (${res.status}): ${body}`);
      }
      const bot = (await res.json()) as { username: string };
      logger.info('discord', `Authenticated as bot: ${bot.username}`);
    } catch (error) {
      logger.error('discord', 'Bot token is invalid or expired', {
        error: error instanceof Error ? error.message : String(error),
      });
      return; // Don't crash the entire worker
    }

    // Complete the first bounded recovery before scheduling forward polls. A
    // failure leaves the durable cursor unchanged and is retried on the next tick.
    await this.fetchHistory();

    this.timer = setInterval(() => {
      void this.pollNewMessages();
    }, POLL_INTERVAL_MS);

    logger.info('discord', `Polling every ${POLL_INTERVAL_MS / 1000}s for new messages in stock-calls`);
  }

  /**
   * Stop the poller and clean up the interval
   */
  public stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('discord', 'Poller stopped.');
    }
  }
}
