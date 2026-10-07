/**
 * Signal instrument classification (PURE, side-effect-free).
 *
 * The shared `signals` table is fed by several pollers. Most rows (X / Discord)
 * carry only author metadata and represent a plain equity LONG idea, which the
 * copy-trade auto-mirror worker turns into an Alpaca market BUY and the copy-trade
 * feed surfaces as a "buy". Newer pollers (e.g. paste.trade) also write PERPS-venue
 * rows tagged with venue / instrument / direction metadata, for example:
 *
 *   { platform: "hyperliquid", instrument: "perp", direction: "short" }
 *
 * Mirroring a "GOOGL short 20x perp" call as a GOOGL equity BUY on a follower's
 * account (or surfacing it in the feed as a plain equity buy) is a real-money
 * correctness bug. These helpers let the worker and the api honor the stored
 * platform / instrument / direction and treat such rows as NOT mirrorable as a
 * plain equity long.
 *
 * METADATA IS NOT ENOUGH. Only the paste.trade poller writes those fields; the
 * Discord poller stores author fields alone, so a followed author posting
 * "GOOGL 20x short perp" as free text arrived with no platform, no instrument
 * and no direction, classified as a mirrorable equity long, and was mirrored
 * as an Alpaca market BUY of GOOGL. Wrong instrument, inverted direction, real
 * money, and no perps flag gated it. `classifySignalText` closes that hole by
 * reading the prose as a VETO on equity mirroring.
 *
 * Signals that carry none of these fields AND whose prose reads as a plain long
 * classify exactly as before: a mirrorable equity long with a "buy" side.
 */

export type SignalDirectionSide = "buy" | "sell";

/**
 * Perpetual / derivatives venues whose signals must never be mirrored as a plain
 * equity long. "hyperliquid" is the venue behind the paste.trade perps poller; the
 * rest are common perp DEXes included so a future poller cannot silently reintroduce
 * the bug. Matched case-insensitively.
 */
const PERP_VENUES = new Set<string>([
  "hyperliquid",
  "hl",
  "dydx",
  "gmx",
  "drift",
  "aevo",
  "vertex",
  "apex",
  "paradex",
]);

/**
 * Instrument kinds that are NOT plain spot/equity (perps and other derivatives).
 * Any instrument beginning with "perp" also counts (perp / perps / perpetual...).
 */
const DERIVATIVE_INSTRUMENTS = new Set<string>([
  "perp",
  "perps",
  "perpetual",
  "perpetuals",
  "future",
  "futures",
  "swap",
]);

/** Direction strings that indicate a SHORT (i.e. not a long / buy). */
const SHORT_DIRECTIONS = new Set<string>(["short", "sell", "sell_short", "sellshort"]);

/**
 * Metadata fields that only a PERP call ever carries, whatever the row says
 * about platform / instrument.
 *
 * `leverage` is a multiple on a leveraged position and `hlTicker` is the
 * canonical Hyperliquid coin for the market to trade. Neither has any meaning
 * for a plain equity long. Upstream (paste.trade) normally sends them together
 * with platform "hyperliquid" and instrument "perp", but the two descriptive
 * fields are the ones most likely to be dropped or renamed by an upstream
 * change, and when they were, a "20x short" row still carrying its leverage
 * classified as a mirrorable equity LONG and was mirrored as a market BUY.
 * Treating either field as a perp tell removes that silent path.
 */
const PERP_HINT_FIELDS = ["leverage", "hlTicker"] as const;

/** Parse (possibly stringified) jsonb metadata into a plain record, or null. */
function toRecord(metadata: unknown): Record<string, unknown> | null {
  if (!metadata) return null;
  try {
    const parsed = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Read a string field, trimmed + lowercased, or null when absent/non-string/empty. */
function readField(meta: Record<string, unknown> | null, key: string): string | null {
  const raw = meta?.[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * True when the field is PRESENT on the metadata (non-null / non-undefined)
 * but readField cannot parse it (non-string, or whitespace-only string).
 * Such a field fails open: it contributes nothing to classification, so the
 * signal is treated as a mirrorable plain equity long. Callers use this flag
 * to log the fail-open path; it never changes classification itself.
 */
function isFieldPresentButUnparseable(
  meta: Record<string, unknown> | null,
  key: string,
): boolean {
  if (!meta || !(key in meta)) return false;
  const raw = meta[key];
  if (raw === null || raw === undefined) return false;
  return readField(meta, key) === null;
}

/**
 * True when a perp-only metadata field carries a MEANINGFUL value.
 *
 * Presence is judged per type so upstream's "no leverage" encodings do not read
 * as a perp: null / undefined / an absent key / an empty-ish string / a
 * non-positive number are all "not stated". A value present in a shape this
 * module does not understand (object, array, boolean) DOES count, because on a
 * money path an unrecognized value is a reason to withhold the equity mirror,
 * not to assume the field means nothing.
 */
function isPerpHintPresent(
  meta: Record<string, unknown> | null,
  key: string,
): boolean {
  if (!meta || !(key in meta)) return false;
  const raw = meta[key];
  if (raw === null || raw === undefined) return false;
  if (typeof raw === "string") return raw.trim().length > 0;
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0;
  return true;
}

/** True when `platform` names a known perp / derivatives venue (e.g. Hyperliquid). */
export function isPerpVenue(platform: string | null | undefined): boolean {
  if (!platform) return false;
  return PERP_VENUES.has(platform.trim().toLowerCase());
}

/** True when `instrument` is a perp / derivative (perp, perps, future, swap, ...). */
export function isPerpInstrument(instrument: string | null | undefined): boolean {
  if (!instrument) return false;
  const value = instrument.trim().toLowerCase();
  return DERIVATIVE_INSTRUMENTS.has(value) || value.startsWith("perp");
}

/** True when `direction` indicates a SHORT / sell rather than a long / buy. */
export function isShortDirection(direction: string | null | undefined): boolean {
  if (!direction) return false;
  return SHORT_DIRECTIONS.has(direction.trim().toLowerCase());
}

/**
 * Phrases where "short" is market commentary, not a position the author took.
 * "short squeeze" and "short interest" are usually BULLISH context, so treating
 * them as a short would silently stop mirroring legitimate long calls. Stripped
 * before the position check rather than special-cased inside it.
 */
const NEUTRAL_SHORT_IDIOMS: readonly RegExp[] = [
  /\bshort[\s-]*squeez\w*/gi,
  /\bshort[\s-]*interest\b/gi,
  /\bshort[\s-]*term\b/gi,
  /\bshort[\s-]*float\b/gi,
  /\bshort[\s-]*ratio\b/gi,
  // "short sellers" ONLY where they are the losing party. Blanket-stripping the
  // phrase deleted the single short marker in prose like "short seller on TSLA,
  // adding here": with no structured direction metadata the signal then read as
  // a plain equity long, and an auto-mirroring follower got an Alpaca BUY
  // opposite the source's position. That is the one outcome this module exists
  // to prevent, so the phrase now has to be doing bullish work to be ignored.
  // PLURAL here too, for the reason the "shorts" pattern below spells out. With
  // the singular allowed, "TSLA short seller covering here" had its only short
  // marker stripped and mirrored as a fresh equity long while its author was
  // closing a short.
  /\bshort[\s-]*sellers\b(?:\s+\w+){0,3}?\s+(cover\w*|trapp\w*|squeez\w*|crush\w*|destroy\w*|rekt|liquidat\w*|capitulat\w*|los\w*|wrong)/gi,
  // "shorts" as the losing party rather than a position the author took:
  // "shorts are covering", "shorts getting squeezed", "shorts trapped". All
  // bullish, and common enough on trading social that missing them would
  // block a meaningful share of genuine long calls. Up to two filler words
  // so the auxiliary verbs ("are", "are getting") are covered.
  //
  // PLURAL ONLY, and that is the whole distinction. The singular is how an
  // author describes their OWN exit ("TSLA short cover here", "short covering"),
  // where the phrase is the single position marker in the text: stripping it
  // leaves "TSLA here", nothing vetoes, and the worker opens an Alpaca BUY on a
  // signal whose author is closing a short. A standalone
  // /\bshort[\s-]*cover\w*/ entry used to do the same thing and has been
  // removed with it.
  //
  // The cost is that third-party commentary phrased in the singular ("short
  // covering is driving this") now vetoes and is not mirrored. That is a missed
  // mirror, which this module treats as the acceptable direction to be wrong in.
  /\bshorts\b(?:\s+\w+){0,2}?\s+(cover\w*|trapp\w*|squeez\w*|crush\w*|destroy\w*|rekt|liquidat\w*|capitulat\w*)/gi,
];

/** A short taken as a position: "short GOOGL", "shorting here", "20x short". */
const SHORT_POSITION_RE = /\bshort(s|ed|ing)?\b/i;

/**
 * Phrases where "sell" is market commentary, not an instruction to exit.
 *
 * DELIBERATELY NARROW: only forms that cannot also be an author's own action.
 * "the sell-off is over, buying" is commentary; "sell off TSLA now" and "sold
 * off my TSLA here" are exits, and an earlier version of this list stripped the
 * marker out of both. That is the third time a broad idiom here erased
 * author-action language and left an inverted BUY behind (see the short-seller
 * and short-cover entries above), so the space-separated "sell off" and "sold
 * off" forms are not excluded at all rather than being qualified further.
 *
 * The cost is that descriptive posts phrased that way ("TSLA sold off hard,
 * buying the dip") now veto and are not mirrored. That is a missed mirror, which
 * is the direction this module is built to be wrong in, and it is a better trade
 * than another qualifier that has to be right about English word order.
 *
 * Words that merely CONTAIN sell or sold ("sellers", "selloff", "oversold")
 * never reach the check anyway, because it is word-bounded.
 */
const NEUTRAL_SELL_IDIOMS: readonly RegExp[] = [
  // Hyphenated only: "sell-off" is the noun, "sell off" can be the imperative.
  /\bsell-off\w*/gi,
  /\bsell[\s-]+side\b/gi,
];

/**
 * An exit stated WITHOUT a sell token: "closing my TSLA long", "buy to cover".
 *
 * Same direction of failure as the derivative list, so the same reasoning
 * applies: this ADDS a veto, and a phrasing it misses only costs a missed
 * mirror. But "close" is genuinely common in bullish prose ("closed above
 * resistance", "close to a breakout"), so a bare verb list would veto a large
 * share of good long calls, which is a real product cost even though it is not a
 * money one.
 *
 * Each form therefore requires something that makes it an exit rather than
 * commentary: a position noun after the verb, the fixed phrase "buy to cover",
 * or a verb that has no ordinary market sense ("exiting", "trimming", "taking
 * profits"). "covered call" is deliberately not matched, since it names an
 * options strategy rather than an exit.
 */
/**
 * "closing TSLA" or "covering TSLA", where the TICKER rather than a position
 * noun makes it an exit.
 *
 * COVER and EXIT verbs are here as well as in the list above, because that list
 * requires a "short" or "position" after them and "covering TSLA" has neither.
 * Covering IS exiting a short, so it must not read as an instruction to buy.
 * "covered call" stays safe: the token after the verb is lowercase, so the
 * ticker check does not fire.
 *
 * The ticker is doing the same work for "exit" that a position noun does above.
 * "exit liquidity" is common enough in prose that a bare verb list cannot take
 * it, but "exit TSLA here" has no reading other than the author leaving. Prose
 * that follows the verb with a long word is unaffected: the bare-token branch
 * needs a word boundary within five capitals, so "EXIT LIQUIDITY" does not
 * match.
 *
 * Case-SENSITIVE on the BARE ticker, and the only pattern here that is: an
 * all-caps token after the verb is what separates "closing TSLA here" from
 * "closing strong today". Matching that case-insensitively would take the
 * second, which is ordinary bullish commentary.
 *
 * The cashtag form is accepted too: "$TSLA" is how a large share of X and
 * Discord posts name a ticker, and requiring a bare uppercase token meant
 * "closing $TSLA here" matched nothing at all.
 *
 * The cashtag is case-INSENSITIVE, unlike the bare token. Casing is not what
 * makes it a ticker there, the "$" is, and lowercase cashtags are ordinary in
 * fast-typed posts ("closing $tsla here", "covering $f"). There is no prose
 * reading of "$tsla" to protect, which is the entire reason the bare form needs
 * its capitals.
 *
 * A cashtag may be ONE letter ("$F", "$T"), where a bare token may not. The $ is
 * what makes it unambiguous: "closing $F here" can only be Ford, while "closing
 * A position soon" is ordinary prose and must not veto.
 *
 * The VERB is spelled out in lower, sentence and upper case rather than being
 * matched case-insensitively, so "CLOSING TSLA" is caught too. An earlier
 * version left the all-caps verb out and called it an accepted missed mirror,
 * which had the trade backwards: excluding it meant a shouted exit mirrored as a
 * BUY, while including it only risks vetoing a shouted "CLOSING STRONG". A
 * dangerous outcome traded away for a merely costly one.
 */
const CLOSE_TICKER_RE =
  /\b(?:clos(?:e|ed|ing)|Clos(?:e|ed|ing)|CLOS(?:E|ED|ING)|cover(?:s|ed|ing)?|Cover(?:s|ed|ing)?|COVER(?:S|ED|ING)?|exit(?:s|ed|ing)?|Exit(?:s|ed|ing)?|EXIT(?:S|ED|ING)?)(?:\s+(?:out|OUT))?\s+(?:\$[A-Za-z]{1,5}|[A-Z]{2,5})\b/;

const EXIT_LANGUAGE_RE = new RegExp(
  [
    String.raw`\bbuy(?:ing)?\s+to\s+cover\b`,
    String.raw`\bclos(?:e|es|ing|ed)\b(?:\s+\w+){0,3}?\s+(?:long|longs|short|shorts|position|positions|trade)\b`,
    String.raw`\bcover(?:s|ing|ed)?\b(?:\s+\w+){0,2}?\s+(?:short|shorts|position)\b`,
    // "close out" needs NEITHER a position noun nor a ticker, unlike bare
    // "close" above. The particle is what makes it an exit: a post can lean on
    // the signal's own symbol field and write only "closed out here", which the
    // noun form and the ticker form both missed, and it mirrored as a BUY.
    //
    // The exclusion is the ordinary calendar sense, "closed out the week
    // green", which is commentary rather than an exit and is common enough in
    // bullish prose to be worth keeping. Anything else after the particle
    // vetoes.
    String.raw`\bclos(?:e|es|ed|ing)\s+out\b(?!\s+(?:the\s+|its\s+|a\s+)?(?:week|weeks|month|months|day|days|year|years|quarter|quarters|session|sessions|q[1-4])\b)`,
    // First person: "I closed TSLA", "we're closing NVDA". No position noun is
    // needed, because the pronoun already makes it the author's own action.
    //
    // "we're" and "we are" are here because they were the example in this very
    // comment and did not match: the copula list carried 'm, 've, am and have,
    // which is every form EXCEPT the plural present, the one "we" actually
    // takes. A post relying on the signal's own symbol field ("we're closing
    // here") then hit no other exit pattern and mirrored as a BUY. The
    // ungrammatical crossings this allows ("i are") cost nothing: they are
    // vetoes for text nobody writes.
    String.raw`\b(?:i|we)(?:'m|'re|'ve|\s+am|\s+are|\s+have)?\s+(?:just\s+)?(?:clos(?:e|ed|ing)|cover(?:s|ed|ing)?)\b`,
    // "I'm out of TSLA", "we are all out". Being out IS the exit, and none of
    // the verb patterns covers it: there is no closing, covering, selling or
    // exiting word anywhere in the sentence, so a post phrased this way passed
    // every veto and mirrored as a BUY.
    //
    // The pronoun is required. A bare "out of TSLA" is too close to ordinary
    // prose ("ran out of room"), and the first person is what makes it the
    // author's own position rather than a description.
    //
    // "out of the money" is excluded: that names where an option is struck, not
    // a position anyone left.
    String.raw`\b(?:i|we)(?:'m|'re|\s+am|\s+are)?\s+(?:all\s+)?out\b(?!\s+of\s+the\s+money\b)`,
    String.raw`\bexit(?:ing|ed)\b`,
    String.raw`\bexit\b(?:\s+\w+){0,3}?\s+(?:long|short|position|trade)\b`,
    String.raw`\b(?:took|taking|take)\s+(?:some\s+|partial\s+)?profits?\b`,
    // The bare root is the IMPERATIVE, which is how these are usually written:
    // "trim TSLA here". Leaving it out matched every inflected form and missed
    // the common one, so an explicit instruction to reduce read as a long and
    // mirrored as a BUY. Unlike "close" and "exit", "trim" has no ordinary
    // bullish sense to protect, so it needs no position noun to disambiguate.
    String.raw`\btrim(?:s|ming|med)?\b`,
    // Stop-outs. An author who was stopped out is FLAT, so mirroring the post as
    // a fresh long buys what they just had taken off them. The trigger word is
    // required: "setting a stop loss at 300, long here" is a long call that
    // happens to name its risk, and must still mirror.
    String.raw`\bstopped\s+out\b`,
    String.raw`\bstop(?:[\s-]*loss)?\s+(?:hit|triggered|tagged)\b`,
    String.raw`\bhit\s+my\s+stop\b`,
  ].join("|"),
  "i",
);

/**
 * An exit stated as an instruction: "sell TSLA here", "selling TSLA", "sold".
 *
 * An unstructured signal saying this was being mirrored as an Alpaca market BUY,
 * which is the opposite of what its author did. Nothing here asserts that the
 * author is short or that a SELL should be placed; it only reports that the text
 * cannot be trusted to mean "open a long", which is the only thing this module
 * ever claims.
 *
 * The cost is that a long call mentioning its exit ("buying TSLA, sell at 300")
 * now vetoes. That is a missed mirror, which is the direction this module is
 * built to be wrong in.
 */
const SELL_POSITION_RE = /\bs(?:ell|ells|elling|old)\b/i;

/**
 * Derivative instruments named in prose.
 *
 * This should track DERIVATIVE_INSTRUMENTS above, which is what the metadata
 * half of this module treats as a derivative. Where the two disagree, a signal
 * carrying the word in a structured field is caught and the same signal saying
 * it in free text is not: "GOOGL swap long" mirrored as a plain equity BUY while
 * `instrument: "swap"` was correctly refused.
 *
 * The singular "future" IS matched, and the ordinary-prose senses are excluded by
 * name instead. An earlier version left it out entirely, which meant the common
 * contract form ("GOOGL future long") mirrored as a plain equity BUY while
 * `instrument: "future"` was correctly refused.
 *
 * Note the direction of failure, which is the opposite of the idiom lists used
 * for "short" and "sell" above. Those SUPPRESS a veto, so a phrase they wrongly
 * cover produces an inverted order. This one ADDS a veto, so a prose sense it
 * fails to exclude only produces a missed mirror. Being generous here is the
 * safe direction, which is why a small exclusion list is acceptable where it
 * would not be there.
 *
 * Verb forms are not matched: "swapping into NVDA" is rotation language and is
 * word-bounded away.
 */
const DERIVATIVE_RE = /\b(perp|perps|perpetual|perpetuals|future|futures|swap|swaps)\b/i;

/**
 * "future" as ordinary English rather than a contract. Stripped before the
 * derivative check only. Anything missed here costs a missed mirror, never an
 * inverted order.
 */
const NEUTRAL_FUTURE_IDIOMS: readonly RegExp[] = [
  /\bfuture\s+of\b/gi,
  /\b(?:in|for|over)\s+the\s+(?:near\s+|foreseeable\s+)?future\b/gi,
  /\bfuture\s+(?:looks|is|seems|remains)\b/gi,
  /\b(?:near|foreseeable|long[\s-]*term)\s+future\b/gi,
];

/**
 * Leverage stated as a multiple beside a direction, or beside the word itself.
 * Deliberately NOT a bare "10x": "NVDA is a 10x from here" is an ordinary
 * bullish take, and "leveraged ETF" is a plain equity that mirrors correctly.
 */
const LEVERAGE_RE =
  /\b(\d{1,3}\s*x\s*(long|short)|(long|short)\s*\d{1,3}\s*x|\d{1,3}\s*x\s*leverage|leverage\s*\d{1,3}\s*x)\b/i;

export interface SignalTextSignals {
  /** Prose names a perp / futures instrument. */
  derivative: boolean;
  /** Prose describes a short position. */
  short: boolean;
  /** Prose states an exit ("sell", "closing my long", "buy to cover"). */
  sell: boolean;
  /** Prose states leverage as a multiple. */
  leverage: boolean;
  /**
   * The text cannot be trusted to describe a plain equity long, so it must not
   * be mirrored as an Alpaca market BUY.
   */
  blocksEquityLong: boolean;
  /** Which checks fired, for the skip log. Never the raw post text. */
  matches: string[];
}

/**
 * Read instrument and direction out of a signal's PROSE.
 *
 * The metadata classifier above only sees structured fields, which the
 * paste.trade poller writes and the Discord poller does not (it stores author
 * fields only). A followed author posting "GOOGL 20x short perp" as free text
 * therefore classified as a mirrorable equity long and was mirrored as an
 * Alpaca market BUY: wrong instrument, inverted direction, real money.
 *
 * This is a VETO, not a parser. It never asserts a direction or an instrument,
 * it only reports that the text is inconsistent with a plain equity long. A
 * missed mirror is a safe outcome; an inverted order is not. That asymmetry is
 * why the checks are allowed to be conservative and why the idiom list above
 * exists to keep them from being absurd.
 */
export function classifySignalText(
  content: string | null | undefined,
): SignalTextSignals {
  const raw = typeof content === "string" ? content : "";
  if (!raw.trim()) {
    return {
      derivative: false,
      short: false,
      sell: false,
      leverage: false,
      blocksEquityLong: false,
      matches: [],
    };
  }

  const withoutIdioms = NEUTRAL_SHORT_IDIOMS.reduce(
    (text, idiom) => text.replace(idiom, " "),
    raw,
  );

  const withoutSellIdioms = NEUTRAL_SELL_IDIOMS.reduce(
    (text, idiom) => text.replace(idiom, " "),
    raw,
  );

  const withoutFutureIdioms = NEUTRAL_FUTURE_IDIOMS.reduce(
    (text, idiom) => text.replace(idiom, " "),
    raw,
  );
  const derivative = DERIVATIVE_RE.test(withoutFutureIdioms);
  const short = SHORT_POSITION_RE.test(withoutIdioms);
  const sell =
    SELL_POSITION_RE.test(withoutSellIdioms) ||
    EXIT_LANGUAGE_RE.test(raw) ||
    CLOSE_TICKER_RE.test(raw);
  const leverage = LEVERAGE_RE.test(raw);
  const matches: string[] = [];
  if (derivative) matches.push("derivative");
  if (short) matches.push("short");
  if (sell) matches.push("sell");
  if (leverage) matches.push("leverage");

  return {
    derivative,
    short,
    sell,
    leverage,
    blocksEquityLong: matches.length > 0,
    matches,
  };
}

export interface SignalInstrumentClassification {
  /** Lowercased venue string from metadata.platform, or null when absent. */
  platform: string | null;
  /** Lowercased instrument string from metadata.instrument, or null when absent. */
  instrument: string | null;
  /** Lowercased direction string from metadata.direction, or null when absent. */
  direction: string | null;
  /** metadata.platform is a perp / derivatives venue. */
  perpVenue: boolean;
  /** metadata.instrument is a perp / derivative. */
  perpInstrument: boolean;
  /** metadata.direction indicates a short. */
  short: boolean;
  /**
   * A perp-only metadata field (leverage / hlTicker) is present with a
   * meaningful value, which marks the row as a perp EVEN IF platform and
   * instrument are missing. Deliberately separate from `perpVenue` /
   * `perpInstrument`: those two answer "which venue / instrument did the row
   * name", and the display-only callers (feed badges, chart matching,
   * leaderboard asset class) key on that pair. This flag answers the narrower
   * money question, "may this be mirrored as a plain equity long", and only
   * feeds `mirrorableEquityLong`.
   */
  perpHint: boolean;
  /** Which perp-only fields fired, for the caller's skip log. Never values. */
  perpHints: string[];
  /** Feed-facing side: a short surfaces as "sell", everything else as "buy". */
  side: SignalDirectionSide;
  /**
   * True only when the signal is a plain equity LONG that is safe to mirror as an
   * Alpaca market BUY. A perp / derivatives venue, a perp / derivative instrument,
   * a short direction, a perp-only field (leverage / hlTicker), or prose that
   * reads as a perp / short / leveraged call each make it false. Signals with
   * none of these are mirrorable (the legacy X / Discord behavior).
   */
  mirrorableEquityLong: boolean;
  /**
   * True when any of platform / instrument / direction was PRESENT on the
   * metadata but unparseable (non-string, or whitespace-only). Classification
   * intentionally fails open in that case (the signal still counts as a plain
   * equity long, which existing Discord signals rely on); this flag lets
   * callers log that fail-open path instead of it happening silently.
   */
  unrecognizedShape: boolean;
  /**
   * What the signal's PROSE says, when the caller passed it. Callers that only
   * have metadata get the all-false shape and behave exactly as before.
   */
  text: SignalTextSignals;
}

/**
 * Classify a signal's instrument/direction from its (possibly stringified)
 * metadata and, when the caller has it, its prose.
 *
 * `content` is optional so the display-only callers (feed, chart matching,
 * leaderboard) keep their exact previous behavior. The paths that can move
 * money, the auto-mirror worker and the manual Copy prefill, pass it.
 */
export function classifySignalInstrument(
  metadata: unknown,
  content?: string | null,
): SignalInstrumentClassification {
  const meta = toRecord(metadata);
  const platform = readField(meta, "platform");
  const instrument = readField(meta, "instrument");
  const direction = readField(meta, "direction");
  const perpVenue = isPerpVenue(platform);
  const perpInstrument = isPerpInstrument(instrument);
  const short = isShortDirection(direction);
  const perpHints = PERP_HINT_FIELDS.filter((key) => isPerpHintPresent(meta, key));
  const perpHint = perpHints.length > 0;
  const unrecognizedShape =
    isFieldPresentButUnparseable(meta, "platform") ||
    isFieldPresentButUnparseable(meta, "instrument") ||
    isFieldPresentButUnparseable(meta, "direction");
  const text = classifySignalText(content);
  return {
    platform,
    instrument,
    direction,
    perpVenue,
    perpInstrument,
    short,
    perpHint,
    perpHints: [...perpHints],
    // Deliberately METADATA ONLY. Text detection is a veto on mirroring, not a
    // claim about direction: asserting "sell" from prose we did not really
    // parse would put a wrong label on a post in the feed, which is a new
    // false statement rather than a withheld action.
    side: short ? "sell" : "buy",
    // `perpHint` joins the veto list, not the venue/instrument pair: a row that
    // still carries a leverage or a canonical HL coin is a perp call whose
    // descriptive fields went missing, and mirroring it as an equity BUY would
    // invert direction and drop leverage on real money.
    mirrorableEquityLong:
      !perpVenue &&
      !perpInstrument &&
      !short &&
      !perpHint &&
      !text.blocksEquityLong,
    unrecognizedShape,
    text,
  };
}

/**
 * Whether a signal (by its metadata) is a plain equity LONG that may be mirrored as
 * a market BUY. A perp / derivatives venue, a perp / derivative instrument, or a
 * SHORT direction each make it NON-mirrorable. Signals with none of these fields are
 * mirrorable (unchanged legacy behavior).
 */
export function isMirrorableEquitySignal(metadata: unknown): boolean {
  return classifySignalInstrument(metadata).mirrorableEquityLong;
}

/**
 * Feed-facing side for a signal: reflect an explicit SHORT / SELL direction as
 * "sell", otherwise "buy". Absent direction => "buy" (unchanged legacy behavior).
 */
export function signalSideFromMetadata(metadata: unknown): SignalDirectionSide {
  return classifySignalInstrument(metadata).side;
}
