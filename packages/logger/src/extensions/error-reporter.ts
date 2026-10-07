import { redactSecrets } from "../redact.js";
import type { Logger, LoggerContext } from "../types.js";

/**
 * Routing `logger.error` into an external error tracker (Sentry, in practice).
 *
 * The worker had exactly one `Sentry.captureException` call, on the
 * `main().catch()` startup path. Everything after startup reported through
 * `logger.error`, which writes to stdout and feeds the ErrorBurstAlerter, and
 * stopped there. That is 78 call sites whose failures never reached Sentry: a
 * poller throwing every cycle produced console noise and, once it cleared 20
 * errors in an hour, a single Discord line with a count and no stack.
 *
 * This package deliberately does not depend on `@sentry/node`. It is shared by
 * the API and the worker, which initialize Sentry differently, and the logger
 * has no business owning that choice. The reporter is injected instead, and is
 * read at CALL time rather than captured at construction: services build their
 * loggers at module scope (`const logger = createProductionLogger()`), so a
 * reporter bound at construction would miss every logger created before the
 * entry point finished wiring Sentry up.
 */

/**
 * Receives an already-redacted report for one logged error.
 *
 * `error` carries a stack pointing at the `logger.error` call site, which is
 * what makes the resulting Sentry issue groupable and findable. It is
 * synthesized, not the original throw: `logger.error` takes a message and a
 * context, never the caught value, so the original stack is gone by then.
 */
export type ErrorReporter = (report: {
  error: Error;
  service: string;
  message: string;
  context?: LoggerContext;
}) => void;

/**
 * Context key that suppresses reporting for one `logger.error` call.
 *
 * For the crash handlers in the worker entry point, the ORIGINAL error object
 * is still in hand, so they capture it directly and keep its real stack, which
 * is strictly better than anything this module can synthesize. They still want
 * the stdout line. Setting this flag gives them both without filing the same
 * crash in Sentry twice. The decorator strips the key before the log is
 * written, so it never appears in the output.
 */
export const SKIP_ERROR_REPORT = "__skipErrorReport";

let reporter: ErrorReporter | null = null;

/** Install the process-wide error reporter. Call once, at entry point startup. */
export function setErrorReporter(next: ErrorReporter | null): void {
  reporter = next;
}

/** Remove the reporter. Exists for tests and for a clean shutdown path. */
export function clearErrorReporter(): void {
  reporter = null;
}

export function getErrorReporter(): ErrorReporter | null {
  return reporter;
}

/**
 * Build the Error handed to the reporter.
 *
 * `errorName` is the single most useful field the worker's `describeError`
 * produces (AbortError / PostgresError / TypeError), so it is promoted to the
 * Error's name where present. The stack is trimmed of this module's own frames
 * so Sentry groups on the caller, not on the logger.
 */
function synthesizeError(service: string, message: string, context?: LoggerContext): Error {
  const error = new Error(`${service}: ${message}`);
  const errorName = context?.errorName;
  if (typeof errorName === "string" && errorName.length > 0) {
    error.name = errorName;
  }
  return error;
}

class ErrorReportingLogger implements Logger {
  constructor(private readonly base: Logger) {}

  error(service: string, message: string, context?: LoggerContext): void {
    let logged = context;
    let skip = false;
    if (context && SKIP_ERROR_REPORT in context) {
      const { [SKIP_ERROR_REPORT]: flag, ...rest } = context;
      skip = flag === true;
      logged = rest;
    }

    this.base.error(service, message, logged);

    const current = reporter;
    if (skip || !current) return;

    // A reporter that throws must never turn a logged error into a crash, and
    // must never re-enter `logger.error` and recurse. Warn instead: the burst
    // alerter treats warnings as non-events for exactly this reason.
    try {
      current({
        error: synthesizeError(service, message, logged),
        service,
        message,
        context: logged ? redactSecrets(logged) : undefined,
      });
    } catch {
      this.base.warn("logger", "Error reporter threw while reporting an error", {
        reportedService: service,
      });
    }
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
    return new ErrorReportingLogger(this.base.child(context));
  }

  withDefaultService(service: string): Logger {
    return new ErrorReportingLogger(this.base.withDefaultService(service));
  }

  get raw(): Logger["raw"] {
    return this.base.raw;
  }
}

/**
 * Wrap a logger so every `error` call is forwarded to the installed reporter.
 *
 * Safe to apply unconditionally: with no reporter installed this costs one
 * null check per logged error.
 */
export function withErrorReporting(base: Logger): Logger {
  return new ErrorReportingLogger(base);
}
