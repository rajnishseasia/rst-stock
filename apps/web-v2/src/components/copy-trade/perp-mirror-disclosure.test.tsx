import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  PerpMirrorDisclosure,
  perpMirrorDisclosures,
  PERP_MIRROR_DISCLOSURES,
} from "./perp-mirror-disclosure";

const markup = () => renderToStaticMarkup(<PerpMirrorDisclosure />);

describe("Hyperliquid perp mirror disclosure", () => {
  test("states that the destination is a leveraged exchange order, not an Alpaca order", () => {
    const html = markup();
    expect(html).toContain("Hyperliquid");
    expect(html).toContain("leveraged");
    expect(html).toContain("mainnet");
  });

  test("states the user's ceilings and the live market maximum", () => {
    const html = markup();
    expect(html).toContain("global automatic-perps maximum");
    expect(html).toContain("optional lower maximum saved for this follow");
    expect(html).toContain("live market maximum");
    expect(html).toContain("inherits your global maximum");
    expect(html).toContain("never raised");
    expect(html).not.toContain("operator");
  });

  test("states that no exit is attached", () => {
    // BLOCKER 2: mirrored perps have NO stop, bracket or take-profit. This test
    // exists so nobody later softens the copy into implying one.
    const html = markup();
    expect(html).toContain("No stop-loss");
    expect(html).toContain("no automatic exit");
  });

  test("never claims a mirrored perp is protected or managed", () => {
    const html = markup().toLowerCase();
    for (const forbidden of [
      "stop loss is attached",
      "automatically exits",
      "protected position",
      "risk-managed",
    ]) {
      expect(html).not.toContain(forbidden);
    }
  });

  test("states that liquidation is possible and that account settings change", () => {
    const html = markup();
    expect(html).toContain("liquidate");
    expect(html).toContain("margin mode");
    expect(html).toContain("cross or isolated");
  });

  test("carries no em dash anywhere in the follower-facing copy", () => {
    for (const item of PERP_MIRROR_DISCLOSURES) {
      expect(item.title).not.toContain("—");
      expect(item.body).not.toContain("—");
    }
  });

  test("states the follower's own exit once they have configured one", () => {
    // The bullet above is true only while no exit is set. Leaving it in place
    // for a follower who did set one would push them to place a duplicate stop
    // by hand, and would misdescribe what the worker does.
    const html = renderToStaticMarkup(
      <PerpMirrorDisclosure protection={{ takeProfitPct: 50, stopLossPct: 25 }} />,
    );
    expect(html).toContain("-25%");
    expect(html).toContain("+50%");
    expect(html).toContain("margin");
    // The two things the follower most needs to know about it, both true of
    // apps/worker/src/services/copy-mirror-perp-protection.ts as it stands.
    expect(html).toContain("cancelled if the trader you follow closes first");
    expect(html).toContain("left open with no exit rather than closed for you");
    expect(html).not.toContain("No stop-loss");
  });

  test("keeps saying no exit is attached for a follow that has none, which is every follow by default", () => {
    for (const protection of [null, undefined, { takeProfitPct: null, stopLossPct: null }]) {
      const html = renderToStaticMarkup(<PerpMirrorDisclosure protection={protection} />);
      expect(html).toContain("No stop-loss");
      expect(html).toContain("no automatic exit");
    }
  });

  test("carries no em dash in the configured-exit wording either", () => {
    for (const item of perpMirrorDisclosures({ takeProfitPct: 50, stopLossPct: 25 })) {
      expect(item.title).not.toContain("—");
      expect(item.body).not.toContain("—");
    }
  });

  test("renders one bullet per disclosure and is announced as a note", () => {
    const html = markup();
    expect(html.split("<li").length - 1).toBe(PERP_MIRROR_DISCLOSURES.length);
    expect(html).toContain('role="note"');
  });
});
