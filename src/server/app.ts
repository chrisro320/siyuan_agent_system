import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  AppError,
  type Candidate,
  candidateDraftSchema,
  captureRequestSchema,
  type GenerationProfileStatus,
  generationProfileUpdateSchema,
  type Overview,
  reviewRequestSchema,
  searchRequestSchema,
  settingsSchema,
  uploadRequestSchema,
  validateEvidence,
} from "../contracts";
import { acceptCapture, search } from "../memory";
import { errorInfo, type Worker } from "../pipeline/worker";
import { normalizeImport, redactConversation } from "../sources";
import { digest, generationFingerprint } from "../storage/identity";
import type { Store } from "../storage/store";
import { type Config, checkedGenerationProfile } from "./config";

/**
 * 常數時間比較轉接器憑據：內容長度不同即不同，長度相同才逐位比較，
 * 避免用回應時間推測憑據內容。
 */
function matchesToken(provided: string, expected: string): boolean {
  const left = Buffer.from(provided, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** 是否值得留下稽核紀錄：設定或授權的拒絕由回應即可觀察，不重複記錄。 */
function observable(error: unknown): boolean {
  return !(error instanceof AppError) || error.retryable || error.status >= 500;
}

/** 同源 HTTP 處理器：由 `createApp` 產生，伺服器與測試都以這個型別轉接。 */
export type AppHandler = (request: Request) => Promise<Response>;

export function createApp(config: Config, store: Store, worker: Worker): AppHandler {
  const expected = new URL(config.publicOrigin);
  const adapterToken = config.adapterToken?.trim() ?? "";
  const adapterProjects = config.adapterProjects ?? [];
  const authorizeAdapter = (request: Request): void => {
    if (adapterToken === "") {
      throw new AppError(
        "adapter_not_configured",
        "伺服器尚未設定擷取與搜尋的轉接器憑據，端點已停用。",
        false,
        503,
      );
    }
    const header = request.headers.get("authorization")?.trim() ?? "";
    const provided = /^Bearer[ \t]+(.+)$/i.exec(header)?.[1]?.trim() ?? "";
    if (provided === "" || !matchesToken(provided, adapterToken)) {
      throw new AppError("adapter_unauthorized", "轉接器憑據不正確。", false, 401);
    }
  };
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "Cache-Control": "no-store",
  };

  /**
   * 生成設定的現況：`active` 是啟動時凍結的選擇，`staged` 是已保存但尚未生效的草稿
   * （沒有草稿時等於生效值）。兩者都只有非機密欄位，憑據只以存在性呈現。
   *
   * 需要重啟的判斷用生效值與草稿的指紋相比：寫法差異（尾斜線、空白）在儲存時就已
   * 正規化，因此不會出現「內容相同卻一直顯示待重啟」。
   */
  const generationStatus = (): GenerationProfileStatus => {
    const active = config.activeGeneration;
    const staged = store.stagedGeneration();
    const effective = staged?.profile ?? active;
    return {
      active,
      staged: effective,
      revision: staged?.revision ?? 0,
      pendingRestart: generationFingerprint(effective) !== generationFingerprint(active),
      credentialConfigured: config.generationKey !== null,
    };
  };

  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
    try {
      if (path === "/health" && request.method === "GET") return json({ status: "ready" });
      if (
        url.host !== expected.host ||
        (request.headers.get("origin") && request.headers.get("origin") !== config.publicOrigin) ||
        request.headers.get("sec-fetch-site") === "cross-site"
      ) {
        throw new AppError("origin_denied", "請從設定的本機面板網址操作。", false, 403);
      }
      const method = request.method;
      if (!["GET", "POST", "PUT"].includes(method))
        return json(
          {
            error: {
              code: "method_not_allowed",
              message: "不支援此方法。",
              stage: "api",
              retryable: false,
            },
          },
          405,
        );
      if (
        method !== "GET" &&
        !request.headers.get("content-type")?.startsWith("application/json")
      ) {
        throw new AppError("json_required", "請使用 JSON 傳送資料。", false, 415);
      }
      if (path === "/api/capture" && method === "POST") {
        authorizeAdapter(request);
        const input = captureRequestSchema.parse(await request.json());
        try {
          const result = await acceptCapture(store, adapterProjects, input);
          return json(result, result.duplicate ? 200 : 201);
        } catch (error) {
          if (observable(error))
            store.audit(
              "capture.failed",
              input.captureId,
              error instanceof AppError ? error.code : "unexpected_failure",
            );
          throw error;
        }
      }
      if (path === "/api/search" && method === "POST") {
        authorizeAdapter(request);
        const input = searchRequestSchema.parse(await request.json());
        try {
          return json(await search(store, worker.siyuan, adapterProjects, input));
        } catch (error) {
          if (observable(error))
            store.audit(
              "search.failed",
              input.projectId,
              error instanceof AppError ? error.code : "unexpected_failure",
            );
          throw error;
        }
      }
      if (path === "/api/overview" && method === "GET") {
        const generation = generationStatus();
        const overview: Overview = {
          providers: {
            generationConfigured:
              generation.active.authMode === "none" || generation.credentialConfigured,
            jevConfigured: Boolean(config.jevKey),
            siyuanConfigured: Boolean(config.siyuanUrl),
            generationModel: generation.active.model,
            siyuanPublicUrl: config.siyuanPublicUrl ?? "",
          },
          settings: store.settings(),
          generationProfile: generation,
          allowedOmpRoots: config.allowedOmpRoots,
          jobs: store.jobs(),
          candidates: store.candidates(),
          operations: store.operations(),
          audit: store.audits(),
          sources: store.sourceHealth(),
        };
        return json(overview);
      }
      if (path === "/api/import" && method === "POST") {
        const input = uploadRequestSchema.parse(await request.json());
        return json(await store.ingest(input, normalizeImport(input)), 201);
      }
      if (path === "/api/settings" && method === "PUT") {
        const input = settingsSchema.parse(await request.json());
        return json(
          await worker.exclusive(async () => {
            if (
              new Set(input.destinations.map((item) => item.projectId)).size !==
                input.destinations.length ||
              new Set(input.ompRoots.map((item) => item.path)).size !== input.ompRoots.length
            ) {
              throw new AppError("duplicate_setting", "每個專案目的地與來源路徑只能設定一次。");
            }
            for (const root of input.ompRoots) {
              if (!config.allowedOmpRoots.includes(root.path))
                throw new AppError("source_not_allowed", "來源路徑不在伺服器允許清單。");
            }
            if (input.destinations.length) {
              const notebooks = await worker.siyuan.notebooks();
              if (
                input.destinations.some(
                  (item) => !notebooks.some((notebook) => notebook.id === item.notebookId),
                )
              ) {
                throw new AppError("unknown_notebook", "請選擇目前可存取的思源筆記本。");
              }
            }
            return store.saveSettings(input);
          }),
        );
      }
      if (path === "/api/notebooks" && method === "GET")
        return json(await worker.siyuan.notebooks());
      // 生成設定草稿：只寫非機密欄位，且與一般設定各自的 revision 樂觀鎖互不影響。
      // 儲存不會改變執行中的 worker、既有工作或 Jev 政策；重啟後才會生效。
      if (path === "/api/generation-profile" && method === "PUT") {
        const input = generationProfileUpdateSchema.parse(await request.json());
        store.saveGenerationProfile({
          revision: input.revision,
          profile: checkedGenerationProfile(input.profile),
        });
        return json(generationStatus());
      }
      const candidateMatch = path.match(/^\/api\/candidates\/([^/]+)(\/review)?$/);
      if (candidateMatch?.[1]) {
        const candidate = store.getCandidate(decodeURIComponent(candidateMatch[1]));
        if (method === "GET" && !candidateMatch[2]) {
          return json({
            candidate,
            source: store.getImport(candidate.importId),
            operations: store
              .operations()
              .filter(
                (operation) =>
                  operation.id === candidate.operationId || operation.candidateId === candidate.id,
              ),
          });
        }
        if (method === "POST" && candidateMatch[2]) {
          const input = reviewRequestSchema.parse(await request.json());
          return json(
            await worker.exclusive(async () => {
              const current = store.getCandidate(candidate.id);
              if (input.version !== current.version)
                throw new AppError(
                  "revision_conflict",
                  "候選已變更，請重新載入後再修改。",
                  false,
                  409,
                );
              if (current.operationId) {
                const operation = store.getOperation(current.operationId);
                if (["planned", "sent", "uncertain", "undoing"].includes(operation.status)) {
                  throw new AppError(
                    "pending_operation",
                    "請先完成或撤回尚未確認的寫入操作，再修正候選。",
                    false,
                    409,
                  );
                }
              }
              if (input.action === "archive") {
                if (["published", "duplicate"].includes(current.status))
                  throw new AppError(
                    "already_published",
                    "已發布候選請使用操作歷史撤回，不能只改封存標記。",
                  );
                store.saveCandidate({
                  ...current,
                  status: "archive-only",
                  version: current.version + 1,
                  updatedAt: new Date().toISOString(),
                });
                store.audit("human-archive", current.id, "人工決定僅封存；未繞過 Jev 建立新筆記。");
                const job = store.getJob(current.jobId);
                const remaining = store.candidates(current.jobId);
                if (
                  job.extractionComplete &&
                  remaining.every((item) => !["pending", "ready"].includes(item.status))
                ) {
                  store.saveJob({
                    ...job,
                    status: remaining.some((item) => item.status === "review")
                      ? "review"
                      : remaining.every((item) => item.status === "archive-only")
                        ? "archive-only"
                        : "complete",
                    error: null,
                    nextAttemptAt: null,
                    updatedAt: new Date().toISOString(),
                  });
                }
              } else {
                const draft = candidateDraftSchema.parse(input.draft ?? current.draft);
                const source = store.getImport(current.importId);
                const conversation = redactConversation(
                  source.conversation,
                  store.settings().policy,
                );
                if (!conversation)
                  throw new AppError("source_excluded", "此來源已排除，不能送雲端重新判斷。");
                validateEvidence(draft, conversation.messages);
                const job = store.createJob(current.importId, true);
                const revised: Candidate = {
                  ...current,
                  id: digest(`${current.id}:human:${current.version + 1}`),
                  jobId: job.id,
                  draft,
                  judgment: null,
                  status: "pending",
                  operationId: null,
                  relatedIds: [],
                  version: 1,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                };
                store.saveCandidate(revised);
                store.saveCandidate({
                  ...current,
                  status: ["published", "duplicate"].includes(current.status)
                    ? current.status
                    : "archive-only",
                  version: current.version + 1,
                  updatedAt: new Date().toISOString(),
                });
                store.saveJob({
                  ...job,
                  status: "queued",
                  attempts: 0,
                  nextAttemptAt: null,
                  error: null,
                  extractionComplete: true,
                  updatedAt: new Date().toISOString(),
                });
                store.audit(
                  "human-correction",
                  revised.id,
                  JSON.stringify({ previousId: current.id, before: current.draft, after: draft }),
                );
                return { candidateId: revised.id, jobId: job.id };
              }
              return { candidateId: current.id, jobId: current.jobId };
            }),
          );
        }
      }
      const jobMatch = path.match(/^\/api\/jobs\/([^/]+)\/(retry|reprocess)$/);
      if (jobMatch?.[1] && method === "POST") {
        return json(
          await worker.exclusive(async () => {
            const previous = store.getJob(decodeURIComponent(jobMatch[1] ?? ""));
            const reprocess = jobMatch[2] === "reprocess";
            if (!reprocess && !["failed", "retry-wait"].includes(previous.status)) {
              throw new AppError(
                "job_not_retryable",
                "只有失敗或等待重試的工作可以重試。",
                false,
                409,
              );
            }
            if (
              !reprocess &&
              previous.generationFingerprint !== store.activeGenerationFingerprint()
            ) {
              throw new AppError(
                "generation_config_changed",
                "生成設定已變更，請使用重新處理，而不是重試舊工作。",
                false,
                409,
              );
            }
            if (!reprocess && previous.policyRevision !== store.settings().revision) {
              throw new AppError(
                "policy_changed",
                "設定已變更，請使用重新處理，而不是重試舊工作。",
                false,
                409,
              );
            }
            const job = reprocess ? store.createJob(previous.importId, true) : previous;
            store.saveJob({
              ...job,
              status: "queued",
              attempts: 0,
              nextAttemptAt: null,
              error: null,
              updatedAt: new Date().toISOString(),
            });
            store.audit(jobMatch[2] ?? "retry", job.id, `previous:${previous.id}`);
            return { jobId: job.id };
          }),
        );
      }
      const undoMatch = path.match(/^\/api\/operations\/([^/]+)\/undo$/);
      if (undoMatch?.[1] && method === "POST") {
        const operationId = decodeURIComponent(undoMatch[1]);
        const input = z
          .object({ confirmation: z.literal(operationId) })
          .parse(await request.json());
        return json(await worker.undo(store.getOperation(input.confirmation)));
      }
      if (path.startsWith("/api/")) throw new AppError("not_found", "找不到此 API。", false, 404);
      const assets: Record<string, string> = {
        "/": "index.html",
        "/index.html": "index.html",
        "/main.js": "main.js",
        "/style.css": "style.css",
      };
      const asset = assets[path];
      if (!asset || method !== "GET") throw new AppError("not_found", "找不到此頁面。", false, 404);
      const file = Bun.file(new URL(`../../dist/${asset}`, import.meta.url));
      if (!(await file.exists()))
        throw new AppError("assets_missing", "網頁尚未建置，請先執行 bun run build。", false, 503);
      return new Response(file, { headers });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        return json(
          {
            error: {
              code: "invalid_input",
              message: "資料格式不正確，請檢查必填欄位與欄位型別。",
              stage: "api",
              retryable: false,
            },
          },
          400,
        );
      }
      return json(
        { error: errorInfo(error, "api") },
        error instanceof AppError ? error.status : 500,
      );
    }
  };
}
