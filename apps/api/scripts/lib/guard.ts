/**
 * Shared safety guard for ad-hoc scripts (audit M2).
 *
 * These scripts run against whatever DATABASE_URL resolves to, which on this
 * team is frequently the shared Supabase database. Reading user PII or
 * writing rows there must be a deliberate act, not a default. The guard
 * refuses to run against a non-local database unless the operator passes an
 * explicit --yes-prod flag.
 *
 * Pure helpers are exported separately so they can be unit tested.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "host.docker.internal"]);

/** True when the connection string points at a non-local database. */
export function isRemoteDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return !LOCAL_HOSTS.has(host);
  } catch {
    // Unparsable URL: treat as remote so the guard fails closed.
    return true;
  }
}

/** Mask an email for log output: keep 2 chars of the local part + domain. */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return "(none)";
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return `${local.slice(0, 2)}***${domain}`;
}

/**
 * Exit unless running against a local database or the operator passed
 * --yes-prod. Call this before any DB access in a script.
 */
export function requireLocalDbOrExplicitConsent(scriptName: string): void {
  const candidates = [
    process.env.DATABASE_URL,
    process.env.DATABASE_URL_DIRECT,
    process.env.DATABASE_URL_POOLED,
  ];
  const remote = candidates.some(isRemoteDatabaseUrl);
  if (remote && !process.argv.includes("--yes-prod")) {
    console.error(
      `[${scriptName}] Refusing to run: DATABASE_URL points at a non-local database. ` +
        "Re-run with --yes-prod if you really intend to touch the shared database.",
    );
    process.exit(1);
  }
}
