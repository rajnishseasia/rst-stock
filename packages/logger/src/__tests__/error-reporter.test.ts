import { afterEach, describe, expect, test } from "bun:test";
import {
  SKIP_ERROR_REPORT,
  clearErrorReporter,
  setErrorReporter,
  withErrorReporting,
} from "../extensions/error-reporter";
import type { Logger, LoggerContext } from "../types";

interface Recorded {
  level: string;
  service: string;
  message: string;
  context?: LoggerContext;
}

function makeLogger(recorded: Recorded[]): Logger {
  const record = (level: string) => (service: string, message: string, context?: LoggerContext) => {
    recorded.push({ level, service, message, context });
  };
  const logger = {
    error: record("error"),
    warn: record("warn"),
    notice: record("notice"),
    info: record("info"),
    debug: record("debug"),
    child: () => logger,
    withDefaultService: () => logger,
    raw: {} as Logger["raw"],
  } satisfies Logger;
  return logger;
}

afterEach(() => {
  clearErrorReporter();
});

describe("withErrorReporting", () => {
  test("forwards logged errors to the installed reporter", () => {
    const reports: Array<{ service: string; message: string }> = [];
    setErrorReporter(({ service, message }) => reports.push({ service, message }));

    withErrorReporting(makeLogger([])).error("order-sync", "Sync failed");

    expect(reports).toEqual([{ service: "order-sync", message: "Sync failed" }]);
  });

  test("still writes to the base logger when no reporter is installed", () => {
    const recorded: Recorded[] = [];
    withErrorReporting(makeLogger(recorded)).error("order-sync", "Sync failed");

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.level).toBe("error");
  });

  // The reporter is looked up per call, not captured at construction: services
  // build their logger at module scope, before the entry point installs it.
  test("reports through a logger created before the reporter was installed", () => {
    const reports: string[] = [];
    const logger = withErrorReporting(makeLogger([]));

    setErrorReporter(({ message }) => reports.push(message));
    logger.error("poller", "Cycle failed");

    expect(reports).toEqual(["Cycle failed"]);
  });

  test("names the synthesized error after context.errorName", () => {
    const names: string[] = [];
    setErrorReporter(({ error }) => names.push(error.name));

    withErrorReporting(makeLogger([])).error("db", "Query failed", {
      errorName: "PostgresError",
    });

    expect(names).toEqual(["PostgresError"]);
  });

  test("redacts secrets out of the reported context", () => {
    const contexts: Array<LoggerContext | undefined> = [];
    setErrorReporter(({ context }) => contexts.push(context));

    withErrorReporting(makeLogger([])).error("broker", "Rejected", {
      apiKey: "super-secret",
      symbol: "AAPL",
    });

    expect(contexts[0]?.symbol).toBe("AAPL");
    expect(contexts[0]?.apiKey).not.toBe("super-secret");
  });

  test("only non-error levels bypass the reporter", () => {
    let calls = 0;
    setErrorReporter(() => { calls += 1; });

    const logger = withErrorReporting(makeLogger([]));
    logger.warn("worker", "slow");
    logger.info("worker", "ok");
    logger.notice("worker", "note");
    logger.debug("worker", "detail");

    expect(calls).toBe(0);
  });

  test("child and withDefaultService loggers keep reporting", () => {
    const reports: string[] = [];
    setErrorReporter(({ message }) => reports.push(message));

    const logger = withErrorReporting(makeLogger([]));
    logger.child({ traceId: "t1" }).error("a", "child failed");
    logger.withDefaultService("b").error("b", "default failed");

    expect(reports).toEqual(["child failed", "default failed"]);
  });

  describe("SKIP_ERROR_REPORT", () => {
    test("suppresses the report but still logs", () => {
      const recorded: Recorded[] = [];
      let calls = 0;
      setErrorReporter(() => { calls += 1; });

      withErrorReporting(makeLogger(recorded)).error("worker", "Fatal", {
        errorName: "Error",
        [SKIP_ERROR_REPORT]: true,
      });

      expect(calls).toBe(0);
      expect(recorded).toHaveLength(1);
    });

    // The flag is the decorator's own protocol, not diagnostic content.
    test("is stripped from the written log context", () => {
      const recorded: Recorded[] = [];
      withErrorReporting(makeLogger(recorded)).error("worker", "Fatal", {
        errorName: "Error",
        [SKIP_ERROR_REPORT]: true,
      });

      expect(recorded[0]?.context).toEqual({ errorName: "Error" });
    });
  });

  // A broken reporter must not escalate a logged error into a crash, and must
  // not re-enter error() and recurse.
  test("a throwing reporter warns instead of propagating", () => {
    const recorded: Recorded[] = [];
    setErrorReporter(() => {
      throw new Error("sentry is down");
    });

    expect(() => {
      withErrorReporting(makeLogger(recorded)).error("worker", "Sync failed");
    }).not.toThrow();

    expect(recorded.map((entry) => entry.level)).toEqual(["error", "warn"]);
  });
});
