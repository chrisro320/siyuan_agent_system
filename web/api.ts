// 同源 HTTP 用戶端。所有回應都以 src/contracts 的共享 schema 驗證，
// 因此 DTO 只有一個權威來源；驗證失敗會明確回報契約錯誤而不是被當成成功。

import {
  type CandidateDetail,
  candidateDetailSchema,
  errorInfoSchema,
  type GenerationProfile,
  type GenerationProfileStatus,
  generationProfileStatusSchema,
  generationProfileUpdateSchema,
  type ImportRequest,
  importResultSchema,
  type Notebook,
  notebooksSchema,
  type Overview,
  overviewSchema,
  reviewResultSchema,
  type Settings,
  settingsSchema,
} from "../src/contracts";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly stage: string,
    readonly retryable: boolean,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface OverviewPayload {
  parsed: Overview;
  // 未解析的原始 settings：送出 PUT 時以它為底，保留伺服器端的未知欄位，避免覆寫掉前端不認識的設定。
  rawSettings: unknown;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
  signal?: AbortSignal;
}

async function readJson(response: Response): Promise<unknown> {
  const textValue = await response.text();
  if (textValue === "") return null;
  try {
    return JSON.parse(textValue) as unknown;
  } catch {
    return null;
  }
}

function failureFrom(response: Response, payload: unknown): ApiError {
  const envelope =
    payload !== null && typeof payload === "object" && "error" in payload
      ? (payload as { error: unknown }).error
      : undefined;
  const parsed = errorInfoSchema.safeParse(envelope);
  if (parsed.success) {
    return new ApiError(
      parsed.data.message,
      parsed.data.code,
      parsed.data.stage,
      parsed.data.retryable,
      response.status,
    );
  }
  return new ApiError(
    `伺服器回應錯誤，且訊息格式不符契約（HTTP ${response.status}）。`,
    "unexpected_response",
    "http",
    response.status >= 500,
    response.status,
  );
}

async function send(
  path: string,
  options: RequestOptions = {},
): Promise<{ response: Response; payload: unknown }> {
  const init: RequestInit = { method: options.method ?? "GET", headers: {} };
  if (options.body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(options.body);
  }
  if (options.signal !== undefined) init.signal = options.signal;
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ApiError(`無法連線到本機後端：${detail}`, "network_error", "client", true, 0);
  }
  const payload = await readJson(response);
  if (!response.ok) throw failureFrom(response, payload);
  return { response, payload };
}

// 回應一律以共享 schema 的 parse 驗證；不符契約時轉成明確錯誤，不讓它被當成成功結果。
function parseContract<T>(schema: { parse(value: unknown): T }, payload: unknown, what: string): T {
  try {
    return schema.parse(payload);
  } catch {
    throw new ApiError(
      `${what}回應不符合共享契約，已停止套用（可能是前後端版本不一致）。`,
      "contract_mismatch",
      "client",
      false,
      0,
    );
  }
}

export async function fetchOverview(signal?: AbortSignal): Promise<OverviewPayload> {
  const { payload } = await send("/api/overview", { signal });
  const parsed = parseContract(overviewSchema, payload, "概覽");
  const rawSettings =
    payload !== null && typeof payload === "object" && "settings" in payload
      ? (payload as { settings: unknown }).settings
      : undefined;
  return { parsed, rawSettings };
}

export async function fetchCandidateDetail(candidateId: string): Promise<CandidateDetail> {
  const { payload } = await send(`/api/candidates/${encodeURIComponent(candidateId)}`);
  return parseContract(candidateDetailSchema, payload, "候選詳情");
}

export async function submitImport(
  request: ImportRequest,
): Promise<{ duplicate: boolean; jobId: string }> {
  const { payload } = await send("/api/import", { method: "POST", body: request });
  const result = parseContract(importResultSchema, payload, "匯入");
  return { duplicate: result.duplicate, jobId: result.job.id };
}

export async function saveSettings(settings: Settings, rawBase: unknown): Promise<Settings> {
  const base =
    rawBase !== null && typeof rawBase === "object" ? (rawBase as Record<string, unknown>) : {};
  // 以伺服器原物件為底，只覆蓋本面板編輯的欄位；revision 使用讀取時的基準值做 CAS。
  const body: Record<string, unknown> = {
    ...base,
    revision: settings.revision,
    policy: settings.policy,
    destinations: settings.destinations,
    ompRoots: settings.ompRoots,
  };
  const { payload } = await send("/api/settings", { method: "PUT", body });
  return parseContract(settingsSchema, payload, "設定");
}

// 產生供應商設定是非秘密的 profile，且使用自己的 revision 做 CAS，與一般設定的樂觀鎖互不影響。
// 送出前先以共享 update schema 收斂欄位，契約外的東西（例如憑據）不可能隨草稿被送出去；
// 回應一律以共享 status schema 驗證，面板因此只有一個 DTO 來源。
export async function saveGenerationProfile(
  revision: number,
  profile: GenerationProfile,
): Promise<GenerationProfileStatus> {
  const body = generationProfileUpdateSchema.parse({ revision, profile });
  const { payload } = await send("/api/generation-profile", { method: "PUT", body });
  return parseContract(generationProfileStatusSchema, payload, "產生供應商設定");
}

export async function fetchNotebooks(): Promise<Notebook[]> {
  const { payload } = await send("/api/notebooks");
  return parseContract(notebooksSchema, payload, "筆記本清單");
}

export async function retryJob(jobId: string): Promise<void> {
  await send(`/api/jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST", body: {} });
}

export async function reprocessJob(jobId: string): Promise<void> {
  await send(`/api/jobs/${encodeURIComponent(jobId)}/reprocess`, { method: "POST", body: {} });
}

export async function reviewCandidate(
  candidateId: string,
  version: number,
  action: "rejudge" | "archive",
  draft?: unknown,
): Promise<{ candidateId: string; jobId: string }> {
  const body: Record<string, unknown> = { version, action };
  if (draft !== undefined) body.draft = draft;
  const { payload } = await send(`/api/candidates/${encodeURIComponent(candidateId)}/review`, {
    method: "POST",
    body,
  });
  return parseContract(reviewResultSchema, payload, "候選修正");
}

export async function undoOperation(operationId: string): Promise<void> {
  await send(`/api/operations/${encodeURIComponent(operationId)}/undo`, {
    method: "POST",
    body: { confirmation: operationId },
  });
}
