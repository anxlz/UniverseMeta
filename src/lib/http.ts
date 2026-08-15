/**
 * Retry/backoff wrapper over Bun's native fetch. No node-fetch (§2).
 * Used by the Phase 3 OCR client and any future ranking-bot push.
 */

import { logger } from "./logger";

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  /** Status codes worth retrying. 4xx other than 429 are not. */
  retryOn?: (status: number) => boolean;
}

const defaultRetryOn = (status: number) => status === 429 || status >= 500;

export async function fetchWithRetry(
  input: string | URL | Request,
  init: RequestInit = {},
  options: RetryOptions = {},
): Promise<Response> {
  const {
    attempts = 3,
    baseDelayMs = 300,
    maxDelayMs = 5_000,
    timeoutMs = 30_000,
    retryOn = defaultRetryOn,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(input, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (!retryOn(response.status) || attempt === attempts) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt === attempts) break;
    }

    // Full jitter — avoids a thundering herd when several matches submit at once.
    const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    const delay = Math.random() * ceiling;
    logger.warn("http retry", { attempt, attempts, delayMs: Math.round(delay) });
    await Bun.sleep(delay);
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
