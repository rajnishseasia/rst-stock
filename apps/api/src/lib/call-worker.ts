/**
 * Worker HTTP Client
 *
 * Calls the long-lived worker's private HTTP server for jobs that need
 * native modules unavailable on Vercel (e.g. PNL image rendering).
 * Authenticated with the shared X-Worker-Secret header.
 */

import { TRPCError } from "@trpc/server";
import { env } from "../config/index.js";

const WORKER_TIMEOUT_MS = 30_000;
const ERROR_BODY_LOG_LIMIT = 1_000;

export function isWorkerConfigured(): boolean {
  return Boolean(env.WORKER_HTTP_URL && env.WORKER_API_SECRET);
}

export async function callWorker<T>(path: string, body: unknown): Promise<T> {
  if (!env.WORKER_HTTP_URL || !env.WORKER_API_SECRET) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Image generation service is not configured",
    });
  }

  const workerUrl = `${env.WORKER_HTTP_URL.replace(/\/$/, "")}${path}`;
  let workerHost = "unknown";
  try {
    workerHost = new URL(workerUrl).host;
  } catch {
    workerHost = env.WORKER_HTTP_URL;
  }

  let response: Response;
  try {
    response = await fetch(workerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Worker-Secret": env.WORKER_API_SECRET,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
    });
  } catch (error) {
    console.error(`[Worker] Request to ${path} failed`, { workerHost, error });
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Image generation service is unavailable",
    });
  }

  if (!response.ok) {
    let responseBody = "";
    try {
      responseBody = (await response.text()).slice(0, ERROR_BODY_LOG_LIMIT);
    } catch (error) {
      responseBody = `Unable to read response body: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }

    console.error(`[Worker] ${path} returned ${response.status}`, {
      workerHost,
      statusText: response.statusText,
      responseBody,
    });
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to generate image",
    });
  }

  return (await response.json()) as T;
}
