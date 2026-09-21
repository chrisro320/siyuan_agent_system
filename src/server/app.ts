import { z } from "zod";
import {
  AppError,
  type Candidate,
  candidateDraftSchema,
  GENERATION_MODEL,
  mentalEditSchema,
  type Overview,
  reviewRequestSchema,
  settingsSchema,
  uploadRequestSchema,
  validateEvidence,
  validateMentalSources,
} from "../contracts";
import { errorInfo, type Worker } from "../pipeline/worker";
import { normalizeImport, redactConversation } from "../sources";
import { digest } from "../storage/identity";
import type { Store } from "../storage/store";
import type { Config } from "./config";

export function createApp(
  config: Config,
  store: Store,
  worker: Worker,
): (request: Request) => Promise<Response> {
  const expected = new URL(config.publicOrigin);
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "Cache-Control": "no-store",
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
      if (path === "/api/overview" && method === "GET") {
        const overview: Overview = {
          providers: {
            ollamaConfigured: Boolean(config.ollamaKey),
            jevConfigured: Boolean(config.jevKey),
            siyuanConfigured: Boolean(config.siyuanUrl),
            generationModel: GENERATION_MODEL,
            siyuanPublicUrl: config.siyuanPublicUrl ?? "",
          },
          settings: store.settings(),
          allowedOmpRoots: config.allowedOmpRoots,
          jobs: store.jobs(),
          candidates: store.candidates(),
          operations: store.operations(),
          mentalCards: store.mentalCards(),
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
      const mentalMatch = path.match(/^\/api\/projects\/([^/]+)\/mental$/);
      if (mentalMatch?.[1] && method === "PUT") {
        const projectId = decodeURIComponent(mentalMatch[1]);
        const input = mentalEditSchema.parse(await request.json());
        validateMentalSources(input.content, projectId, store.candidates());
        store.saveMental(
          {
            id: crypto.randomUUID(),
            projectId,
            revision: input.baseRevision + 1,
            baseRevision: input.baseRevision,
            content: input.content,
            author: "human",
            status: "active",
            candidateId: null,
            generation: null,
            createdAt: new Date().toISOString(),
          },
          input.baseRevision,
        );
        store.audit("mental-human-edit", projectId, `base:${input.baseRevision}`);
        return json({ ok: true });
      }
      const acceptMatch = path.match(/^\/api\/mental\/([^/]+)\/accept$/);
      if (acceptMatch?.[1] && method === "POST") {
        const input = z.object({ baseRevision: z.number().int() }).parse(await request.json());
        const proposal = store
          .mentalCards()
          .find((card) => card.id === decodeURIComponent(acceptMatch[1] ?? ""));
        if (!proposal || proposal.status !== "proposal")
          throw new AppError("proposal_missing", "心智提案不存在。", false, 404);
        if (proposal.baseRevision !== input.baseRevision)
          throw new AppError(
            "revision_conflict",
            "此提案基於舊版本，請人工合併，不得直接覆蓋。",
            false,
            409,
          );
        validateMentalSources(proposal.content, proposal.projectId, store.candidates());
        store.saveMental(
          {
            ...proposal,
            id: crypto.randomUUID(),
            revision: input.baseRevision + 1,
            author: "human",
            status: "active",
            candidateId: null,
            createdAt: new Date().toISOString(),
          },
          input.baseRevision,
        );
        store.audit("mental-accepted", proposal.id, `base:${input.baseRevision}`);
        return json({ ok: true });
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
