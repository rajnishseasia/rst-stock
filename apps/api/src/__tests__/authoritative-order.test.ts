import { describe, expect, it } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  resolveUniqueAuthoritativeOrder,
  buildAuthoritativeOrderJoin,
  publiclyEligibleOrderCondition,
} from "../lib/authoritative-order.js";

type Candidate = {
  id: string;
  userId: string;
  brokerOrderId: string | null;
  brokerAccountId: string | null;
  brokerCredentialId: string | null;
  venue: string | null;
};

const social = {
  userId: "user-1",
  orderId: null,
  brokerOrderId: "broker-1",
};

const order = (overrides: Partial<Candidate> = {}): Candidate => ({
  id: "order-1",
  userId: "user-1",
  brokerOrderId: "broker-1",
  brokerAccountId: "account-1",
  brokerCredentialId: "credential-1",
  venue: "alpaca",
  ...overrides,
});

describe("authoritative social order resolution", () => {
  it("uses an exact order_id even when a broker id is reused elsewhere", () => {
    const resolved = resolveUniqueAuthoritativeOrder(
      { ...social, orderId: "order-2" },
      [
        order(),
        order({ id: "order-2", brokerAccountId: "account-2" }),
      ],
    );

    expect(resolved?.id).toBe("order-2");
  });

  it("accepts one legacy broker match in one complete account scope", () => {
    expect(resolveUniqueAuthoritativeOrder(social, [order()])?.id).toBe("order-1");
  });

  it("rejects legacy rows with duplicate same-scope matches", () => {
    expect(
      resolveUniqueAuthoritativeOrder(social, [
        order(),
        order({ id: "order-2" }),
      ]),
    ).toBeNull();
  });

  it("rejects legacy rows with matches across account, credential, or venue scope", () => {
    expect(
      resolveUniqueAuthoritativeOrder(social, [
        order(),
        order({ id: "order-2", brokerAccountId: "account-2" }),
      ]),
    ).toBeNull();
  });

  it("rejects an orphan social row instead of returning a lossy fallback", () => {
    expect(resolveUniqueAuthoritativeOrder(social, [])).toBeNull();
  });
});

describe("authoritative order join query", () => {
  it("compiles exact and unique scoped legacy branches", () => {
    const db = {
      select: (selection: unknown) => ({
        ...selection,
        from: (_table: unknown) => ({
          where: (condition: unknown) => sql`${condition}`,
        }),
      }),
    } as never;
    const socialAlias = {
      userId: sql`social.user_id`,
      orderId: sql`social.order_id`,
      brokerOrderId: sql`social.broker_order_id`,
    } as never;
    const orderAlias = {
      id: sql`orders.id`,
      userId: sql`orders.user_id`,
      brokerOrderId: sql`orders.broker_order_id`,
      brokerAccountId: sql`orders.broker_account_id`,
      brokerCredentialId: sql`orders.broker_credential_id`,
      venue: sql`orders.venue`,
    } as never;
    const otherOrderAlias = orderAlias;

    const join = buildAuthoritativeOrderJoin(
      db,
      socialAlias,
      orderAlias,
      otherOrderAlias,
    );
    const compiled = new PgDialect().sqlToQuery(join);

    expect(compiled.sql).toContain("not exists");
    expect(compiled.sql).toContain("is distinct from");
    expect(compiled.sql).toContain("is not distinct from");
    expect(compiled.sql).toContain("order_id");
  });

  it("rejects paper/SIM Alpaca credentials by immutable id with a legacy account fallback", () => {
    const db = {
      select: (selection: unknown) => ({
        ...selection,
        from: () => ({
          where: (condition: unknown) => sql`${condition}`,
        }),
      }),
    } as never;
    const orderAlias = {
      userId: sql`orders.user_id`,
      brokerAccountId: sql`orders.broker_account_id`,
      brokerCredentialId: sql`orders.broker_credential_id`,
    } as never;

    const condition = publiclyEligibleOrderCondition(db, orderAlias);
    const compiled = new PgDialect().sqlToQuery(condition);

    expect(compiled.sql).toContain("not exists");
    expect(compiled.sql).toContain("account_type");
    expect(compiled.sql).toContain("broker_credential_id");
    expect(compiled.sql).toContain("broker_account_id");
    expect(compiled.params).toEqual(expect.arrayContaining(["alpaca", "PAPER", "SIM"]));
  });
});
