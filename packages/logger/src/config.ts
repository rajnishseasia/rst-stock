import path from "node:path";
import type { LoggerConfig, LoggerHttpConfig, LogLevel } from "./types.js";

/**
 * Default logger configuration shared across environments.
 */
export const DEFAULT_LOGGER_CONFIG: LoggerConfig = {
  serviceName: "olympus",
  environment: process.env.NODE_ENV ?? "development",
  level: "info",
  consoleLevel: undefined,
  fileLevel: undefined,
  httpLevel: "notice",
  enableConsole: true,
  enableFile: false,
  enableHttp: false,
  prettyPrint: process.stdout.isTTY,
  logDir: path.resolve(process.cwd(), "logs"),
  fileNamePattern: "%DATE%.log",
  maxSize: "20m",
  maxFiles: "14d",
  zippedArchive: false,
  defaultMeta: {},
  http: undefined,
};

/**
 * Parses a log level string and falls back to a default when invalid.
 *
 * @param value - Raw level string from env or config.
 * @param fallback - Default level to return when parsing fails.
 */
function parseLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  const normalized = value?.toLowerCase() as LogLevel | undefined;
  const allowed: LogLevel[] = [
    "emerg",
    "alert",
    "crit",
    "error",
    "warning",
    "notice",
    "info",
    "debug",
  ];
  return normalized && allowed.includes(normalized) ? normalized : fallback;
}

/**
 * Parses boolean-like strings such as "true"/"1".
 *
 * @param value - Incoming string value.
 * @param fallback - Default boolean when value is undefined.
 */
function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return ["true", "1", "yes", "on"].includes(value.toLowerCase());
}

/**
 * Parses numbers with graceful fallback.
 *
 * @param value - Value to parse.
 * @param fallback - Number to return when parsing fails.
 */
function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Builds HTTP transport configuration from environment variables.
 *
 * @param env - Environment map.
 */
function buildHttpConfig(env: NodeJS.ProcessEnv): LoggerHttpConfig | undefined {
  const host = env.LOGGER_HTTP_HOST;
  const pathValue = env.LOGGER_HTTP_PATH ?? "/logs";

  if (!host) {
    return undefined;
  }

  return {
    host,
    path: pathValue.startsWith("/") ? pathValue : `/${pathValue}`,
    port: parseNumber(env.LOGGER_HTTP_PORT, 443),
    ssl: parseBoolean(env.LOGGER_HTTP_SSL, true),
    batch: parseBoolean(env.LOGGER_HTTP_BATCH, true),
    batchCount: parseNumber(env.LOGGER_HTTP_BATCH_COUNT, 10),
    batchInterval: parseNumber(env.LOGGER_HTTP_BATCH_INTERVAL_MS, 10_000),
  };
}

/**
 * Merges user overrides with defaults to produce a final config.
 *
 * @param overrides - Partial config supplied by consumers.
 */
export function resolveLoggerConfig(overrides?: Partial<LoggerConfig>): LoggerConfig {
  const base = { ...DEFAULT_LOGGER_CONFIG };
  const mergedMeta = { ...base.defaultMeta, ...overrides?.defaultMeta };
  const mergedHttp = overrides?.http ? { ...base.http, ...overrides.http } : base.http;

  return {
    ...base,
    ...overrides,
    defaultMeta: mergedMeta,
    http: mergedHttp,
  };
}

/**
 * Reads environment variables and produces a logger config object.
 *
 * @param env - Environment map (defaults to process.env for ease of testing).
 * @param overrides - Optional manual overrides.
 */
export function loadLoggerConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides?: Partial<LoggerConfig>,
): LoggerConfig {
  const envConfig: Partial<LoggerConfig> = {
    serviceName: env.LOGGER_SERVICE_NAME ?? env.SERVICE_NAME ?? DEFAULT_LOGGER_CONFIG.serviceName,
    environment: env.NODE_ENV ?? DEFAULT_LOGGER_CONFIG.environment,
    level: parseLevel(env.LOGGER_LEVEL, DEFAULT_LOGGER_CONFIG.level),
    consoleLevel: env.LOGGER_CONSOLE_LEVEL
      ? parseLevel(env.LOGGER_CONSOLE_LEVEL, DEFAULT_LOGGER_CONFIG.level)
      : undefined,
    fileLevel: env.LOGGER_FILE_LEVEL
      ? parseLevel(env.LOGGER_FILE_LEVEL, DEFAULT_LOGGER_CONFIG.level)
      : undefined,
    httpLevel: env.LOGGER_HTTP_LEVEL
      ? parseLevel(
          env.LOGGER_HTTP_LEVEL,
          DEFAULT_LOGGER_CONFIG.httpLevel ?? DEFAULT_LOGGER_CONFIG.level,
        )
      : undefined,
    enableConsole: parseBoolean(env.LOGGER_ENABLE_CONSOLE, DEFAULT_LOGGER_CONFIG.enableConsole),
    enableFile: parseBoolean(env.LOGGER_ENABLE_FILE, DEFAULT_LOGGER_CONFIG.enableFile),
    enableHttp: parseBoolean(env.LOGGER_ENABLE_HTTP, DEFAULT_LOGGER_CONFIG.enableHttp),
    prettyPrint: parseBoolean(env.LOGGER_PRETTY_PRINT, DEFAULT_LOGGER_CONFIG.prettyPrint),
    logDir: env.LOGGER_DIRECTORY
      ? path.resolve(env.LOGGER_DIRECTORY)
      : DEFAULT_LOGGER_CONFIG.logDir,
    fileNamePattern: env.LOGGER_FILE_PATTERN ?? DEFAULT_LOGGER_CONFIG.fileNamePattern,
    maxSize: env.LOGGER_MAX_SIZE ?? DEFAULT_LOGGER_CONFIG.maxSize,
    maxFiles: env.LOGGER_MAX_FILES ?? DEFAULT_LOGGER_CONFIG.maxFiles,
    zippedArchive: parseBoolean(env.LOGGER_ZIP_ARCHIVE, DEFAULT_LOGGER_CONFIG.zippedArchive),
    http: buildHttpConfig(env),
  };

  return resolveLoggerConfig({ ...envConfig, ...overrides });
}
