import type { Logger as WinstonLogger } from "winston";

/**
 * Supported log levels across transports.
 */
export type LogLevel =
  | "emerg"
  | "alert"
  | "crit"
  | "error"
  | "warning"
  | "notice"
  | "info"
  | "debug";

/**
 * Arbitrary metadata attached to log entries.
 */
export interface LoggerContext extends Record<string, unknown> {
  traceId?: string;
  discordId?: string;
  orderHash?: string;
  targetWalletAddress?: string;
}

/**
 * Configuration for optional HTTP transport.
 */
export interface LoggerHttpConfig {
  host: string;
  port: number;
  path: string;
  ssl?: boolean;
  batch?: boolean;
  batchCount?: number;
  batchInterval?: number;
}

/**
 * Resolved logger configuration.
 */
export interface LoggerConfig {
  serviceName: string;
  environment: string;
  level: LogLevel;
  consoleLevel?: LogLevel;
  fileLevel?: LogLevel;
  httpLevel?: LogLevel;
  enableConsole: boolean;
  enableFile: boolean;
  enableHttp: boolean;
  prettyPrint: boolean;
  logDir: string;
  fileNamePattern: string;
  maxSize: string;
  maxFiles: string;
  zippedArchive: boolean;
  defaultMeta?: Record<string, unknown>;
  http?: LoggerHttpConfig;
}

/**
 * Public logger contract consumed by applications.
 */
export interface Logger {
  error(service: string, message: string, context?: LoggerContext): void;
  warn(service: string, message: string, context?: LoggerContext): void;
  notice(service: string, message: string, context?: LoggerContext): void;
  info(service: string, message: string, context?: LoggerContext): void;
  debug(service: string, message: string, context?: LoggerContext): void;
  child(context?: LoggerContext): Logger;
  withDefaultService(service: string): Logger;
  get raw(): WinstonLogger;
}
