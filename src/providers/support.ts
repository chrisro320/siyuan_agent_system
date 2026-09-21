import type { z } from "zod";
import { AppError } from "../contracts/index.ts";

/**
 * Private helpers for the two provider clients. Nothing here is a product
 * contract: `src/contracts/index.ts` stays the single owner of shared DTOs.
 */

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Server-side credentials only. `null` means "not configured"; calls then fail closed. */
export interface ProviderClientOptions {
  apiKey: string | null;
  /** Injected for tests and for the worker's own transport policy. */
  fetch?: FetchLike;
  /** Overrides `MODEL_TIMEOUT_MS`; the worker's configuration is the only caller. */
  timeoutMs?: number;
  onUsage?: (meta: {
    model: string;
    usage: Record<string, number>;
    promptVersion?: string;
    policyRevision?: number;
  }) => void;
}

/** Ceiling for one model call. The worker treats a longer wait as a timeout. */
export const MODEL_TIMEOUT_MS = 120_000;

/**
 * Safety bound for one serialized request. It accommodates the largest payload
 * the shared contracts themselves permit (one candidate with maximum-length
 * fields and evidence), so a legitimate input is never rejected. Input above it
 * is an explicit error for the caller to split; it is never silently truncated.
 */
export const MAX_REQUEST_CHARS = 1_000_000;

/** Missing credentials are a hard stop: no fallback model and no anonymous retry. */
export function requireApiKey(apiKey: string | null, providerLabel: string): string {
  const credential = apiKey?.trim() ?? "";
  if (credential === "") {
    throw new AppError(
      "provider_not_configured",
      `${providerLabel} 尚未設定 API 金鑰，已停止呼叫模型服務。`,
      false,
      503,
    );
  }
  return credential;
}

export function assertWithinRequestLimit(serialized: string, providerLabel: string): void {
  if (serialized.length > MAX_REQUEST_CHARS) {
    throw new AppError(
      "input_too_large",
      `要傳給 ${providerLabel} 的內容超過單次請求上限，未截斷也未送出；請縮小來源範圍後重試。`,
      false,
      413,
    );
  }
}

/** Keeps reported, finite, non-negative counters only; never invents usage. */
export function readUsage(source: unknown, keys: readonly string[]): Record<string, number> {
  const usage: Record<string, number> = {};
  if (typeof source !== "object" || source === null) return usage;
  const reported = source as Record<string, unknown>;
  for (const key of keys) {
    const value = reported[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) usage[key] = value;
  }
  return usage;
}

/** Meta usage accumulates across a repair retry instead of reporting only the last call. */
export function mergeUsage(
  total: Record<string, number>,
  next: Record<string, number>,
): Record<string, number> {
  const merged: Record<string, number> = { ...total };
  for (const [key, value] of Object.entries(next)) merged[key] = (merged[key] ?? 0) + value;
  return merged;
}

/**
 * Validates a provider payload against the schema that owns its shape, and
 * reports only offending field paths and issue codes. Received values are never
 * echoed, so generated or imported content cannot leak through error text.
 */
export function parseContract<T>(
  schema: z.ZodType<T>,
  value: unknown,
  subject: string,
  code = "invalid_model_output",
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues: string[] = [];
  for (const issue of result.error.issues) {
    const label = `${issue.path.join(".") || "(root)"}: ${issue.code}`;
    if (!issues.includes(label)) issues.push(label);
  }
  throw new AppError(
    code,
    `${subject}欄位不符合契約（${issues.join("；")}），未採用此輸出。`,
    false,
    502,
  );
}

export interface JsonPostRequest {
  url: string;
  /** The credential may only ever be sent to this exact origin. */
  allowedOrigin: string;
  apiKey: string;
  /** Pre-serialized payload, so the size guard measures exactly what is sent. */
  body: string;
  fetchImpl: FetchLike;
  providerLabel: string;
  /** Ceiling for this call; defaults to the shared model timeout. */
  timeoutMs?: number;
}

/**
 * Posts JSON with the credential attached. Every transport or provider failure
 * becomes an AppError that describes the status class only: neither request
 * headers nor the raw response body are copied, so a credential or a provider
 * payload cannot leak through error text or logs.
 */
export async function postJson(request: JsonPostRequest): Promise<unknown> {
  const { providerLabel } = request;
  if (new URL(request.url).origin !== request.allowedOrigin) {
    throw new AppError(
      "provider_misconfigured",
      `${providerLabel} 的請求端點不是允許的官方來源，已停止呼叫以免外洩憑據。`,
      false,
      500,
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? MODEL_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await request.fetchImpl(request.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${request.apiKey}`,
        },
        body: request.body,
        signal: controller.signal,
        redirect: "error",
      });
    } catch {
      const timedOut = controller.signal.aborted;
      throw new AppError(
        timedOut ? "provider_timeout" : "provider_unreachable",
        timedOut
          ? `${providerLabel} 未在時限內回應，將依排程重試。`
          : `${providerLabel} 連線失敗，將依排程重試。`,
        true,
        timedOut ? 504 : 502,
      );
    }

    if (!response.ok) {
      const status = response.status;
      if (status === 401 || status === 403) {
        throw new AppError(
          "provider_unauthorized",
          `${providerLabel} 拒絕了目前的憑據，請更新設定後重試。`,
          false,
          status,
        );
      }
      if (status === 429) {
        throw new AppError(
          "provider_rate_limited",
          `${providerLabel} 回報流量限制，將依排程重試。`,
          true,
          status,
        );
      }
      if (status >= 500) {
        throw new AppError(
          "provider_unavailable",
          `${providerLabel} 暫時無法服務，將依排程重試。`,
          true,
          status,
        );
      }
      throw new AppError(
        "provider_rejected",
        `${providerLabel} 拒絕了這次請求，已停止後續步驟。`,
        false,
        status,
      );
    }

    try {
      return await response.json();
    } catch (error) {
      if (controller.signal.aborted || !(error instanceof SyntaxError)) {
        throw new AppError(
          controller.signal.aborted ? "provider_timeout" : "provider_unreachable",
          `${providerLabel} 的回應傳輸中斷，將依排程重試。`,
          true,
          controller.signal.aborted ? 504 : 502,
        );
      }
      throw new AppError(
        "invalid_response",
        `${providerLabel} 的回應不是有效 JSON，已停止後續步驟。`,
        false,
        502,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parses the whole model answer as JSON, tolerating exactly one surrounding code
 * fence. Partial JSON is never salvaged into publishable content.
 */
export function parseModelJson(content: string): unknown {
  const trimmed = content.trim();
  if (trimmed === "") {
    throw new AppError("invalid_model_output", "模型回應沒有內容，已停止後續步驟。", false, 502);
  }
  const fenced = /^```[A-Za-z0-9_-]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  const body = (fenced?.[1] ?? trimmed).trim();
  try {
    return JSON.parse(body);
  } catch {
    throw new AppError(
      "invalid_model_output",
      "模型輸出不是完整 JSON，已停止後續步驟。",
      false,
      502,
    );
  }
}
