/**
 * HTTP client for the PaddleOCR-VL microservice.
 *
 * The model runs as a separate, independently hosted Python service (§2, §3) and is never
 * embedded in this process. Its output is advisory: the TypeScript backend performs every
 * authoritative calculation (§11, rule 4).
 *
 * The bot never blocks on OCR availability — if the service is unreachable, callers fall
 * back to manual entry rather than failing the submission (§3).
 */

import { fetchWithRetry } from "../lib/http";
import { logger } from "../lib/logger";
import type { OcrResponse } from "./ocr.types";

export class OcrUnavailableError extends Error {}

export interface OcrClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  apiKey?: string | null;
}

export interface OcrRequest {
  imageUrl: string;
  matchId: string;
  /** Hint only — the model still determines the mode from the screenshot itself. */
  expectedMode?: string | null;
}

function readOptions(): OcrClientOptions | null {
  const baseUrl = process.env.OCR_SERVICE_URL?.trim();
  if (!baseUrl) return null;
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    timeoutMs: Number(process.env.OCR_TIMEOUT_MS ?? 60_000),
    apiKey: process.env.OCR_SERVICE_KEY?.trim() || null,
  };
}

export function isOcrConfigured(): boolean {
  return readOptions() !== null;
}

export async function isOcrHealthy(): Promise<boolean> {
  const options = readOptions();
  if (!options) return false;
  try {
    const response = await fetchWithRetry(
      `${options.baseUrl}/health`,
      {},
      { attempts: 1, timeoutMs: 5_000 },
    );
    return response.ok;
  } catch {
    return false;
  }
}

export async function extractScoreboard(request: OcrRequest): Promise<OcrResponse> {
  const options = readOptions();
  if (!options) {
    throw new OcrUnavailableError("OCR service is not configured (set OCR_SERVICE_URL).");
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;

  let response: Response;
  try {
    response = await fetchWithRetry(
      `${options.baseUrl}/extract`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          image_url: request.imageUrl,
          match_id: request.matchId,
          expected_mode: request.expectedMode ?? null,
        }),
      },
      { attempts: 3, timeoutMs: options.timeoutMs },
    );
  } catch (error) {
    logger.warn("ocr service unreachable", { matchId: request.matchId, error: String(error) });
    throw new OcrUnavailableError("The OCR service could not be reached.");
  }

  if (!response.ok) {
    logger.warn("ocr service error", { matchId: request.matchId, status: response.status });
    throw new OcrUnavailableError(`OCR service returned HTTP ${response.status}.`);
  }

  const body = (await response.json()) as OcrResponse;
  logger.info("ocr extracted", {
    matchId: request.matchId,
    valid: body.validation?.valid,
    streamerMode: body.match?.streamer_mode_enabled,
  });
  return body;
}
