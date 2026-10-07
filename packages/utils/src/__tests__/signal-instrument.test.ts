/// <reference types="bun" />
import { describe, it, expect } from "bun:test";

import {
  classifySignalInstrument,
  classifySignalText,
  isMirrorableEquitySignal,
  signalSideFromMetadata,
  isPerpVenue,
  isPerpInstrument,
  isShortDirection,
} from "../utils/signal-instrument.js";

describe("isPerpVenue", () => {
  it("treats Hyperliquid (and common perp DEXes) as perp venues, case-insensitively", () => {
    expect(isPerpVenue("hyperliquid")).toBe(true);
    expect(isPerpVenue("Hyperliquid")).toBe(true);
    expect(isPerpVenue("  HYPERLIQUID ")).toBe(true);
    expect(isPerpVenue("dydx")).toBe(true);
    expect(isPerpVenue("gmx")).toBe(true);
  });

  it("does not treat equity/social sources or empty values as perp venues", () => {
    expect(isPerpVenue("x")).toBe(false);
    expect(isPerpVenue("twitter")).toBe(false);
    expect(isPerpVenue("discord")).toBe(false);
    expect(isPerpVenue(null)).toBe(false);
    expect(isPerpVenue(undefined)).toBe(false);
    expect(isPerpVenue("")).toBe(false);
  });
});

describe("isPerpInstrument", () => {
  it("matches perp / perps / perpetual and other derivatives", () => {
    expect(isPerpInstrument("perp")).toBe(true);
    expect(isPerpInstrument("perps")).toBe(true);
    expect(isPerpInstrument("PERP")).toBe(true);
    expect(isPerpInstrument("perpetual")).toBe(true);
    expect(isPerpInstrument("future")).toBe(true);
    expect(isPerpInstrument("swap")).toBe(true);
  });

  it("does not match spot/equity instruments or empty values", () => {
    expect(isPerpInstrument("equity")).toBe(false);
    expect(isPerpInstrument("spot")).toBe(false);
    expect(isPerpInstrument("stock")).toBe(false);
    expect(isPerpInstrument(null)).toBe(false);
    expect(isPerpInstrument(undefined)).toBe(false);
  });
});

describe("isShortDirection", () => {
  it("matches short/sell variants, case-insensitively", () => {
    expect(isShortDirection("short")).toBe(true);
    expect(isShortDirection("Short")).toBe(true);
    expect(isShortDirection("sell")).toBe(true);
    expect(isShortDirection("sell_short")).toBe(true);
  });

  it("does not match long/buy or empty values", () => {
    expect(isShortDirection("long")).toBe(false);
    expect(isShortDirection("buy")).toBe(false);
    expect(isShortDirection(null)).toBe(false);
    expect(isShortDirection(undefined)).toBe(false);
  });
});

describe("classifySignalInstrument / isMirrorableEquitySignal", () => {
  it("classifies a signal with NO instrument metadata as a mirrorable equity long (legacy X/Discord)", () => {
    const c = classifySignalInstrument({ authorName: "Cathie Wood" });
    expect(c).toMatchObject({
      platform: null,
      instrument: null,
      direction: null,
      perpVenue: false,
      perpInstrument: false,
      short: false,
      side: "buy",
      mirrorableEquityLong: true,
    });
    expect(isMirrorableEquitySignal({ authorName: "Cathie Wood" })).toBe(true);
    // Empty / null / undefined metadata are all mirrorable longs (unchanged).
    expect(isMirrorableEquitySignal(null)).toBe(true);
    expect(isMirrorableEquitySignal(undefined)).toBe(true);
    expect(isMirrorableEquitySignal({})).toBe(true);
  });

  it("is NOT mirrorable when the platform is a perp venue (hyperliquid)", () => {
    const meta = { platform: "hyperliquid", instrument: "perp", direction: "long" };
    const c = classifySignalInstrument(meta);
    expect(c.perpVenue).toBe(true);
    expect(c.mirrorableEquityLong).toBe(false);
    expect(isMirrorableEquitySignal(meta)).toBe(false);
  });

  it("is NOT mirrorable when the instrument is a perp, even on an unknown platform", () => {
    const meta = { platform: "somevenue", instrument: "perps", direction: "long" };
    expect(classifySignalInstrument(meta).perpInstrument).toBe(true);
    expect(isMirrorableEquitySignal(meta)).toBe(false);
  });

  it("is NOT mirrorable when the direction is short, even without perp fields", () => {
    const meta = { direction: "short" };
    const c = classifySignalInstrument(meta);
    expect(c.short).toBe(true);
    expect(c.side).toBe("sell");
    expect(c.mirrorableEquityLong).toBe(false);
    expect(isMirrorableEquitySignal(meta)).toBe(false);
  });

  it("the classic paste.trade perp/short combo is not mirrorable and surfaces as a sell", () => {
    const meta = { platform: "hyperliquid", instrument: "perp", direction: "short" };
    const c = classifySignalInstrument(meta);
    expect(c.mirrorableEquityLong).toBe(false);
    expect(c.side).toBe("sell");
    expect(signalSideFromMetadata(meta)).toBe("sell");
  });

  it("parses stringified jsonb metadata the same as an object", () => {
    const meta = JSON.stringify({ platform: "hyperliquid", instrument: "perp", direction: "short" });
    expect(isMirrorableEquitySignal(meta)).toBe(false);
    expect(signalSideFromMetadata(meta)).toBe("sell");
  });

  it("falls back to a mirrorable long on malformed metadata (fails open only for legacy display, not for perp tags)", () => {
    // Malformed metadata yields no fields, so it classifies as a plain long. This is
    // the same defensive parse deriveAuthor uses; a genuine perp row always carries
    // a well-formed platform/instrument/direction.
    expect(isMirrorableEquitySignal("not-json{{")).toBe(true);
    expect(signalSideFromMetadata("not-json{{")).toBe("buy");
  });
});

describe("unrecognizedShape (fail-open visibility flag)", () => {
  it("is set when platform/instrument/direction are present but the wrong type", () => {
    expect(classifySignalInstrument({ platform: 42 }).unrecognizedShape).toBe(true);
    expect(classifySignalInstrument({ instrument: { kind: "perp" } }).unrecognizedShape).toBe(true);
    expect(classifySignalInstrument({ direction: ["short"] }).unrecognizedShape).toBe(true);
    expect(classifySignalInstrument({ platform: "   " }).unrecognizedShape).toBe(true);
  });

  it("does NOT change classification: wrong-typed fields still fail open to a mirrorable long", () => {
    const c = classifySignalInstrument({ platform: 42, instrument: { kind: "perp" } });
    expect(c.unrecognizedShape).toBe(true);
    expect(c.mirrorableEquityLong).toBe(true);
    expect(c.side).toBe("buy");
  });

  it("is unset for absent metadata and for metadata without those fields", () => {
    expect(classifySignalInstrument(null).unrecognizedShape).toBe(false);
    expect(classifySignalInstrument(undefined).unrecognizedShape).toBe(false);
    expect(classifySignalInstrument({}).unrecognizedShape).toBe(false);
    expect(classifySignalInstrument({ authorName: "Cathie Wood" }).unrecognizedShape).toBe(false);
    // Fields explicitly written as null (the paste.trade mapper's `?? null`
    // convention) count as absent, not unrecognized.
    expect(
      classifySignalInstrument({ platform: null, instrument: null, direction: null })
        .unrecognizedShape,
    ).toBe(false);
  });

  it("is unset for the known-good shape (parseable strings)", () => {
    expect(
      classifySignalInstrument({ platform: "hyperliquid", instrument: "perp", direction: "short" })
        .unrecognizedShape,
    ).toBe(false);
    expect(classifySignalInstrument({ direction: "long" }).unrecognizedShape).toBe(false);
  });

  it("is set when only SOME fields are unparseable alongside good ones", () => {
    const c = classifySignalInstrument({ platform: "hyperliquid", instrument: 7 });
    expect(c.unrecognizedShape).toBe(true);
    // The good field still classifies: hyperliquid stays non-mirrorable.
    expect(c.perpVenue).toBe(true);
    expect(c.mirrorableEquityLong).toBe(false);
  });
});

describe("signalSideFromMetadata", () => {
  it("returns 'sell' only for an explicit short/sell direction", () => {
    expect(signalSideFromMetadata({ direction: "short" })).toBe("sell");
    expect(signalSideFromMetadata({ direction: "sell" })).toBe("sell");
    expect(signalSideFromMetadata({ direction: "long" })).toBe("buy");
    expect(signalSideFromMetadata({})).toBe("buy");
    expect(signalSideFromMetadata(null)).toBe("buy");
  });
});

describe("classifySignalText: the free-text veto", () => {
  const blocks = (content: string) =>
    classifySignalText(content).blocksEquityLong;

  it("blocks the exact call that was placing inverted equity BUYs", () => {
    // A followed Discord/X author posting this carried NO platform, instrument
    // or direction metadata, so it classified as a mirrorable equity long and
    // became an Alpaca market BUY of GOOGL: wrong instrument, wrong direction.
    expect(blocks("GOOGL 20x short perp")).toBe(true);
    expect(blocks("$GOOGL 20x Short")).toBe(true);
    expect(blocks("shorting NVDA here")).toBe(true);
    expect(blocks("short $TSLA into earnings")).toBe(true);
  });

  it("blocks a LEVERAGED long, which is a perp call and not an equity buy", () => {
    // Direction is right but instrument is not: mirroring 20x long BTC as an
    // equity buy is still the wrong trade.
    expect(blocks("20x long BTC")).toBe(true);
    expect(blocks("going long 10x on HYPE")).toBe(true);
    expect(blocks("10x leverage on NVDA")).toBe(true);
  });

  it("blocks perps and futures named in prose", () => {
    expect(blocks("grabbing the NVDA perp")).toBe(true);
    expect(blocks("perpetual on SOL looks good")).toBe(true);
    expect(blocks("ES futures long here")).toBe(true);
  });

  it("does NOT block ordinary bullish posts that merely contain the word short", () => {
    // These are the false positives that would silently stop mirroring real
    // long calls. "short squeeze" and "short interest" are bullish context.
    expect(blocks("NVDA short squeeze incoming, loading up")).toBe(false);
    expect(blocks("short interest is 20% of float, buying")).toBe(false);
    expect(blocks("shorts are covering, this rips")).toBe(false);
    expect(blocks("short-term pullback, adding to my long")).toBe(false);
    expect(blocks("short sellers getting destroyed")).toBe(false);
    expect(blocks("short sellers are covering here")).toBe(false);
    expect(blocks("short sellers got squeezed out")).toBe(false);
  });

  it("DOES block exit language that carries no sell token", () => {
    // These have no "sell"/"sold" anywhere, so the sell veto never saw them and
    // the worker opened a fresh long while the author was closing one.
    expect(blocks("closing my TSLA long here")).toBe(true);
    expect(blocks("buy to cover TSLA")).toBe(true);
    expect(blocks("closed my position")).toBe(true);
    expect(blocks("covering my short here")).toBe(true);
    expect(blocks("exiting TSLA")).toBe(true);
    expect(blocks("taking profits on TSLA")).toBe(true);
    expect(blocks("trimming TSLA here")).toBe(true);
    // The IMPERATIVE root, which is how these are usually written. Matching
    // every inflected form and missing the common one let an explicit
    // instruction to reduce mirror as a BUY.
    expect(blocks("trim TSLA here")).toBe(true);
    expect(blocks("trim $TSLA here")).toBe(true);
    expect(blocks("TRIM NVDA")).toBe(true);
    // Stop-outs: the author is FLAT, so mirroring this as a fresh long buys
    // what they just had taken off them.
    expect(blocks("stopped out of TSLA")).toBe(true);
    expect(blocks("I got stopped out of $TSLA")).toBe(true);
    expect(blocks("stop loss hit on TSLA")).toBe(true);
    expect(blocks("stop-loss triggered")).toBe(true);
    expect(blocks("hit my stop on NVDA")).toBe(true);
  });

  it("does NOT block a long call that merely names its stop", () => {
    // The trigger word is what makes it an exit. Naming risk is not exiting.
    expect(blocks("setting a stop loss at 300, long here")).toBe(false);
    expect(blocks("stop loss at 290, buying")).toBe(false);
    expect(blocks("my stop is 300, adding")).toBe(false);
  });

  it("DOES block a close that names the ticker or the author instead of a position", () => {
    // The close forms above require a position noun, which these do not have.
    // A ticker after the verb, or a first-person pronoun before it, is what
    // makes them exits rather than commentary.
    expect(blocks("I closed TSLA")).toBe(true);
    expect(blocks("closing TSLA here")).toBe(true);
    expect(blocks("Closing TSLA here")).toBe(true);
    expect(blocks("I'm closing TSLA")).toBe(true);
    expect(blocks("we closed NVDA")).toBe(true);
    // The PLURAL PRESENT, which the copula list was missing: it carried every
    // form except the one "we" actually takes. These name no ticker and no
    // position noun, relying on the signal's own symbol field, so nothing else
    // would have vetoed them.
    expect(blocks("we're closing here")).toBe(true);
    expect(blocks("we are closing here")).toBe(true);
    expect(blocks("we're covering here")).toBe(true);
    // "close out" carries the exit on the PARTICLE, so it needs neither a
    // position noun nor a ticker. These name neither, relying on the signal's
    // own symbol field.
    expect(blocks("closed out here")).toBe(true);
    expect(blocks("closing out here")).toBe(true);
    expect(blocks("close out")).toBe(true);
    // Being OUT is the exit, and none of the verb patterns covers it: there is
    // no closing, covering, selling or exiting word in any of these.
    expect(blocks("I'm out of TSLA")).toBe(true);
    expect(blocks("we are all out of $TSLA")).toBe(true);
    expect(blocks("I am out")).toBe(true);
    expect(blocks("we're out here")).toBe(true);
    expect(blocks("closing out TSLA")).toBe(true);
    // Shouted exits count too. Excluding the all-caps verb had the trade
    // backwards: it let a shouted exit mirror as a BUY to avoid vetoing a
    // shouted "CLOSING STRONG", which is only a missed mirror.
    expect(blocks("CLOSING TSLA")).toBe(true);
    expect(blocks("CLOSED TSLA HERE")).toBe(true);
    expect(blocks("CLOSING OUT TSLA")).toBe(true);
    // Covering IS exiting a short, so it must not read as an instruction to buy.
    // The cover forms in the list above require a "short" or "position" after
    // them, which these do not have.
    expect(blocks("covering TSLA")).toBe(true);
    expect(blocks("covered TSLA")).toBe(true);
    expect(blocks("I covered TSLA")).toBe(true);
    expect(blocks("COVERING TSLA")).toBe(true);
    // Cashtags: how a large share of X and Discord posts name a ticker.
    expect(blocks("closing $TSLA here")).toBe(true);
    expect(blocks("covering $TSLA")).toBe(true);
    expect(blocks("CLOSING $TSLA")).toBe(true);
    expect(blocks("closing out $TSLA")).toBe(true);
    // One letter is fine WITH the $: "$F" can only be Ford.
    expect(blocks("closing $F here")).toBe(true);
    expect(blocks("covering $T")).toBe(true);
    // Lowercase cashtags, which are ordinary in fast-typed posts. Casing is not
    // what makes these tickers, the "$" is, so the cashtag branch does not
    // require capitals the way the bare token does.
    expect(blocks("closing $tsla here")).toBe(true);
    expect(blocks("covering $f")).toBe(true);
    expect(blocks("closed $Nvda")).toBe(true);
    // "exit" gets the ticker treatment too. The list above requires a position
    // noun after it, which these do not have.
    expect(blocks("exit TSLA here")).toBe(true);
    expect(blocks("exit $tsla")).toBe(true);
    expect(blocks("EXIT NVDA")).toBe(true);
  });

  it("does NOT block bullish prose that merely uses close or cover", () => {
    // "close" is common in ordinary market commentary, so each exit form
    // requires something that makes it an exit rather than a description.
    // Vetoing these would cost a large share of good long calls.
    expect(blocks("TSLA closed above resistance, buying")).toBe(false);
    expect(blocks("close to a breakout, adding here")).toBe(false);
    expect(blocks("NVDA closing strong today, buying")).toBe(false);
    // Still safe: the token after the verb is lowercase, so the ticker check
    // does not fire and this stays an options strategy rather than an exit.
    expect(blocks("covered call on TSLA")).toBe(false);
    expect(blocks("coverage of NVDA is bullish")).toBe(false);
    // A bare single letter stays ambiguous and must not veto: only the cashtag
    // form may be one letter. ("closing A position soon" is NOT a
    // counter-example, it genuinely is an exit and matches the position-noun
    // rule above.)
    expect(blocks("TSLA closed A shade higher, adding")).toBe(false);
    expect(blocks("my exit is 300, long here")).toBe(false);
    // The BARE ticker check is case-sensitive precisely to leave these alone.
    // Only the cashtag branch is case-insensitive, and none of these has a "$".
    expect(blocks("closed green today, still long")).toBe(false);
    expect(blocks("closing tsla was a mistake, still bullish")).toBe(false);
    // "exit liquidity" is why bare "exit" needs a ticker or a position noun.
    // The shouted form is safe on the word boundary: the bare-token branch
    // needs one within five capitals, and LIQUIDITY has nine letters.
    expect(blocks("exit liquidity is thin, buying")).toBe(false);
    expect(blocks("EXIT LIQUIDITY EVERYWHERE, still adding")).toBe(false);
    // The calendar sense of "close out" is commentary, not an exit, and is
    // common enough in bullish prose to be worth keeping.
    expect(blocks("closed out the week green, still long")).toBe(false);
    expect(blocks("closing out the month strong, adding")).toBe(false);
    expect(blocks("closed out Q3 at highs, buying more")).toBe(false);
    // "out of the money" names where an option is struck, not a position
    // anyone left. The pronoun requirement leaves ordinary prose alone too.
    expect(blocks("I'm out of the money on these, rolling up")).toBe(false);
    expect(blocks("TSLA ran out of sellers, buying")).toBe(false);
  });

  it("DOES block a SINGULAR future contract named in prose", () => {
    // instrument: "future" was refused while the common contract form in free
    // text mirrored as a plain equity BUY for the underlying.
    expect(blocks("GOOGL future long")).toBe(true);
    expect(blocks("long GOOGL future")).toBe(true);
  });

  it("does NOT block ordinary prose that uses the word future", () => {
    // The exclusions here ADD nothing dangerous when they miss: an unexcluded
    // prose sense costs a missed mirror, not an inverted order, which is the
    // opposite of the short and sell idiom lists.
    expect(blocks("the future of AI is bright, buying NVDA")).toBe(false);
    expect(blocks("in the future I'll add more")).toBe(false);
    expect(blocks("future looks bright for TSLA")).toBe(false);
    expect(blocks("over the near future this rips")).toBe(false);
  });

  it("DOES block a SWAP named in prose, like the metadata half already did", () => {
    // instrument: "swap" was refused while the same signal in free text mirrored
    // as a plain equity BUY: wrong instrument, real money.
    expect(blocks("GOOGL swap long")).toBe(true);
    expect(blocks("opening a swap on TSLA")).toBe(true);
    expect(blocks("BTC swaps here")).toBe(true);
  });

  it("does NOT block rotation language that merely contains swap", () => {
    // "swapping into NVDA" is moving between positions, not a derivative, and
    // the check is word-bounded so the verb form never reaches it.
    expect(blocks("swapping into NVDA here")).toBe(false);
  });

  it("DOES block an unstructured SELL instruction", () => {
    // With no structured direction metadata these classified as mirrorable
    // equity longs, so the worker submitted an Alpaca BUY: the opposite of what
    // the author did, on a real account.
    expect(blocks("sell TSLA here")).toBe(true);
    expect(blocks("selling TSLA")).toBe(true);
    expect(blocks("sold TSLA")).toBe(true);
    expect(blocks("sells half here")).toBe(true);
  });

  it("does NOT block bullish posts that merely mention a sell-off", () => {
    // "the sell-off is over, buying" is a long call. Words that only CONTAIN
    // sell or sold are word-bounded away and never reach the check.
    expect(blocks("the sell-off is over, buying")).toBe(false);
    expect(blocks("sellers exhausted here")).toBe(false);
    expect(blocks("NVDA is oversold, loading up")).toBe(false);
    expect(blocks("sell side is capitulating")).toBe(false);
  });

  it("DOES block imperative and first-person exits phrased as sell off", () => {
    // The reason the space-separated forms are not excluded: they are equally
    // an author's own action, and stripping them left an inverted BUY behind.
    expect(blocks("sell off TSLA now")).toBe(true);
    expect(blocks("sold off my TSLA here")).toBe(true);
  });

  it("accepts the cost: descriptive posts phrased that way now veto", () => {
    // A missed mirror, which is the direction this module is built to be wrong
    // in, and a better trade than a qualifier that has to be right about English
    // word order. Pinned so the cost is visible rather than discovered.
    expect(blocks("TSLA sold off hard, buying the dip")).toBe(true);
    expect(blocks("sell off looks done, adding")).toBe(true);
  });

  it("DOES block an author covering their own short", () => {
    // "short cover" was stripped as bullish commentary, which deleted the only
    // position marker: "TSLA short cover here" became "TSLA here", nothing
    // vetoed, and the worker could open an Alpaca BUY on a signal whose author
    // is CLOSING a short rather than opening a long.
    expect(blocks("TSLA short cover here")).toBe(true);
    expect(blocks("TSLA short covering")).toBe(true);
    expect(blocks("short cover on NVDA, done with this one")).toBe(true);
    // Singular "short seller" plus a covering verb is the same author exit.
    expect(blocks("TSLA short seller covering here")).toBe(true);
    expect(blocks("short seller on TSLA covering now")).toBe(true);
  });

  it("still ignores THIRD-PARTY shorts as the losing party", () => {
    // The plural is the distinction: "shorts" are other people, and them
    // covering or being squeezed is ordinary bullish commentary.
    expect(blocks("shorts are covering, this rips")).toBe(false);
    expect(blocks("shorts getting squeezed hard")).toBe(false);
    expect(blocks("shorts trapped here")).toBe(false);
  });

  it("DOES block an author describing themselves as a short seller", () => {
    // The phrase was stripped unconditionally, which deleted the only short
    // marker in prose like this. With no structured direction metadata the
    // signal then read as a plain equity long, and an auto-mirroring follower
    // received an Alpaca BUY opposite the source's position.
    expect(blocks("short seller on TSLA; adding here")).toBe(true);
    expect(blocks("as a short seller I am adding to TSLA")).toBe(true);
    expect(blocks("short sellers like me are adding")).toBe(true);
  });

  it("does NOT block a bare multiple or a leveraged ETF", () => {
    // "10x" as a return multiple is ordinary bullish talk, and a leveraged ETF
    // is a plain equity that mirrors correctly. Only a multiple stated beside a
    // direction or the word leverage counts.
    expect(blocks("NVDA is a 10x from here")).toBe(false);
    expect(blocks("this could 5x")).toBe(false);
    expect(blocks("buying TQQQ, my favorite leveraged ETF")).toBe(false);
  });

  it("does NOT block a plain long call, and treats empty text as no signal", () => {
    expect(blocks("NVDA reclaiming highs into earnings, adding")).toBe(false);
    expect(blocks("")).toBe(false);
    expect(classifySignalText(null).blocksEquityLong).toBe(false);
    expect(classifySignalText(undefined).matches).toEqual([]);
  });

  it("reports which checks fired, for the skip log", () => {
    expect(classifySignalText("GOOGL 20x short perp").matches.sort()).toEqual([
      "derivative",
      "leverage",
      "short",
    ]);
    expect(classifySignalText("short NVDA").matches).toEqual(["short"]);
  });
});

describe("classifySignalInstrument: prose vetoes the equity mirror", () => {
  it("keeps metadata-only callers behaving exactly as before", () => {
    // The feed, chart matching and leaderboard pass no content. Passing prose
    // that WOULD block must not change their verdict when they do not pass it.
    expect(classifySignalInstrument(null).mirrorableEquityLong).toBe(true);
    expect(classifySignalInstrument({}).mirrorableEquityLong).toBe(true);
    expect(classifySignalInstrument(null).text.blocksEquityLong).toBe(false);
  });

  it("blocks the mirror once the caller passes the prose", () => {
    expect(
      classifySignalInstrument(null, "GOOGL 20x short perp").mirrorableEquityLong,
    ).toBe(false);
    expect(
      classifySignalInstrument({}, "shorting NVDA").mirrorableEquityLong,
    ).toBe(false);
  });

  it("still mirrors a plain long when prose is passed", () => {
    expect(
      classifySignalInstrument(null, "NVDA breaking out, adding here")
        .mirrorableEquityLong,
    ).toBe(true);
  });

  it("does not invent a direction from prose", () => {
    // side stays metadata-derived on purpose: withholding a trade on an
    // uncertain read is safe, but labeling a post "sell" in the feed on the
    // same uncertain read is a new false claim.
    const fromText = classifySignalInstrument(null, "shorting NVDA");
    expect(fromText.side).toBe("buy");
    expect(fromText.mirrorableEquityLong).toBe(false);
    expect(fromText.direction).toBeNull();
  });

  it("keeps honoring metadata when it disagrees with benign prose", () => {
    const perpRow = classifySignalInstrument(
      { platform: "hyperliquid", instrument: "perp", direction: "short" },
      "great setup here",
    );
    expect(perpRow.mirrorableEquityLong).toBe(false);
    expect(perpRow.side).toBe("sell");
  });
});

describe("classifySignalInstrument: perp-only fields are a perp tell", () => {
  it("blocks the equity mirror when only leverage survived upstream", () => {
    // The failure this closes: paste.trade drops platform/instrument but keeps
    // direction and leverage, and every perp call classifies as a mirrorable
    // equity LONG with no warning at all.
    const c = classifySignalInstrument({ direction: "long", leverage: 20 });
    expect(c.perpHint).toBe(true);
    expect(c.perpHints).toEqual(["leverage"]);
    expect(c.mirrorableEquityLong).toBe(false);
  });

  it("blocks the equity mirror when only a canonical HL coin survived", () => {
    const c = classifySignalInstrument({ hlTicker: "kPEPE" });
    expect(c.perpHint).toBe(true);
    expect(c.perpHints).toEqual(["hlTicker"]);
    expect(c.mirrorableEquityLong).toBe(false);
  });

  it("reports both fields when both are present", () => {
    expect(
      classifySignalInstrument({ leverage: 3, hlTicker: "BTC" }).perpHints,
    ).toEqual(["leverage", "hlTicker"]);
  });

  it("treats upstream's 'no leverage' encodings as not stated", () => {
    // These are how a plain equity row from the same poller looks. Reading them
    // as perps would silently stop mirroring legitimate equity calls.
    for (const meta of [
      { leverage: null, hlTicker: null },
      { leverage: undefined },
      { leverage: 0 },
      { leverage: -1 },
      { hlTicker: "" },
      { hlTicker: "   " },
      {},
    ]) {
      const c = classifySignalInstrument(meta);
      expect(c.perpHint).toBe(false);
      expect(c.mirrorableEquityLong).toBe(true);
    }
  });

  it("treats a perp-only field in an unreadable shape as a perp, not as noise", () => {
    // Fail closed: an unrecognized value on a perps-only field is a reason to
    // withhold an equity BUY, not to assume the field means nothing.
    expect(classifySignalInstrument({ leverage: { x: 1 } }).perpHint).toBe(true);
    expect(classifySignalInstrument({ hlTicker: ["BTC"] }).mirrorableEquityLong).toBe(false);
  });

  it("leaves the venue/instrument pair alone so display callers are unchanged", () => {
    // The feed badge, chart matching and the leaderboard asset class all key on
    // perpVenue || perpInstrument. A leverage-only row must not start rendering
    // as a Hyperliquid perp call just because the mirror refuses it.
    const c = classifySignalInstrument({ leverage: 20, hlTicker: "BTC" });
    expect(c.perpVenue).toBe(false);
    expect(c.perpInstrument).toBe(false);
    expect(c.side).toBe("buy");
    expect(c.platform).toBeNull();
    expect(c.instrument).toBeNull();
  });
});
