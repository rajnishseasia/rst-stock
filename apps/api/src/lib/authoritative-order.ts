import { and, eq, gt, inArray, isNotNull, isNull, ne, notExists, or, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";
import { schema } from "@trade-bot/db";

type OrderIdentityColumns = {
  id: AnyColumn;
  userId: AnyColumn;
  brokerOrderId: AnyColumn;
  brokerAccountId: AnyColumn;
  brokerCredentialId: AnyColumn;
  venue: AnyColumn;
};

type SocialIdentityColumns = {
  userId: AnyColumn;
  orderId: AnyColumn;
  brokerOrderId: AnyColumn;
};

type AuthoritativeOrderSelectDb = {
  select: (...args: any[]) => any;
};

/**
 * Join a social event to exactly one local order. New events use order_id;
 * legacy events may use broker_order_id only when the broker id resolves to
 * one complete account/credential/venue scope with no competing scope.
 */
export function buildAuthoritativeOrderJoin(
  db: AuthoritativeOrderSelectDb,
  socialTrades: SocialIdentityColumns,
  orders: OrderIdentityColumns,
  otherOrders: OrderIdentityColumns,
): SQL {
  const sameScope = and(
    eq(otherOrders.userId, orders.userId),
    eq(otherOrders.brokerOrderId, orders.brokerOrderId),
    sql`${otherOrders.brokerAccountId} is not distinct from ${orders.brokerAccountId}`,
    sql`${otherOrders.brokerCredentialId} is not distinct from ${orders.brokerCredentialId}`,
    sql`lower(coalesce(${otherOrders.venue}, '')) is not distinct from lower(coalesce(${orders.venue}, ''))`,
  );
  const differentScope = or(
    sql`${otherOrders.brokerAccountId} is distinct from ${orders.brokerAccountId}`,
    sql`${otherOrders.brokerCredentialId} is distinct from ${orders.brokerCredentialId}`,
    sql`lower(coalesce(${otherOrders.venue}, '')) is distinct from lower(coalesce(${orders.venue}, ''))`,
  );
  const conflictingScope = db
    .select({ value: sql<number>`1` })
    .from(otherOrders)
    .where(and(
      eq(otherOrders.userId, socialTrades.userId),
      eq(otherOrders.brokerOrderId, socialTrades.brokerOrderId),
      differentScope,
    ));
  const duplicateSameScope = db
    .select({ value: sql<number>`1` })
    .from(otherOrders)
    .where(and(sameScope, ne(otherOrders.id, orders.id)));

  return and(
    eq(socialTrades.userId, orders.userId),
    or(
      and(isNotNull(socialTrades.orderId), eq(socialTrades.orderId, orders.id)),
      and(
        isNull(socialTrades.orderId),
        isNotNull(socialTrades.brokerOrderId),
        eq(socialTrades.brokerOrderId, orders.brokerOrderId),
        notExists(conflictingScope),
        notExists(duplicateSameScope),
      ),
    ),
  )!;
}

/**
 * Public feeds, leaderboards, and copy discovery must never expose an Alpaca
 * paper/SIM order. New writers prevent those rows from entering social_trades;
 * this read-side guard also covers legacy rows and mixed live/paper users.
 *
 * Prefer the immutable credential id. The account-id fallback exists only for
 * legacy orders written before broker_credential_id was populated.
 */
export function publiclyEligibleOrderCondition(
  db: AuthoritativeOrderSelectDb,
  orders: Pick<
    OrderIdentityColumns,
    "userId" | "brokerAccountId" | "brokerCredentialId"
  >,
): SQL {
  const paperCredential = db
    .select({ value: sql<number>`1` })
    .from(schema.userApiCredentials)
    .where(and(
      eq(schema.userApiCredentials.provider, "alpaca"),
      inArray(schema.userApiCredentials.accountType, ["PAPER", "SIM"]),
      or(
        eq(schema.userApiCredentials.id, orders.brokerCredentialId),
        and(
          isNull(orders.brokerCredentialId),
          eq(schema.userApiCredentials.userId, orders.userId),
          isNotNull(orders.brokerAccountId),
          eq(schema.userApiCredentials.accountId, orders.brokerAccountId),
        ),
      ),
    ));

  return notExists(paperCredential);
}

export function validOptionContractCondition(input: {
  assetType: AnyColumn;
  optionExpiration: AnyColumn;
  optionStrike: AnyColumn;
  optionType: AnyColumn;
}): SQL {
  const identity = and(
    sql`${input.optionExpiration} ~ '^[0-9]{6}$'`,
    sql`to_char(to_date(${input.optionExpiration}, 'YYMMDD'), 'YYMMDD') = ${input.optionExpiration}`,
    sql`${input.optionStrike}::text not in ('NaN', 'Infinity', '-Infinity')`,
    gt(input.optionStrike, "0"),
    inArray(input.optionType, ["CALL", "PUT"]),
  );
  return or(ne(input.assetType, "OPTION"), identity)!;
}

export interface AuthoritativeSocialIdentity {
  userId: string;
  orderId: string | null | undefined;
  brokerOrderId: string | null | undefined;
}

export interface AuthoritativeOrderIdentity {
  id: string;
  userId: string;
  brokerOrderId: string | null | undefined;
  brokerAccountId: string | null | undefined;
  brokerCredentialId: string | null | undefined;
  venue: string | null | undefined;
}

function scopeKey(order: AuthoritativeOrderIdentity): string {
  return JSON.stringify([
    order.brokerAccountId ?? null,
    order.brokerCredentialId ?? null,
    (order.venue ?? "").toLowerCase(),
  ]);
}

/** Pure counterpart of buildAuthoritativeOrderJoin for service/query tests. */
export function resolveUniqueAuthoritativeOrder(
  social: AuthoritativeSocialIdentity,
  candidates: readonly AuthoritativeOrderIdentity[],
): AuthoritativeOrderIdentity | null {
  if (social.orderId) {
    return candidates.find(
      (candidate) => candidate.id === social.orderId && candidate.userId === social.userId,
    ) ?? null;
  }
  if (!social.brokerOrderId) return null;

  const matches = candidates.filter(
    (candidate) =>
      candidate.userId === social.userId &&
      candidate.brokerOrderId === social.brokerOrderId,
  );
  if (matches.length !== 1) return null;

  const [match] = matches;
  if (!match) return null;
  return matches.every((candidate) => scopeKey(candidate) === scopeKey(match))
    ? match
    : null;
}
