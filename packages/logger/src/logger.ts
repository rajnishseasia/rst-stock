import fs from "node:fs";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import { loadLoggerConfig, resolveLoggerConfig } from "./config.js";
import { redactSecrets } from "./redact.js";
import type { LoggerConfig, LoggerContext, LogLevel, Logger } from "./types.js";

const { combine, timestamp, errors, json, printf, colorize, metadata } = winston.format;

winston.addColors({
  emerg: "red bold",
  alert: "red",
  crit: "red",
  error: "red",
  warning: "yellow",
  notice: "cyan",
  info: "green",
  debug: "magenta",
});

/**
 * Ensures the log directory exists before file transports are attached.
 *
 * @param directory - Target log directory path.
 */
function ensureDirectory(directory: string): void {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

/**
 * Builds the transport stack for the Winston logger.
 *
 * @param config - Resolved logger configuration.
 */
function buildTransports(config: LoggerConfig): winston.transport[] {
  const transports: winston.transport[] = [];

  if (config.enableConsole) {
    transports.push(
      new winston.transports.Console({
        level: (config.consoleLevel ?? config.level) as LogLevel,
        format: combine(
          timestamp(),
          metadata({
            fillExcept: ["message", "level", "timestamp", "service"],
          }),
          colorize({ all: config.prettyPrint }),
          printf((info) => {
            const service = info.service ?? config.serviceName;
            const ctx =
              info.context && Object.keys(info.context).length > 0
                ? JSON.stringify(info.context)
                : "";
            const meta =
              info.metadata && Object.keys(info.metadata).length > 0
                ? JSON.stringify(info.metadata)
                : "";
            const contextPieces = [ctx, meta].filter(Boolean).join(" ");
            return `${info.timestamp} ${info.level.padEnd(7)} [${service}] ${info.message}${
              contextPieces ? ` ${contextPieces}` : ""
            }`;
          }),
        ),
      }),
    );
  }

  if (config.enableFile) {
    ensureDirectory(config.logDir);
    transports.push(
      new DailyRotateFile({
        level: (config.fileLevel ?? config.level) as LogLevel,
        dirname: config.logDir,
        filename: config.fileNamePattern.replace("%SERVICE%", config.serviceName),
        maxSize: config.maxSize,
        maxFiles: config.maxFiles,
        zippedArchive: config.zippedArchive,
        format: combine(timestamp(), errors({ stack: true }), json()),
      }),
    );
  }

  if (config.enableHttp && config.http?.host) {
    transports.push(
      new winston.transports.Http({
        level: (config.httpLevel ?? config.level) as LogLevel,
        host: config.http.host,
        port: config.http.port,
        path: config.http.path,
        ssl: config.http.ssl,
        batch: config.http.batch,
        batchCount: config.http.batchCount,
        batchInterval: config.http.batchInterval,
        format: combine(timestamp(), json()),
      }),
    );
  }

  return transports;
}

/**
 * Creates the underlying Winston logger with shared formats and metadata.
 *
 * @param config - Resolved logger configuration.
 */
function createWinstonLogger(config: LoggerConfig): winston.Logger {
  return winston.createLogger({
    level: config.level,
    levels: winston.config.syslog.levels,
    defaultMeta: {
      environment: config.environment,
      serviceName: config.serviceName,
      ...config.defaultMeta,
    },
    format: combine(errors({ stack: true }), timestamp(), json()),
    transports: buildTransports(config),
  });
}

/**
 * Concrete implementation of the Logger contract.
 */
class LoggerImpl implements Logger {
  constructor(
    private readonly logger: winston.Logger,
    private readonly defaultService: string,
    private readonly boundContext: LoggerContext = {},
  ) {}

  /**
   * Logs at the desired level while merging contextual metadata.
   *
   * @param level - Syslog level.
   * @param service - Logical service emitting the message.
   * @param message - Human-readable description.
   * @param context - Optional structured payload.
   */
  private log(level: LogLevel, service: string, message: string, context?: LoggerContext): void {
    const payload =
      context && Object.keys(context).length > 0
        ? { ...this.boundContext, ...context }
        : { ...this.boundContext };

    this.logger.log({
      level,
      message,
      service: service ?? this.defaultService,
      // Safety net (audit L1): secret-keyed values are redacted before any
      // transport serializes the context, so an accidental
      // `logger.info(..., { apiKey })` cannot leak the value to console,
      // files, or the HTTP sink.
      context: Object.keys(payload).length > 0 ? redactSecrets(payload) : undefined,
    });
  }

  /**
   * Emits an error log entry.
   *
   * @param service - Logical service name.
   * @param message - Description of the failure.
   * @param context - Optional structured context.
   */
  error(service: string, message: string, context?: LoggerContext): void {
    this.log("error", service, message, context);
  }

  /**
   * Emits a warning log entry.
   *
   * @param service - Logical service name.
   * @param message - Description of the warning.
   * @param context - Optional structured context.
   */
  warn(service: string, message: string, context?: LoggerContext): void {
    this.log("warning", service, message, context);
  }

  /**
   * Emits a notice log entry used for high-signal informational events.
   *
   * @param service - Logical service name.
   * @param message - Description of the notice.
   * @param context - Optional structured context.
   */
  notice(service: string, message: string, context?: LoggerContext): void {
    this.log("notice", service, message, context);
  }

  /**
   * Emits an informational log entry.
   *
   * @param service - Logical service name.
   * @param message - Description of the event.
   * @param context - Optional structured context.
   */
  info(service: string, message: string, context?: LoggerContext): void {
    this.log("info", service, message, context);
  }

  /**
   * Emits a debug log entry for verbose troubleshooting data.
   *
   * @param service - Logical service name.
   * @param message - Description of the event.
   * @param context - Optional structured context.
   */
  debug(service: string, message: string, context?: LoggerContext): void {
    this.log("debug", service, message, context);
  }

  /**
   * Creates a child logger with merged default context.
   *
   * @param context - Context to bind to every log call.
   */
  child(context: LoggerContext = {}): Logger {
    return new LoggerImpl(this.logger, this.defaultService, {
      ...this.boundContext,
      ...context,
    });
  }

  /**
   * Returns a logger with a new default service name.
   *
   * @param service - Service label applied when callers omit the argument.
   */
  withDefaultService(service: string): Logger {
    return new LoggerImpl(this.logger, service, {
      ...this.boundContext,
    });
  }

  /**
   * Exposes the underlying Winston logger for advanced scenarios.
   */
  get raw(): winston.Logger {
    return this.logger;
  }
}

/**
 * Creates a structured logger from explicit configuration.
 *
 * @param config - Optional overrides for the logger behavior.
 */
export function createLogger(config?: Partial<LoggerConfig>): Logger {
  const resolved = resolveLoggerConfig(config);
  const winstonLogger = createWinstonLogger(resolved);
  return new LoggerImpl(winstonLogger, resolved.serviceName);
}

/**
 * Creates a structured logger by reading environment defaults.
 *
 * @param overrides - Optional overrides applied on top of env-derived config.
 */
export function createLoggerFromEnv(overrides?: Partial<LoggerConfig>): Logger {
  const resolved = loadLoggerConfig(process.env, overrides);
  const winstonLogger = createWinstonLogger(resolved);
  return new LoggerImpl(winstonLogger, resolved.serviceName);
}
