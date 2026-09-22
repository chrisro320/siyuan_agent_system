/**
 * 服務用戶端：`POST /api/capture` 與 `POST /api/search`。
 *
 * 契約（與伺服器端確認過）：
 * - `Authorization: Bearer <ADAPTER_TOKEN>`；不帶 `Origin`（原生轉接器不是瀏覽器）。
 * - 請求本體就是 `captureRequestSchema` / `searchRequestSchema` 的 JSON。
 * - 2xx 代表已耐久接受（201 首次、200 重播）；`duplicate` 由回應欄位說明。
 * - 401 `adapter_unauthorized`、503 `adapter_not_configured`、403 `project_not_allowed`、
 *   409 `capture_conflict`、400／415 `invalid_input`。
 * - 搜尋只在使用者明確要求時由 `siyuan_search` 工具呼叫；轉接器本身不會在
 *   對話輪次中發出搜尋請求。
 *
 * 失敗一律以分類碼回報，不把權杖、查詢字串或回應本文寫進錯誤字串裡。
 */

import {
  type CaptureRequest,
  type CaptureResponse,
  captureResponseSchema,
  type SearchRequest,
  type SearchResponse,
  searchResponseSchema,
} from "../../src/contracts/index.ts";

export type ServiceFailureKind =
  | "unauthorized"
  | "not-configured"
  | "forbidden"
  | "conflict"
  | "invalid"
  | "http"
  | "transport"
  | "timeout"
  /** 呼叫端主動取消（宿主關閉或工具被取消），不是服務逾時。 */
  | "aborted"
  | "schema";

export interface ServiceFailure {
  kind: ServiceFailureKind;
  /** 安全的分類說明（狀態碼或錯誤碼），不含權杖與查詢文字。 */
  detail: string;
  status: number | null;
}

export type ServiceResult<T> = { ok: true; value: T } | { ok: false; failure: ServiceFailure };

export interface MemoryServiceOptions {
  serviceUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

/**
 * 單次請求的額外控制。
 *
 * `signal` 用來在宿主關閉時立刻中止已經在途的請求：逾時訊號只能等到自己到期，
 * 而關閉路徑必須在幾百毫秒內放行，否則使用者會被一個壞掉的服務拖住。
 */
export interface ServiceCallOptions {
  signal?: AbortSignal;
}

const KIND_BY_STATUS: Record<number, ServiceFailureKind> = {
  400: "invalid",
  401: "unauthorized",
  403: "forbidden",
  409: "conflict",
  415: "invalid",
  422: "invalid",
  503: "not-configured",
};

export class MemoryService {
  readonly #url: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: MemoryServiceOptions) {
    this.#url = options.serviceUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  capture(
    request: CaptureRequest,
    timeoutMs: number,
    options?: ServiceCallOptions,
  ): Promise<ServiceResult<CaptureResponse>> {
    return this.#post(
      "/api/capture",
      request,
      timeoutMs,
      captureResponseSchema.parse.bind(captureResponseSchema),
      options,
    );
  }

  search(
    request: SearchRequest,
    timeoutMs: number,
    options?: ServiceCallOptions,
  ): Promise<ServiceResult<SearchResponse>> {
    return this.#post(
      "/api/search",
      request,
      timeoutMs,
      searchResponseSchema.parse.bind(searchResponseSchema),
      options,
    );
  }

  /**
   * 把「呼叫端取消」與「內部逾時」從一般錯誤中分辨出來。
   *
   * 判準只看訊號本身：只有呼叫端主動取消（`caller.aborted`）算 abort，只有內部
   * 計時器真的到期（`timeout.aborted`）算 timeout。錯誤名稱只用來說明細節，不是
   * 判準——否則一個恰好名為 `AbortError`／`TimeoutError` 的無關錯誤會被誤報成
   * 逾時。兩者都不是時回 `null`，交由呼叫端歸類為 transport 或 schema。
   */
  #cancelFailure(
    error: unknown,
    caller: AbortSignal | undefined,
    timeout: AbortSignal,
  ): ServiceFailure | null {
    const name = error instanceof Error ? error.name : "unknown";
    if (caller?.aborted === true) {
      return { kind: "aborted", detail: `請求已取消（${name}）。`, status: null };
    }
    if (timeout.aborted) {
      return { kind: "timeout", detail: `請求逾時（${name}）。`, status: null };
    }
    return null;
  }

  async #post<T>(
    path: string,
    body: unknown,
    timeoutMs: number,
    parse: (value: unknown) => T,
    options?: ServiceCallOptions,
  ): Promise<ServiceResult<T>> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal =
      options?.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#url}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.#token}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      // 外部取消要保留取消語意：`AbortSignal.any` 讓兩種來源都表現成 abort 錯誤，
      // 呼叫端據此決定是「逾時失敗」還是「被取消」，不能把關閉／工具取消誤報成
      // 服務逾時。
      const failure = this.#cancelFailure(error, options?.signal, timeout);
      if (failure !== null) return { ok: false, failure };
      const name = error instanceof Error ? error.name : "unknown";
      return {
        ok: false,
        failure: { kind: "transport", detail: `請求未完成（${name}）。`, status: null },
      };
    }

    if (!response.ok) {
      const kind = KIND_BY_STATUS[response.status] ?? "http";
      return {
        ok: false,
        failure: { kind, detail: `HTTP ${String(response.status)}`, status: response.status },
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      // 取消也可能發生在本文讀取階段：headers 已經收到、body 還卡著時中斷，這是
      // 取消（或逾時），不是伺服器回了不符 schema 的內容。
      const failure = this.#cancelFailure(error, options?.signal, timeout);
      if (failure !== null) return { ok: false, failure };
      return {
        ok: false,
        failure: { kind: "schema", detail: "回應不符合共享 schema。", status: response.status },
      };
    }
    try {
      return { ok: true, value: parse(payload) };
    } catch {
      return {
        ok: false,
        failure: { kind: "schema", detail: "回應不符合共享 schema。", status: response.status },
      };
    }
  }
}
