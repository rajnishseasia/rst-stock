export { createLogger, createLoggerFromEnv } from "./logger.js";
export { loadLoggerConfig, resolveLoggerConfig, DEFAULT_LOGGER_CONFIG } from "./config.js";
export type { LoggerConfig, LoggerContext, LoggerHttpConfig, LogLevel, Logger } from "./types.js";
export * from "./extensions/index.js";

import { createLoggerFromEnv } from "./logger.js";
import { ErrorBurstAlerter, withErrorBurstAlerts } from "./extensions/error-burst-alert.js";
import { withTraceContext } from "./extensions/trace-context.js";
import { withErrorReporting } from "./extensions/error-reporter.js";
import type { Logger } from "./types.js";

let sharedWorkerAlerter: { webhookUrl: string; alerter: ErrorBurstAlerter } | null = null;

/**
 * Create a production logger with trace context and error reporting.
 *
 * Error reporting is applied unconditionally. The reporter itself is injected
 * by the entry point (see `setErrorReporter`) and looked up per call, so a
 * logger built at module scope, before the entry point has initialized Sentry,
 * still reports once the reporter lands.
 */
export function createProductionLogger(): Logger {
  const baseLogger = createLoggerFromEnv();
  const tracedLogger = withErrorReporting(withTraceContext(baseLogger));
  // This package is shared by the API and worker. Requiring a worker-specific
  // variable prevents API functions from posting worker-labelled alerts.
  const webhookUrl = process.env.WORKER_ERROR_ALERT_WEBHOOK_URL?.trim();

  if (!webhookUrl) return tracedLogger;

  if (sharedWorkerAlerter?.webhookUrl !== webhookUrl) {
    sharedWorkerAlerter = {
      webhookUrl,
      alerter: new ErrorBurstAlerter({ webhookUrl, logger: tracedLogger }),
    };
  }

  return withErrorBurstAlerts(tracedLogger, sharedWorkerAlerter.alerter);
}
