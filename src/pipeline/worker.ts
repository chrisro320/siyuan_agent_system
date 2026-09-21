import {
  AppError,
  type Candidate,
  type ErrorInfo,
  emptyMental,
  type Job,
  type MentalCard,
  type Operation,
  PROMPT_VERSION,
  validateEvidence,
  validateMentalSources,
} from "../contracts";
import { JevClient } from "../providers/jev";
import { OllamaClient } from "../providers/ollama";
import type { Config } from "../server/config";
import { SiyuanClient } from "../siyuan/client";
import { SiyuanWriter } from "../siyuan/writer";
import { normalizeImport, redactConversation, scanOmpRoot, segmentConversation } from "../sources";
import { digest } from "../storage/identity";
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
  readonly ollama: OllamaClient;
  readonly jev: JevClient;
  readonly siyuan: SiyuanClient;
  readonly writer: SiyuanWriter;
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
    const onUsage = (meta: {
      model: string;
      usage: Record<string, number>;
      promptVersion?: string;
      policyRevision?: number;
    }) => store.audit("provider-usage", this.activeJobId ?? "worker", JSON.stringify(meta));
    this.ollama = new OllamaClient({ apiKey: config.ollamaKey, onUsage });
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
      const source = this.store.getImport(job.importId);
      const settings = this.store.settings(job.policyRevision);
      const conversation = redactConversation(source.conversation, settings.policy);
      if (!conversation) {
        this.updateJob(job, "archive-only");
        this.store.audit("source-excluded", source.id, "來源符合排除規則，未送往雲端。");
        return;
      }
      const prior = this.store.activeMental(conversation.projectId);
      const mental = prior?.content ?? emptyMental();
      if (!job.extractionComplete) {
        const segments = segmentConversation(conversation);
        const plan = digest(
          JSON.stringify([
            PROMPT_VERSION,
            segments.map((segment) => digest(JSON.stringify(segment))),
          ]),
        );
        if (
          (job.extractionPlan !== null && job.extractionPlan !== plan) ||
          (job.extractionPlan === null && job.nextSegment > 0)
        ) {
          throw new AppError(
            "extraction_plan_changed",
            "抽取分段或提示版本已改變，請重新處理，不能沿用舊進度略過內容。",
          );
        }
        if (job.extractionPlan === null) {
          job.extractionPlan = plan;
          this.store.saveJob(job);
        }
        const savedCandidates = new Set(this.store.candidates(job.id).map((item) => item.id));
        for (let index = job.nextSegment; index < segments.length; index++) {
          this.assertPolicy(job);
          const segment = segments[index];
          if (!segment) throw new AppError("missing_segment", "來源分段不存在。");
          const result = await this.ollama.extract(segment, mental);
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
            mental,
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
        if (
          ["published", "duplicate"].includes(candidate.status) &&
          !this.store
            .mentalCards(candidate.projectId)
            .some((card) => card.candidateId === candidate.id)
        ) {
          stage = "mental";
          await this.updateMental(candidate);
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

  private async updateMental(candidate: Candidate): Promise<void> {
    const prior = this.store.activeMental(candidate.projectId);
    const content = prior?.content ?? emptyMental();
    const proposal = await this.ollama.proposeMental(content, [candidate]);
    const current = this.store.activeMental(candidate.projectId);
    validateMentalSources(proposal.content, candidate.projectId, this.store.candidates());
    const claimKeys = new Set(
      Object.entries(proposal.content).flatMap(([section, claims]) =>
        claims.map((claim) => JSON.stringify([section, claim.text, [...claim.sources].sort()])),
      ),
    );
    const changedPriorClaim = Object.entries(content).some(([section, claims]) =>
      claims.some(
        (claim) => !claimKeys.has(JSON.stringify([section, claim.text, [...claim.sources].sort()])),
      ),
    );
    const manualOrConflict =
      prior?.author === "human" ||
      changedPriorClaim ||
      (current?.revision ?? 0) !== (prior?.revision ?? 0);
    const card: MentalCard = {
      id: digest(`mental:${candidate.id}`),
      projectId: candidate.projectId,
      revision: (prior?.revision ?? 0) + 1,
      baseRevision: prior?.revision ?? 0,
      content: proposal.content,
      author: "model",
      status: manualOrConflict ? "proposal" : "active",
      candidateId: candidate.id,
      generation: proposal.meta,
      createdAt: new Date().toISOString(),
    };
    this.store.saveMental(card, card.status === "active" ? card.baseRevision : undefined);
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
