import {
  AppError,
  type Candidate,
  type ErrorInfo,
  type GenerationProfile,
  generationProfileSchema,
  type Job,
  type Operation,
  PROMPT_VERSION,
  validateEvidence,
} from "../contracts";
import { GenerationClient } from "../providers/generation";
import { JevClient } from "../providers/jev";
import type { Config } from "../server/config";
import { SiyuanClient } from "../siyuan/client";
import { SiyuanWriter } from "../siyuan/writer";
import { normalizeImport, redactConversation, scanOmpRoot, segmentConversation } from "../sources";
import { digest, generationFingerprint } from "../storage/identity";
import type { Store } from "../storage/store";

export function errorInfo(error: unknown, stage: string): ErrorInfo {
  return error instanceof AppError
    ? { code: error.code, message: error.message, retryable: error.retryable, stage }
    : {
        code: "unexpected_failure",
        message: "處理失敗；原始資料已保留，請檢查設定後重試。",
        retryable: false,
        stage,
      };
}

export class Worker {
  readonly generation: GenerationClient;
  readonly jev: JevClient;
  readonly siyuan: SiyuanClient;
  readonly writer: SiyuanWriter;
  /**
   * 開機凍結的生成選擇與其指紋。這一輪執行只用這一份：面板儲存的草稿、其他分頁的
   * 變更或設定檔的改動都不會影響正在執行與之後建立的工作。
   */
  private readonly generationProfile: GenerationProfile;
  private readonly generationIdentity: string;
  activeJobId: string | null = null;
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private mutation = false;
  private scanning = false;
  private lastScan = 0;

  constructor(
    readonly store: Store,
    readonly config: Config,
  ) {
    this.generationProfile = generationProfileSchema.parse(config.activeGeneration);
    this.generationIdentity = generationFingerprint(this.generationProfile);
    const onUsage = (meta: {
      model: string;
      usage: Record<string, number>;
      promptVersion?: string;
      policyRevision?: number;
    }) => store.audit("provider-usage", this.activeJobId ?? "worker", JSON.stringify(meta));
    this.generation = new GenerationClient({
      ...this.generationProfile,
      apiKey: config.generationKey,
      credentialOrigin: config.generationCredentialOrigin,
      onUsage,
    });
    this.jev = new JevClient({ apiKey: config.jevKey, onUsage });
    this.siyuan = new SiyuanClient({ url: config.siyuanUrl, token: config.siyuanToken });
    this.writer = new SiyuanWriter(
      this.siyuan,
      (operation) => store.saveOperation(operation),
      config.publicOrigin,
    );
  }

  start(): void {
    this.store.recoverInterrupted();
    // 重啟後才發現生效設定不同時，未完成的工作（含尚未開始抽取的）在第一次外部呼叫
    // 之前就停止，不會被新供應商偷偷續作；改用目前設定必須由使用者明示重新處理。
    this.store.stopStaleGenerationJobs();
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    while (this.activeJobId || this.mutation || this.scanning) await Bun.sleep(50);
  }

  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.activeJobId || this.mutation || this.scanning) {
      throw new AppError(
        "worker_busy",
        "背景處理尚未結束，請稍後再操作，避免競態覆寫。",
        false,
        409,
      );
    }
    this.mutation = true;
    try {
      return await action();
    } finally {
      this.mutation = false;
    }
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick()
        .catch(() => {
          this.store.audit("worker-error", "worker", "背景排程發生錯誤，輸入與操作紀錄仍保留。");
        })
        .finally(() => this.schedule(1000));
    }, delay);
  }

  async tick(): Promise<void> {
    if (this.mutation || this.activeJobId || this.scanning) return;
    if (Date.now() - this.lastScan > 15_000) {
      this.lastScan = Date.now();
      this.scanning = true;
      try {
        await this.scanSources();
      } finally {
        this.scanning = false;
      }
    }
    if (this.mutation) return;
    const job = this.store
      .jobs()
      .reverse()
      .find(
        (item) =>
          item.status === "queued" ||
          (item.status === "retry-wait" && (item.nextAttemptAt ?? "") <= new Date().toISOString()),
      );
    if (!job) return;
    this.activeJobId = job.id;
    let stage = "extracting";
    try {
      job.attempts += 1;
      job.error = null;
      job.nextAttemptAt = null;
      this.updateJob(job, "extracting");
      this.assertPolicy(job);
      this.assertGeneration(job);
      const source = this.store.getImport(job.importId);
      const settings = this.store.settings(job.policyRevision);
      const conversation = redactConversation(source.conversation, settings.policy);
      if (!conversation) {
        this.updateJob(job, "archive-only");
        this.store.audit("source-excluded", source.id, "來源符合排除規則，未送往雲端。");
        return;
      }
      const segments = segmentConversation(conversation);
      // 抽取完成後仍須核對來源與生成選擇；重啟時不能用新供應商或新模型續作舊工作。
      const plan = digest(
        JSON.stringify([
          PROMPT_VERSION,
          this.generationProfile.protocol,
          this.generationProfile.baseUrl,
          this.generationProfile.model,
          segments.map((segment) => digest(JSON.stringify(segment))),
        ]),
      );
      if (
        (job.extractionPlan !== null && job.extractionPlan !== plan) ||
        (job.extractionPlan === null && (job.nextSegment > 0 || job.extractionComplete))
      ) {
        throw new AppError(
          "extraction_plan_changed",
          "抽取分段或生成設定已改變，請重新處理，不能沿用舊進度。",
        );
      }
      if (!job.extractionComplete) {
        if (job.extractionPlan === null) {
          job.extractionPlan = plan;
          this.store.saveJob(job);
        }
        const savedCandidates = new Set(this.store.candidates(job.id).map((item) => item.id));
        for (let index = job.nextSegment; index < segments.length; index++) {
          this.assertPolicy(job);
          const segment = segments[index];
          if (!segment) throw new AppError("missing_segment", "來源分段不存在。");
          const result = await this.generation.extract(segment);
          this.assertPolicy(job);
          const batch: Candidate[] = [];
          for (const draft of result.candidates) {
            validateEvidence(draft, segment.messages);
            const logicalId = digest(
              JSON.stringify([
                source.sourceKey,
                draft.kind,
                [...new Set(draft.evidence.map((item) => item.messageId))].sort(),
              ]),
            );
            const candidateId = digest(JSON.stringify([job.id, logicalId, draft]));
            if (savedCandidates.has(candidateId)) continue;
            const now = new Date().toISOString();
            batch.push({
              id: candidateId,
              logicalId,
              jobId: job.id,
              importId: source.id,
              projectId: conversation.projectId,
              draft,
              generation: result.meta,
              judgment: null,
              status: "pending",
              operationId: null,
              relatedIds: [],
              version: 1,
              createdAt: now,
              updatedAt: now,
            });
            savedCandidates.add(candidateId);
          }
          const checkpoint: Job = {
            ...job,
            nextSegment: index + 1,
            status: "extracting",
            updatedAt: new Date().toISOString(),
          };
          this.store.commitExtractionSegment(checkpoint, batch);
          Object.assign(job, checkpoint);
        }
        job.extractionComplete = true;
        this.updateJob(job, "judging");
      }
      const grouped = new Map<string, Candidate[]>();
      for (const candidate of this.store.candidates(job.id)) {
        const group = grouped.get(candidate.logicalId) ?? [];
        group.push(candidate);
        grouped.set(candidate.logicalId, group);
      }
      for (const group of grouped.values()) {
        if (group.length < 2) continue;
        for (const candidate of group.filter((item) => item.status === "pending")) {
          candidate.status = "review";
          this.updateCandidate(candidate);
          this.store.audit(
            "ambiguous-candidate",
            candidate.id,
            "同一訊息錨點出現不同候選內容，保留各版本並交由人工審閱。",
          );
        }
      }
      for (const candidate of this.store.candidates(job.id).reverse()) {
        this.assertPolicy(job);
        validateEvidence(candidate.draft, conversation.messages);
        if (candidate.status === "pending") {
          stage = "judging";
          this.updateJob(job, "judging");
          const destination = settings.destinations.find(
            (item) => item.projectId === candidate.projectId,
          );
          const related = destination
            ? await this.siyuan.related(destination, candidate.draft)
            : [];
          this.assertPolicy(job);
          const judgment = await this.jev.judge(
            candidate.draft,
            conversation.messages,
            related,
            settings.policy,
            job.policyRevision,
          );
          this.assertPolicy(job);
          candidate.judgment = judgment;
          candidate.relatedIds = related.map((item) => item.id);
          candidate.status = judgment.disposition === "retain" ? "ready" : judgment.disposition;
          if (judgment.disposition === "retain" && judgment.action === "duplicate")
            candidate.status = "duplicate";
          this.updateCandidate(candidate);
        }
        if (candidate.status === "ready") {
          stage = "writing";
          this.updateJob(job, "writing");
          if (candidate.judgment?.disposition !== "retain") {
            throw new AppError("missing_retention_gate", "候選沒有有效 Jev 保留結果，已阻止寫入。");
          }
          const destination = settings.destinations.find(
            (item) => item.projectId === candidate.projectId,
          );
          if (!destination)
            throw new AppError(
              "missing_destination",
              "請先設定此專案的思源筆記本與管理路徑，再重新處理。",
            );
          const previous = this.store
            .candidates()
            .find(
              (item) =>
                item.logicalId === candidate.logicalId &&
                item.operationId &&
                item.status === "published",
            );
          const previousOperation = previous?.operationId
            ? this.store.getOperation(previous.operationId)
            : null;
          const related =
            candidate.judgment.action === "append"
              ? await this.siyuan.related(destination, candidate.draft)
              : [];
          const appendId =
            previousOperation?.status === "verified"
              ? previousOperation.documentId
              : related.find((item) => item.owned)?.id;
          this.assertPolicy(job);
          const planned = candidate.operationId
            ? this.store.getOperation(candidate.operationId)
            : this.writer.plan(candidate, destination, source, appendId);
          const existing = this.store.findOperation(planned.contentKey);
          const operation = existing ?? planned;
          if (
            operation.status === "undone" ||
            operation.status === "undoing" ||
            operation.status === "conflict"
          ) {
            candidate.status = "review";
            this.updateCandidate(candidate);
            continue;
          }
          if (existing?.status === "verified" && existing.candidateId !== candidate.id) {
            candidate.status = "duplicate";
            candidate.operationId = existing.id;
            this.updateCandidate(candidate);
          } else {
            if (
              operation.projectId !== candidate.projectId ||
              operation.notebookId !== destination.notebookId ||
              operation.rootPath !== destination.rootPath
            ) {
              throw new AppError(
                "destination_changed",
                "此操作屬於先前的寫入目的地，請先處理舊操作，不會改寫其目標。",
              );
            }
            this.store.saveOperation(operation);
            candidate.operationId = operation.id;
            this.updateCandidate(candidate);
            const verified = await this.writer.execute(operation);
            if (verified.status !== "verified")
              throw new AppError("write_not_verified", "思源寫入尚未驗證，已停止後續流程。");
            candidate.status = "published";
            this.updateCandidate(candidate);
            this.store.audit("published", candidate.id, `siyuan://blocks/${verified.blockId}`);
          }
        }
      }
      const candidates = this.store.candidates(job.id);
      this.updateJob(
        job,
        candidates.some((item) => item.status === "review")
          ? "review"
          : candidates.length > 0 && candidates.every((item) => item.status === "archive-only")
            ? "archive-only"
            : "complete",
      );
    } catch (error) {
      job.error = errorInfo(error, stage);
      const retry = job.error.retryable && job.attempts < 4;
      job.nextAttemptAt = retry
        ? new Date(Date.now() + 2000 * 2 ** job.attempts).toISOString()
        : null;
      this.updateJob(job, retry ? "retry-wait" : "failed");
    } finally {
      this.activeJobId = null;
    }
  }

  private assertPolicy(job: Job): void {
    if (this.store.settings().revision !== job.policyRevision) {
      throw new AppError("policy_changed", "設定版本已變更，請重新處理以使用最新規則。");
    }
  }

  /**
   * 每件工作只能在建立它的生成身分下續行。
   *
   * 指紋包含協定、端點、模型與認證模式，不含憑據：輪替憑據不會讓舊工作中斷。舊版
   * 資料庫留下的 `null` 身分一律視為不符。檢查發生在讀取來源、呼叫生成服務與 Jev
   * 之前，因此不符的工作不會送出任何外部請求，也不會改寫既有候選或已驗證的發布。
   */
  private assertGeneration(job: Job): void {
    if (job.generationFingerprint !== this.generationIdentity) {
      throw new AppError(
        "generation_config_changed",
        "這件工作建立時的生成設定與目前不同，已停止；請重新處理以使用目前設定。",
      );
    }
  }

  private updateJob(job: Job, status: Job["status"]): void {
    job.status = status;
    job.updatedAt = new Date().toISOString();
    this.store.saveJob(job);
  }

  private updateCandidate(candidate: Candidate): void {
    candidate.version += 1;
    candidate.updatedAt = new Date().toISOString();
    this.store.saveCandidate(candidate);
  }

  private async scanSources(): Promise<void> {
    for (const root of this.store.settings().ompRoots.filter((item) => item.enabled)) {
      let imported = 0;
      let error: string | null = null;
      try {
        if (!this.config.allowedOmpRoots.includes(root.path))
          throw new AppError("source_not_allowed", "來源路徑未在伺服器允許清單。");
        for await (const item of scanOmpRoot(root.path, root.projectId)) {
          if (item.issue) {
            error = [error, `${item.issue.file}: ${item.issue.message}`]
              .filter(Boolean)
              .join("; ")
              .slice(0, 4000);
            continue;
          }
          const result = await this.store.ingest(item.request, normalizeImport(item.request));
          if (!result.duplicate) imported += 1;
        }
      } catch (cause) {
        error = errorInfo(cause, "source").message;
      }
      this.store.saveSourceHealth({
        path: root.path,
        checkedAt: new Date().toISOString(),
        imported,
        error,
      });
    }
  }

  async undo(operation: Operation): Promise<Operation> {
    return this.exclusive(async () => {
      const result = await this.writer.undo(operation);
      this.store.audit("undo", result.id, result.status);
      return result;
    });
  }
}
