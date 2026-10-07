import type { Logger, LoggerContext } from "../types.js";
import { AsyncLocalStorage } from "node:async_hooks";

export interface TraceContext {
  traceId: string;
  spanId?: string;
  discordId?: string;
  orderHash?: string;
  targetWalletAddress?: string;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

/**
 * Wraps a logger to automatically include trace context in all logs
 */
export function withTraceContext(baseLogger: Logger): Logger {
  const enrichContext = (context?: LoggerContext): LoggerContext => {
    const traceCtx = traceStorage.getStore();
    return {
      ...context,
      ...(traceCtx && {
        traceId: traceCtx.traceId,
        spanId: traceCtx.spanId,
        discordId: traceCtx.discordId,
        orderHash: traceCtx.orderHash,
        targetWalletAddress: traceCtx.targetWalletAddress,
      }),
    };
  };

  return {
    error(service: string, message: string, context?: LoggerContext): void {
      baseLogger.error(service, message, enrichContext(context));
    },
    warn(service: string, message: string, context?: LoggerContext): void {
      baseLogger.warn(service, message, enrichContext(context));
    },
    notice(service: string, message: string, context?: LoggerContext): void {
      baseLogger.notice(service, message, enrichContext(context));
    },
    info(service: string, message: string, context?: LoggerContext): void {
      baseLogger.info(service, message, enrichContext(context));
    },
    debug(service: string, message: string, context?: LoggerContext): void {
      baseLogger.debug(service, message, enrichContext(context));
    },
    child(context?: LoggerContext): Logger {
      return baseLogger.child(enrichContext(context));
    },
    withDefaultService(service: string): Logger {
      return baseLogger.withDefaultService(service);
    },
    get raw() {
      return baseLogger.raw;
    },
  };
}

/**
 * Run a function with trace context
 */
export function runWithTraceContext<T>(context: TraceContext, fn: () => T): T {
  return traceStorage.run(context, fn);
}

/**
 * Get current trace context
 */
export function getTraceContext(): TraceContext | undefined {
  return traceStorage.getStore();
}
