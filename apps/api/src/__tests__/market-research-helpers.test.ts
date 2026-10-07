import { describe, expect, it } from "bun:test";

import {
  buildSecUserAgent,
  classifySymbol,
  coinMarketWarning,
  describeSecFailure,
  hasContactEmail,
  HttpError,
  newsUnavailableWarning,
  noCompanyMatchWarning,
  noFilingsWarning,
  noNewsWarning,
} from "../lib/research/market-research-helpers.js";

// A liberal email-token matcher used only to assert that the produced
// User-Agent always carries *some* contact address (SEC 403s without one).
const EMAIL_TOKEN = /[^\s@]+@[^\s@]+\.[^\s@]+/;

describe("buildSecUserAgent", () => {
  it("always includes a contact email token with nothing configured", () => {
    const ua = buildSecUserAgent();
    expect(ua).toMatch(EMAIL_TOKEN);
    expect(hasContactEmail(ua)).toBe(true);
  });

  it("uses the configured User-Agent verbatim when it already has an email", () => {
    const configured = "acme-research/2.0 (mailto:ops@acme.example)";
    expect(buildSecUserAgent({ userAgent: configured })).toBe(configured);
  });

  it("appends a contact email when the configured User-Agent lacks one", () => {
    const ua = buildSecUserAgent({ userAgent: "acme-research/2.0" });
    expect(ua.startsWith("acme-research/2.0")).toBe(true);
    expect(ua).toMatch(EMAIL_TOKEN);
    expect(hasContactEmail(ua)).toBe(true);
  });

  it("prefers an explicit contact email in the default UA", () => {
    const ua = buildSecUserAgent({ contactEmail: "team@example.com" });
    expect(ua).toContain("team@example.com");
    expect(ua).toMatch(EMAIL_TOKEN);
  });

  it("uses the provided web url in the default UA", () => {
    const ua = buildSecUserAgent({ webUrl: "https://example.test" });
    expect(ua).toContain("https://example.test");
    expect(ua).toMatch(EMAIL_TOKEN);
  });

  it("falls back to the default email when configured values are blank", () => {
    const ua = buildSecUserAgent({ userAgent: "  ", contactEmail: "  ", webUrl: "  " });
    expect(ua).toMatch(EMAIL_TOKEN);
    expect(hasContactEmail(ua)).toBe(true);
  });
});

describe("hasContactEmail", () => {
  it("detects an email token", () => {
    expect(hasContactEmail("rst/1.0 me@site.io")).toBe(true);
  });

  it("returns false when no email is present", () => {
    expect(hasContactEmail("rst-stock-site/1.0")).toBe(false);
    expect(hasContactEmail("rst-stock-site/1.0 (https://readysettrade.app)")).toBe(false);
  });
});

describe("classifySymbol", () => {
  it("treats a plain ticker as equity", () => {
    const result = classifySymbol("AAPL");
    expect(result.kind).toBe("equity");
    expect(result.researchSymbol).toBe("AAPL");
    expect(result.normalized).toBe("AAPL");
    expect(result.strippedPrefix).toBe(false);
  });

  it("uppercases and trims lower-case / padded input", () => {
    const result = classifySymbol("  aapl ");
    expect(result.kind).toBe("equity");
    expect(result.researchSymbol).toBe("AAPL");
    expect(result.normalized).toBe("AAPL");
  });

  it("strips an HL-style prefix and researches the underlying equity", () => {
    const result = classifySymbol("xyz:GOOGL");
    expect(result.kind).toBe("equity");
    expect(result.researchSymbol).toBe("GOOGL");
    expect(result.normalized).toBe("XYZ:GOOGL");
    expect(result.strippedPrefix).toBe(true);
  });

  it("strips a prefix for another equity perp", () => {
    const result = classifySymbol("abc:NVDA");
    expect(result.kind).toBe("equity");
    expect(result.researchSymbol).toBe("NVDA");
    expect(result.strippedPrefix).toBe(true);
  });

  it("classifies a pure coin symbol as coin", () => {
    for (const coin of ["BTC", "ETH", "HYPE", "SOL"]) {
      const result = classifySymbol(coin);
      expect(result.kind).toBe("coin");
      expect(result.researchSymbol).toBe(coin);
    }
  });

  it("classifies a prefixed coin perp as coin", () => {
    const result = classifySymbol("xyz:BTC");
    expect(result.kind).toBe("coin");
    expect(result.researchSymbol).toBe("BTC");
    expect(result.strippedPrefix).toBe(true);
  });

  it("classifies HL 1000x meme perps (kPEPE) as coin", () => {
    const result = classifySymbol("kPEPE");
    expect(result.kind).toBe("coin");
    expect(result.researchSymbol).toBe("KPEPE");
  });

  it("does not misclassify a real equity that starts with K", () => {
    const result = classifySymbol("KO");
    expect(result.kind).toBe("equity");
    expect(result.researchSymbol).toBe("KO");
  });
});

describe("describeSecFailure", () => {
  it("returns a distinct, diagnosable warning for a 403", () => {
    const message = describeSecFailure(new HttpError(403, "Forbidden"), "index");
    expect(message).toBe(
      "SEC blocked the request (set SEC_USER_AGENT with a contact email)."
    );
    // Same distinct message regardless of phase.
    expect(describeSecFailure(new HttpError(403, "Forbidden"), "filings")).toBe(message);
  });

  it("returns the generic index error for non-403 failures", () => {
    expect(describeSecFailure(new HttpError(500, "Server Error"), "index")).toBe(
      "Could not query the SEC company ticker index."
    );
    expect(describeSecFailure(new Error("boom"), "index")).toContain("Could not query");
  });

  it("returns the generic filings error for non-403 failures", () => {
    expect(describeSecFailure(new HttpError(503, "Unavailable"), "filings")).toBe(
      "Could not fetch recent SEC filings."
    );
  });

  it("does not label a non-403 as an SEC block", () => {
    expect(describeSecFailure(new HttpError(500, "Server Error"), "index")).not.toContain(
      "SEC blocked"
    );
  });
});

describe("warning classifier: empty results vs errors", () => {
  it("phrases empty SEC results as 'no results found', not 'Could not'", () => {
    for (const warning of [
      noCompanyMatchWarning("ZZZZ"),
      noFilingsWarning("AAPL"),
      noNewsWarning("AAPL"),
    ]) {
      expect(warning.toLowerCase()).toContain("no ");
      expect(warning).not.toContain("Could not");
    }
  });

  it("only genuine transport failures use 'Could not'", () => {
    expect(describeSecFailure(new HttpError(500, "x"), "index")).toContain("Could not");
    expect(describeSecFailure(new HttpError(500, "x"), "filings")).toContain("Could not");
  });

  it("treats a soft news failure as 'temporarily unavailable', not an error", () => {
    const warning = newsUnavailableWarning("AAPL");
    expect(warning.toLowerCase()).toContain("temporarily unavailable");
    expect(warning).not.toContain("Could not");
  });

  it("uses a non-alarming, equity-only note for crypto/perp markets", () => {
    const warning = coinMarketWarning("BTC");
    expect(warning).toContain("equity-only");
    expect(warning).not.toContain("Could not");
    expect(warning.toLowerCase()).toContain("signals");
  });
});
