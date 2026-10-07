/**
 * CORS/CSRF trusted-origin list, extracted from the server entry so it can be
 * unit tested (audit finding M1).
 *
 * localhost origins are DEV-ONLY. They used to be seeded unconditionally,
 * which meant a credentialed request from a page running on the victim's own
 * localhost was accepted in production. Production trusts only the origins
 * listed in WEB_URL (comma-separated for multi-domain setups).
 */
export function buildCorsOrigins(input: {
  webUrl?: string;
  nodeEnv?: string;
}): string[] {
  const origins: string[] = [];

  if (input.nodeEnv !== "production") {
    origins.push(
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:5100",
    );
  }

  if (input.webUrl) {
    origins.push(
      ...input.webUrl
        .split(",")
        .map((url) => url.trim())
        .filter(Boolean),
    );
  }

  return origins;
}
