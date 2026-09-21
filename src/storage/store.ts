import { Database, SQLiteError } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { link, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  AppError,
  type Audit,
  auditSchema,
  type Candidate,
  type Conversation,
  candidateSchema,
  conversationSchema,
  defaultSettings,
  type ImportRecord,
  type ImportRequest,
  id,
  importRecordSchema,
  importRequestSchema,
  isoTime,
  type Job,
  jobSchema,
  type MentalCard,
  mentalCardSchema,
  type Operation,
  operationSchema,
  PROMPT_VERSION,
  type Settings,
  type SourceHealth,
  settingsSchema,
  sourceHealthSchema,
} from "../contracts/index.ts";
import {
  digest,
  messageKeyOf,
  messageRevisionOf,
  newId,
  now,
  revisionOf,
  sourceKeyOf,
} from "./identity.ts";

const SCHEMA_VERSION = 1;

/**
 * 第一版結構。每一條 unique 都對應一種不可混淆的身分：
 * 來源版本、工作執行、發布操作、心智卡生效版本。
 */
const SCHEMA_V1 = `
CREATE TABLE settings (
  revision INTEGER PRIMARY KEY,
  data TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  sourceKey TEXT NOT NULL,
  revision TEXT NOT NULL,
  rawDigest TEXT NOT NULL,
  projectId TEXT NOT NULL,
  source TEXT NOT NULL,
  sourceSessionId TEXT NOT NULL,
  conversation TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  UNIQUE (sourceKey, revision)
);
CREATE INDEX imports_project ON imports(projectId, createdAt);
CREATE TABLE raw_snapshots (
  importId TEXT NOT NULL,
  rawDigest TEXT NOT NULL,
  sourceLocator TEXT NOT NULL,
  receivedAt TEXT NOT NULL,
  PRIMARY KEY (importId, rawDigest, sourceLocator)
);
CREATE TABLE message_revisions (
  messageKey TEXT NOT NULL,
  revision TEXT NOT NULL,
  sourceKey TEXT NOT NULL,
  sourceMessageId TEXT NOT NULL,
  message TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (messageKey, revision)
);
CREATE INDEX message_revisions_source ON message_revisions(sourceKey);
CREATE TABLE import_revision_messages (
  importId TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  messageKey TEXT NOT NULL,
  messageRevision TEXT NOT NULL,
  PRIMARY KEY (importId, ordinal)
);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  importId TEXT NOT NULL,
  policyRevision INTEGER NOT NULL,
  promptVersion TEXT NOT NULL,
  run INTEGER NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  nextAttemptAt TEXT,
  error TEXT,
  nextSegment INTEGER NOT NULL,
  extractionComplete INTEGER NOT NULL,
  extractionPlan TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE (importId, policyRevision, promptVersion, run)
);
CREATE INDEX jobs_status ON jobs(status, nextAttemptAt);
CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  logicalId TEXT NOT NULL,
  jobId TEXT NOT NULL,
  importId TEXT NOT NULL,
  projectId TEXT NOT NULL,
  status TEXT NOT NULL,
  operationId TEXT,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX candidates_job ON candidates(jobId, createdAt);
CREATE INDEX candidates_import ON candidates(importId, createdAt);
CREATE INDEX candidates_project ON candidates(projectId, createdAt);
CREATE TABLE candidate_revisions (
  candidateId TEXT NOT NULL,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (candidateId, version)
);
CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  candidateId TEXT NOT NULL,
  projectId TEXT NOT NULL,
  contentKey TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  notebookId TEXT NOT NULL,
  path TEXT NOT NULL,
  documentId TEXT NOT NULL,
  blockId TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX operations_project ON operations(projectId, createdAt);
CREATE TABLE mental_cards (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  revision INTEGER NOT NULL,
  baseRevision INTEGER NOT NULL,
  status TEXT NOT NULL,
  author TEXT NOT NULL,
  candidateId TEXT,
  data TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX mental_cards_project ON mental_cards(projectId, createdAt);
CREATE UNIQUE INDEX mental_cards_active ON mental_cards(projectId, revision) WHERE status = 'active';
CREATE TABLE audits (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  targetId TEXT NOT NULL,
  detail TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX audits_created ON audits(createdAt);
CREATE TABLE source_health (
  path TEXT PRIMARY KEY,
  checkedAt TEXT NOT NULL,
  imported INTEGER NOT NULL,
  error TEXT
);
`;

interface SettingsRow {
  revision: number;
  data: string;
  createdAt: string;
}

interface ImportRow {
  id: string;
  sourceKey: string;
  revision: string;
  rawDigest: string;
  conversation: string;
  createdAt: string;
}

interface MessageRow {
  messageKey: string;
  revision: string;
}

interface RawSnapshotRow {
  importId: string;
  rawDigest: string;
  sourceLocator: string;
  receivedAt: string;
}

interface RevisionMessageRow {
  ordinal: number;
  messageKey: string;
  messageRevision: string;
}

interface CandidateRevisionRow {
  version: number;
  data: string;
  createdAt: string;
}

/**
 * 觀測用結構。與 `../contracts/index.ts` 的 DTO 不同，這些只描述本儲存層的關聯表，
 * 不對外發布，因此僅在讀取時以這裡的 schema 驗證，不使用型別斷言。
 */
const rawSnapshotSchema = z.object({
  importId: id,
  rawDigest: id,
  sourceLocator: z.string().max(4096).nullable(),
  receivedAt: isoTime,
});
export type RawSnapshot = z.infer<typeof rawSnapshotSchema>;

const revisionMessageSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  messageKey: id,
  messageRevision: id,
});
export type RevisionMessage = z.infer<typeof revisionMessageSchema>;

const candidateRevisionSchema = z.object({
  version: z.number().int().positive(),
  candidate: candidateSchema,
  createdAt: isoTime,
});
export type CandidateRevision = z.infer<typeof candidateRevisionSchema>;

const messageRevisionRowSchema = z.object({ messageKey: id, revision: id });
export type MessageRevisionRow = z.infer<typeof messageRevisionRowSchema>;

interface JobRow {
  id: string;
  importId: string;
  policyRevision: number;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  error: string | null;
  nextSegment: number;
  extractionComplete: number;
  extractionPlan: string | null;
  run: number;
  createdAt: string;
  updatedAt: string;
}

interface DocumentRow {
  id: string;
  data: string;
}

interface MentalRow {
  id: string;
  projectId: string;
  revision: number;
  data: string;
}

interface AuditRow {
  id: string;
  action: string;
  targetId: string;
  detail: string;
  createdAt: string;
}

interface HealthRow {
  path: string;
  checkedAt: string;
  imported: number;
  error: string | null;
}

interface ImportKeyRow {
  id: string;
  revision: string;
}

function notFound(kind: string, id: string): never {
  throw new AppError("not_found", `找不到${kind}（${id}）。`, false, 404);
}

/**
 * 讀取 job 的 SQLite 列。`promptVersion` 是索引欄位，不屬於對外 DTO。
 */
function readJob(row: JobRow): Job {
  return jobSchema.parse({
    id: row.id,
    importId: row.importId,
    policyRevision: row.policyRevision,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    error: row.error === null ? null : JSON.parse(row.error),
    nextSegment: row.nextSegment,
    extractionComplete: row.extractionComplete === 1,
    extractionPlan: row.extractionPlan,
    run: row.run,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

/**
 * 持久化儲存。所有寫入皆以同步交易完成；任何非同步等待（檔案落盤、網路）
 * 一律發生在交易之外，交易內不得出現 await。
 */
export class Store {
  readonly dataDir: string;
  readonly rawDir: string;
  private readonly dbPath: string;
  private readonly db: Database;
  private closed = false;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.rawDir = join(dataDir, "raw");
    this.dbPath = join(dataDir, "store.sqlite");

    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    chmodSync(this.dataDir, 0o700);
    mkdirSync(this.rawDir, { recursive: true, mode: 0o700 });
    chmodSync(this.rawDir, 0o700);

    this.db = new Database(this.dbPath);
    try {
      chmodSync(this.dbPath, 0o600);
      this.db.run("PRAGMA journal_mode = WAL");
      this.db.run("PRAGMA busy_timeout = 5000");
      this.db.run("PRAGMA synchronous = FULL");
      this.protectSidecarFiles();
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  // ---------------------------------------------------------------- 交易

  /**
   * 同步交易。回呼若回傳 Promise 立即回滾並報錯，避免交易跨越 await。
   */
  private tx<T>(work: () => T): T {
    this.db.run("BEGIN IMMEDIATE");
    try {
      const result = work();
      if (result instanceof Promise) {
        throw new AppError("storage_transaction_async", "資料庫交易不可跨越非同步等待。");
      }
      this.db.run("COMMIT");
      return result;
    } catch (error) {
      this.rollbackQuietly();
      throw error;
    }
  }

  private rollbackQuietly(): void {
    try {
      this.db.run("ROLLBACK");
    } catch {
      // 交易已由 SQLite 結束，無需再回滾。
    }
  }

  /**
   * 唯一鍵碰撞代表身分已被佔用，不吞掉也不覆寫他人紀錄。
   */
  private rethrowConflict(error: unknown, what: string): never {
    if (error instanceof SQLiteError && error.code?.startsWith("SQLITE_CONSTRAINT")) {
      throw new AppError("storage_conflict", `${what}與既有紀錄衝突，未覆寫既有內容。`, false, 409);
    }
    throw error;
  }

  private protectSidecarFiles(): void {
    for (const suffix of ["-wal", "-shm"]) {
      const file = `${this.dbPath}${suffix}`;
      if (existsSync(file)) chmodSync(file, 0o600);
    }
  }

  private migrate(): void {
    const row = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get();
    const version = row?.user_version ?? 0;
    if (version > SCHEMA_VERSION) {
      throw new AppError(
        "storage_schema_newer",
        "資料庫結構版本高於本程式支援的版本，已停止啟動以免損毀既有資料。",
      );
    }
    if (version < SCHEMA_VERSION) {
      this.tx(() => {
        this.db.run(SCHEMA_V1);
        this.db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        this.db
          .query("INSERT INTO settings (revision, data, createdAt) VALUES (?, ?, ?)")
          .run(0, JSON.stringify(defaultSettings()), now());
      });
      this.protectSidecarFiles();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // -------------------------------------------------------------- 原始快照

  /**
   * 以內容摘要命名的不可變原始快照。相同摘要代表相同內容，不覆寫既有檔案；
   * 每 15 秒重掃相同來源時只核對既有快照的完整性，不重寫同樣的位元組。
   */
  private async persistRaw(rawDigest: string, content: string): Promise<void> {
    const target = join(this.rawDir, `${rawDigest}.raw`);
    try {
      if (digest(await readFile(target, "utf8")) !== rawDigest) {
        throw new AppError("raw_corrupt", "原始快照完整性檢查失敗，未建立工作。");
      }
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const temporary = join(this.rawDir, `.incoming-${newId()}`);
    const file = await open(temporary, "wx", 0o600);
    try {
      try {
        await file.writeFile(content, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, target);
        const directory = await open(this.rawDir, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        if (digest(await readFile(target, "utf8")) !== rawDigest) {
          throw new AppError("raw_corrupt", "原始快照完整性檢查失敗，未建立工作。");
        }
      }
    } finally {
      await unlink(temporary);
    }
  }

  // ---------------------------------------------------------------- 設定

  settings(revision?: number): Settings {
    const row =
      revision === undefined
        ? this.db
            .query<SettingsRow, []>(
              "SELECT revision, data, createdAt FROM settings ORDER BY revision DESC LIMIT 1",
            )
            .get()
        : this.db
            .query<SettingsRow, [number]>(
              "SELECT revision, data, createdAt FROM settings WHERE revision = ?",
            )
            .get(revision);
    if (!row) {
      notFound("設定版本", revision === undefined ? "最新" : String(revision));
    }
    return settingsSchema.parse(JSON.parse(row.data));
  }

  saveSettings(input: Settings): Settings {
    const parsed = settingsSchema.parse(input);
    return this.tx(() => {
      const current = this.db
        .query<{ revision: number }, []>(
          "SELECT revision FROM settings ORDER BY revision DESC LIMIT 1",
        )
        .get();
      const currentRevision = current?.revision ?? 0;
      if (parsed.revision !== currentRevision) {
        throw new AppError(
          "settings_conflict",
          `設定已變更為第 ${currentRevision} 版，請以最新版本重新儲存。`,
          false,
          409,
        );
      }
      const nextRevision = currentRevision + 1;
      const saved: Settings = settingsSchema.parse({ ...parsed, revision: nextRevision });
      try {
        this.db
          .query("INSERT INTO settings (revision, data, createdAt) VALUES (?, ?, ?)")
          .run(nextRevision, JSON.stringify(saved), now());
      } catch (error) {
        this.rethrowConflict(error, "設定版本");
      }
      this.insertAudit(
        "settings.saved",
        String(nextRevision),
        `設定由第 ${currentRevision} 版更新為第 ${nextRevision} 版。`,
      );
      return saved;
    });
  }

  // -------------------------------------------------------------- 匯入來源

  private importRowByRevision(sourceKey: string, revision: string): ImportRow | null {
    return this.db
      .query<ImportRow, [string, string]>(
        "SELECT id, sourceKey, revision, rawDigest, conversation, createdAt FROM imports WHERE sourceKey = ? AND revision = ?",
      )
      .get(sourceKey, revision);
  }

  private importFromRow(row: ImportRow): ImportRecord {
    return importRecordSchema.parse({
      id: row.id,
      sourceKey: row.sourceKey,
      revision: row.revision,
      rawDigest: row.rawDigest,
      conversation: JSON.parse(row.conversation),
      createdAt: row.createdAt,
    });
  }

  private insertImport(record: ImportRecord, conversation: Conversation): void {
    try {
      this.db
        .query(
          "INSERT INTO imports (id, sourceKey, revision, rawDigest, projectId, source, sourceSessionId, conversation, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          record.id,
          record.sourceKey,
          record.revision,
          record.rawDigest,
          conversation.projectId,
          conversation.source,
          conversation.sourceSessionId,
          JSON.stringify(conversation),
          record.createdAt,
        );
    } catch (error) {
      this.rethrowConflict(error, "匯入來源版本");
    }
  }

  /**
   * 保存每個來源訊息的版本。既有列永不覆寫；相同鍵與版本代表相同內容。
   * 此表是去重後的不可變訊息版本，與「哪一次匯入包含哪些訊息」分開保存。
   */
  private writeMessageRevisions(record: ImportRecord, conversation: Conversation): void {
    const statement = this.db.query(
      "INSERT INTO message_revisions (messageKey, revision, sourceKey, sourceMessageId, message, createdAt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(messageKey, revision) DO NOTHING",
    );
    const membership = this.db.query(
      "INSERT INTO import_revision_messages (importId, ordinal, messageKey, messageRevision) VALUES (?, ?, ?, ?)",
    );
    const createdAt = now();
    conversation.messages.forEach((message, ordinal) => {
      const messageKey = messageKeyOf(record.sourceKey, message.sourceMessageId);
      const revision = messageRevisionOf(message);
      statement.run(
        messageKey,
        revision,
        record.sourceKey,
        message.sourceMessageId,
        JSON.stringify(message),
        createdAt,
      );
      membership.run(record.id, ordinal, messageKey, revision);
    });
  }

  /**
   * 記錄這次實際收到的原始位元組。同一匯入、同一摘要與來源定位只保留首次接收時間，
   * 因此每 15 秒重掃相同來源不會累積重複的觀測列；不同位元組則各自成為一列。
   */
  private recordRawSnapshot(
    importId: string,
    rawDigest: string,
    sourceLocator: string | null,
  ): void {
    this.db
      .query(
        "INSERT INTO raw_snapshots (importId, rawDigest, sourceLocator, receivedAt) VALUES (?, ?, ?, ?) ON CONFLICT(importId, rawDigest, sourceLocator) DO NOTHING",
      )
      .run(importId, rawDigest, sourceLocator ?? "", now());
  }

  messageRevisions(sourceKey: string): MessageRevisionRow[] {
    return this.db
      .query<MessageRow, [string]>(
        "SELECT messageKey, revision FROM message_revisions WHERE sourceKey = ? ORDER BY messageKey, revision",
      )
      .all(sourceKey)
      .map((row) => messageRevisionRowSchema.parse(row));
  }

  /**
   * 該次匯入實際收到過的原始快照，依接收時間排序。空字串代表來源未提供定位資訊。
   */
  snapshots(importId: string): RawSnapshot[] {
    return this.db
      .query<RawSnapshotRow, [string]>(
        "SELECT importId, rawDigest, sourceLocator, receivedAt FROM raw_snapshots WHERE importId = ? ORDER BY receivedAt, rawDigest",
      )
      .all(importId)
      .map((row) =>
        rawSnapshotSchema.parse({
          importId: row.importId,
          rawDigest: row.rawDigest,
          sourceLocator: row.sourceLocator === "" ? null : row.sourceLocator,
          receivedAt: row.receivedAt,
        }),
      );
  }

  /**
   * 該次匯入的訊息 membership，依來源順序。未變更的訊息會以相同版本重複出現在後續匯入中。
   */
  revisionMessages(importId: string): RevisionMessage[] {
    return this.db
      .query<RevisionMessageRow, [string]>(
        "SELECT ordinal, messageKey, messageRevision FROM import_revision_messages WHERE importId = ? ORDER BY ordinal",
      )
      .all(importId)
      .map((row) => revisionMessageSchema.parse(row));
  }

  /**
   * 匯入正規化對話。原始快照先落盤，再以單一交易寫入資料庫。
   *
   * 同一來源版本重複匯入只記錄這次實際收到的原始位元組與來源定位，並回傳該匯入既有的
   * 最新工作；設定版本變更不會因此自動產生新的執行，只有明示的 reprocess 才會。
   */
  async ingest(
    request: ImportRequest,
    conversation: Conversation,
  ): Promise<{ import: ImportRecord; job: Job; duplicate: boolean }> {
    const parsedRequest = importRequestSchema.parse(request);
    const parsedConversation = conversationSchema.parse(conversation);
    const sourceKey = sourceKeyOf(
      parsedConversation.source,
      parsedConversation.sourceSessionId,
      parsedConversation.projectId,
    );
    const revision = revisionOf(parsedConversation);
    const rawDigest = digest(parsedRequest.content);
    const sourceLocator = parsedRequest.sourceLocator ?? parsedConversation.sourceLocator;

    await this.persistRaw(rawDigest, parsedRequest.content);

    return this.tx(() => {
      const existing = this.importRowByRevision(sourceKey, revision);
      if (existing) {
        const record = this.importFromRow(existing);
        this.recordRawSnapshot(record.id, rawDigest, sourceLocator);
        return {
          import: record,
          job: this.createJobInTx(record.id, false),
          duplicate: true,
        };
      }
      const record: ImportRecord = importRecordSchema.parse({
        id: newId(),
        sourceKey,
        revision,
        rawDigest,
        conversation: parsedConversation,
        createdAt: now(),
      });
      this.insertImport(record, parsedConversation);
      this.writeMessageRevisions(record, parsedConversation);
      this.recordRawSnapshot(record.id, rawDigest, sourceLocator);
      this.insertAudit(
        "import.ingested",
        record.id,
        `來源 ${parsedConversation.source} 專案 ${parsedConversation.projectId} 共 ${parsedConversation.messages.length} 則訊息。`,
      );
      return { import: record, job: this.createJobInTx(record.id, false), duplicate: false };
    });
  }

  getImport(importId: string): ImportRecord {
    const row = this.db
      .query<ImportRow, [string]>(
        "SELECT id, sourceKey, revision, rawDigest, conversation, createdAt FROM imports WHERE id = ?",
      )
      .get(importId);
    if (!row) notFound("匯入紀錄", importId);
    return this.importFromRow(row);
  }

  // ------------------------------------------------------------------ 工作

  /**
   * 交易內建立或取得工作。
   *
   * `forceNewRun` 為 false 時只回傳該匯入既有的最新執行；設定版本變更不會產生新的執行，
   * 只有明示的 reprocess（`forceNewRun`）才會以目前政策建立新的 run。
   */
  private createJobInTx(importId: string, forceNewRun: boolean): Job {
    const importRow = this.db
      .query<ImportKeyRow, [string]>("SELECT id, revision FROM imports WHERE id = ?")
      .get(importId);
    if (!importRow) notFound("匯入紀錄", importId);

    if (!forceNewRun) {
      const row = this.db
        .query<JobRow, [string]>(
          "SELECT id, importId, policyRevision, status, attempts, nextAttemptAt, error, nextSegment, extractionComplete, extractionPlan, run, createdAt, updatedAt FROM jobs WHERE importId = ? ORDER BY rowid DESC LIMIT 1",
        )
        .get(importId);
      if (row) return readJob(row);
    }

    const settingsRow = this.db
      .query<{ revision: number }, []>(
        "SELECT revision FROM settings ORDER BY revision DESC LIMIT 1",
      )
      .get();
    const policyRevision = settingsRow?.revision ?? 0;

    const latest = this.db
      .query<{ run: number }, [string, number, string]>(
        "SELECT run FROM jobs WHERE importId = ? AND policyRevision = ? AND promptVersion = ? ORDER BY run DESC LIMIT 1",
      )
      .get(importId, policyRevision, PROMPT_VERSION);

    const run = latest ? latest.run + 1 : 0;
    const timestamp = now();
    const job: Job = jobSchema.parse({
      id: newId(),
      importId,
      policyRevision,
      status: "queued",
      attempts: 0,
      nextAttemptAt: null,
      error: null,
      nextSegment: 0,
      extractionComplete: false,
      run,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    try {
      this.insertJobRow(job);
    } catch (error) {
      this.rethrowConflict(error, "工作執行");
    }
    return job;
  }

  private insertJobRow(job: Job): void {
    this.db
      .query(
        "INSERT INTO jobs (id, importId, policyRevision, promptVersion, run, status, attempts, nextAttemptAt, error, nextSegment, extractionComplete, extractionPlan, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        job.id,
        job.importId,
        job.policyRevision,
        PROMPT_VERSION,
        job.run,
        job.status,
        job.attempts,
        job.nextAttemptAt,
        job.error === null ? null : JSON.stringify(job.error),
        job.nextSegment,
        job.extractionComplete ? 1 : 0,
        job.extractionPlan,
        job.createdAt,
        job.updatedAt,
      );
  }

  /**
   * 取得或建立工作。`forceNewRun` 為 false 時回傳該匯入既有的最新執行；
   * `forceNewRun` 為 true 才是明示的重新處理，以目前政策建立新的一次執行，
   * 保留既有執行的候選與判斷歷史。
   */
  createJob(importId: string, forceNewRun = false): Job {
    return this.tx(() => this.createJobInTx(importId, forceNewRun));
  }

  jobs(): Job[] {
    return this.db
      .query<JobRow, []>(
        "SELECT id, importId, policyRevision, status, attempts, nextAttemptAt, error, nextSegment, extractionComplete, extractionPlan, run, createdAt, updatedAt FROM jobs ORDER BY rowid DESC",
      )
      .all()
      .map(readJob);
  }

  getJob(jobId: string): Job {
    const row = this.db
      .query<JobRow, [string]>(
        "SELECT id, importId, policyRevision, status, attempts, nextAttemptAt, error, nextSegment, extractionComplete, extractionPlan, run, createdAt, updatedAt FROM jobs WHERE id = ?",
      )
      .get(jobId);
    if (!row) notFound("工作", jobId);
    return readJob(row);
  }

  saveJob(job: Job): void {
    const parsed = jobSchema.parse(job);
    const stored = this.getJob(parsed.id);
    for (const key of ["importId", "policyRevision", "run", "createdAt"] as const) {
      if (parsed[key] !== stored[key])
        throw new AppError("job_identity_immutable", "工作身分不可改變。", false, 409);
    }
    if (
      parsed.nextSegment < stored.nextSegment ||
      (stored.extractionComplete && !parsed.extractionComplete) ||
      (stored.extractionPlan !== null && parsed.extractionPlan !== stored.extractionPlan) ||
      (stored.extractionPlan === null && parsed.extractionPlan !== null && stored.nextSegment !== 0)
    ) {
      throw new AppError(
        "job_checkpoint_conflict",
        "抽取計畫不可更換，已完成進度不可倒退。",
        false,
        409,
      );
    }
    this.db
      .query(
        "UPDATE jobs SET status = ?, attempts = ?, nextAttemptAt = ?, error = ?, nextSegment = ?, extractionComplete = ?, extractionPlan = ?, updatedAt = ? WHERE id = ?",
      )
      .run(
        parsed.status,
        parsed.attempts,
        parsed.nextAttemptAt,
        parsed.error === null ? null : JSON.stringify(parsed.error),
        parsed.nextSegment,
        parsed.extractionComplete ? 1 : 0,
        parsed.extractionPlan,
        parsed.updatedAt,
        parsed.id,
      );
  }

  // ------------------------------------------------------------------ 候選

  candidates(jobId?: string): Candidate[] {
    const rows =
      jobId === undefined
        ? this.db
            .query<DocumentRow, []>("SELECT id, data FROM candidates ORDER BY rowid DESC")
            .all()
        : this.db
            .query<DocumentRow, [string]>(
              "SELECT id, data FROM candidates WHERE jobId = ? ORDER BY rowid DESC",
            )
            .all(jobId);
    return rows.map((row) => candidateSchema.parse(JSON.parse(row.data)));
  }

  getCandidate(candidateId: string): Candidate {
    const row = this.db
      .query<DocumentRow, [string]>("SELECT id, data FROM candidates WHERE id = ?")
      .get(candidateId);
    if (!row) notFound("候選", candidateId);
    return candidateSchema.parse(JSON.parse(row.data));
  }

  saveCandidate(candidate: Candidate): void {
    const parsed = candidateSchema.parse(candidate);
    try {
      this.tx(() => this.writeCandidate(parsed));
    } catch (error) {
      this.rethrowConflict(error, "候選");
    }
  }

  /**
   * 同一段的所有候選與 checkpoint 一起落盤，供 worker 在模型輸出後一次提交。
   *
   * - 先驗證所有候選都屬於同一件工作與匯入，避免跨批混合。
   * - `job.nextSegment` 是提交後的目標進度，必須恰好比已落盤進度多一格；
   *   交易內保存全部候選後才寫入這個 checkpoint，任何錯誤整段回滾。
   * - 已提交的 cursor 不接受任何重送；呼叫端必須重新讀取並從下一段繼續。
   *
   * 同一段允許相同 `logicalId` 的多個獨立候選：同一引文可支持不同結論，
   * 由本方法的一次交易保證不會只落盤一半。
   */
  commitExtractionSegment(job: Job, candidates: Candidate[]): Job {
    const parsedJob = jobSchema.parse(job);
    const parsedCandidates = candidates.map((candidate) => candidateSchema.parse(candidate));
    for (const candidate of parsedCandidates) {
      if (candidate.jobId !== parsedJob.id || candidate.importId !== parsedJob.importId) {
        throw new AppError(
          "candidate_job_mismatch",
          "候選與目標工作不符，已阻止整段保存。",
          false,
          409,
        );
      }
    }
    return this.tx(() => {
      const stored = this.getJob(parsedJob.id);
      if (
        !stored.extractionPlan ||
        stored.extractionComplete ||
        parsedJob.extractionPlan !== stored.extractionPlan ||
        parsedJob.importId !== stored.importId ||
        parsedJob.policyRevision !== stored.policyRevision ||
        parsedJob.run !== stored.run
      ) {
        throw new AppError(
          "segment_plan_conflict",
          "分段必須屬於已保存的工作與抽取計畫。",
          false,
          409,
        );
      }
      if (stored.nextSegment !== parsedJob.nextSegment - 1) {
        throw new AppError(
          "segment_checkpoint_stale",
          "分段進度與已保存的結果不一致，請重新讀取工作後再保存。",
          false,
          409,
        );
      }
      for (const candidate of parsedCandidates) this.writeCandidate(candidate);
      this.saveJob(parsedJob);
      return parsedJob;
    });
  }

  /**
   * 候選的唯一寫入路徑：首次插入固化跨執行身分，之後只接受同版本重送或版本遞增。
   * 每個版本同時追加到 append-only 的 `candidate_revisions`，投影列只反映最新版本。
   */
  private writeCandidate(parsed: Candidate): void {
    const existing = this.db
      .query<{ version: number; data: string }, [string]>(
        "SELECT version, data FROM candidates WHERE id = ?",
      )
      .get(parsed.id);
    if (!existing) {
      if (parsed.version !== 1) {
        throw new AppError(
          "candidate_version_invalid",
          "新候選的第一個版本必須是第 1 版。",
          false,
          409,
        );
      }
      this.insertCandidateProjection(parsed);
      this.appendCandidateRevision(parsed);
      return;
    }
    const stored = candidateSchema.parse(JSON.parse(existing.data));
    const identityFields = ["logicalId", "jobId", "importId", "projectId", "createdAt"] as const;
    for (const field of identityFields) {
      if (stored[field] !== parsed[field]) {
        throw new AppError(
          "candidate_identity_immutable",
          `候選的 ${field} 不可變更，已拒絕寫入。`,
          false,
          409,
        );
      }
    }
    if (parsed.version === stored.version) {
      if (JSON.stringify(stored) === JSON.stringify(parsed)) return;
      throw new AppError(
        "candidate_version_stale",
        `候選第 ${stored.version} 版已存在不同內容，請以遞增版本寫入。`,
        false,
        409,
      );
    }
    if (parsed.version !== stored.version + 1) {
      throw new AppError(
        "candidate_version_stale",
        `候選目前是第 ${stored.version} 版，僅接受第 ${stored.version + 1} 版。`,
        false,
        409,
      );
    }
    this.insertCandidateProjection(parsed);
    this.appendCandidateRevision(parsed);
  }

  private insertCandidateProjection(parsed: Candidate): void {
    this.db
      .query(
        "INSERT INTO candidates (id, logicalId, jobId, importId, projectId, status, operationId, version, data, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET logicalId = excluded.logicalId, jobId = excluded.jobId, importId = excluded.importId, projectId = excluded.projectId, status = excluded.status, operationId = excluded.operationId, version = excluded.version, data = excluded.data, createdAt = excluded.createdAt, updatedAt = excluded.updatedAt",
      )
      .run(
        parsed.id,
        parsed.logicalId,
        parsed.jobId,
        parsed.importId,
        parsed.projectId,
        parsed.status,
        parsed.operationId,
        parsed.version,
        JSON.stringify(parsed),
        parsed.createdAt,
        parsed.updatedAt,
      );
  }

  private appendCandidateRevision(parsed: Candidate): void {
    this.db
      .query(
        "INSERT INTO candidate_revisions (candidateId, version, data, createdAt) VALUES (?, ?, ?, ?)",
      )
      .run(parsed.id, parsed.version, JSON.stringify(parsed), parsed.updatedAt);
  }

  /**
   * 候選的完整版本歷史，依版本遞增。投影列只保留最新版本，歷史不被覆寫。
   */
  candidateRevisions(candidateId: string): CandidateRevision[] {
    return this.db
      .query<CandidateRevisionRow, [string]>(
        "SELECT version, data, createdAt FROM candidate_revisions WHERE candidateId = ? ORDER BY version",
      )
      .all(candidateId)
      .map((row) =>
        candidateRevisionSchema.parse({
          version: row.version,
          candidate: JSON.parse(row.data),
          createdAt: row.createdAt,
        }),
      );
  }

  // ------------------------------------------------------------------ 操作

  operations(): Operation[] {
    return this.db
      .query<DocumentRow, []>("SELECT id, data FROM operations ORDER BY rowid DESC")
      .all()
      .map((row) => operationSchema.parse(JSON.parse(row.data)));
  }

  findOperation(contentKey: string): Operation | null {
    const row = this.db
      .query<DocumentRow, [string]>("SELECT id, data FROM operations WHERE contentKey = ?")
      .get(contentKey);
    return row ? operationSchema.parse(JSON.parse(row.data)) : null;
  }

  getOperation(operationId: string): Operation {
    const row = this.db
      .query<DocumentRow, [string]>("SELECT id, data FROM operations WHERE id = ?")
      .get(operationId);
    if (!row) notFound("發布操作", operationId);
    return operationSchema.parse(JSON.parse(row.data));
  }

  /**
   * 保存發布操作。
   *
   * 首次插入固化整個計畫（目標、內容與識別）；同一 `id` 之後只允許合法狀態轉移，
   * 任何計畫欄位變更、退回 `planned` 或簽收消失一律 409。合法轉移：
   * `planned`→`sent`/`uncertain`/`verified`/`conflict`；`sent`、`uncertain`→`sent`/`uncertain`/`verified`/`conflict`；
   * `verified`→`verified`/`conflict`/`undoing`；`undoing`→`undoing`/`undone`/`conflict`；
   * `undone`→`undone`；`conflict`→`conflict`。
   */
  saveOperation(operation: Operation): void {
    const parsed = operationSchema.parse(operation);
    try {
      this.tx(() => this.writeOperation(parsed));
    } catch (error) {
      this.rethrowConflict(error, "發布操作");
    }
  }

  private static readonly ALLOWED_TRANSITIONS: Record<string, Operation["status"][]> = {
    planned: ["planned", "sent", "uncertain", "verified", "conflict"],
    sent: ["sent", "uncertain", "verified", "conflict"],
    uncertain: ["uncertain", "sent", "verified", "conflict"],
    verified: ["verified", "conflict", "undoing"],
    undoing: ["undoing", "undone", "conflict"],
    undone: ["undone"],
    conflict: ["conflict"],
  };

  /**
   * 唯一寫入路徑，確保索引欄位與 DTO 本體永遠一致，並讀取目前列後才同步更新。
   */
  private writeOperation(parsed: Operation): void {
    const existing = this.db
      .query<{ data: string }, [string]>("SELECT data FROM operations WHERE id = ?")
      .get(parsed.id);
    if (!existing && (parsed.status !== "planned" || parsed.receipt !== null)) {
      throw new AppError(
        "operation_plan_required",
        "外部寫入前必須先保存尚未送出且沒有回條的計畫。",
        false,
        409,
      );
    }
    if (["verified", "undoing", "undone"].includes(parsed.status) && parsed.receipt === null) {
      throw new AppError(
        "operation_receipt_required",
        "已驗證或撤回中的操作必須保留讀回憑證。",
        false,
        409,
      );
    }
    if (existing) {
      const stored = operationSchema.parse(JSON.parse(existing.data));
      if (JSON.stringify(stored.expectedAttributes) !== JSON.stringify(parsed.expectedAttributes)) {
        throw new AppError("operation_plan_immutable", "預定的應用屬性不可變更。", false, 409);
      }
      if (stored.receipt === null && parsed.receipt !== null && parsed.status !== "verified") {
        throw new AppError(
          "operation_receipt_invalid",
          "只有已驗證讀回時才能首次保存回條。",
          false,
          409,
        );
      }
      const planFields: (keyof Operation)[] = [
        "candidateId",
        "projectId",
        "contentKey",
        "kind",
        "notebookId",
        "path",
        "rootPath",
        "topic",
        "documentId",
        "blockId",
        "markdown",
        "createdAt",
      ];
      for (const field of planFields) {
        if (stored[field] !== parsed[field]) {
          throw new AppError(
            "operation_plan_immutable",
            `發布操作的 ${String(field)} 不可變更，已拒絕寫入。`,
            false,
            409,
          );
        }
      }
      const receiptChanged =
        stored.receipt !== null &&
        JSON.stringify(stored.receipt) !== JSON.stringify(parsed.receipt);
      if (receiptChanged) {
        throw new AppError(
          "operation_receipt_immutable",
          "發布操作一旦取得簽收即不可改寫，已拒絕寫入。",
          false,
          409,
        );
      }
      if (!Store.ALLOWED_TRANSITIONS[stored.status]?.includes(parsed.status)) {
        throw new AppError(
          "operation_transition_denied",
          `發布操作不可由「${stored.status}」轉為「${parsed.status}」。`,
          false,
          409,
        );
      }
    }
    this.db
      .query(
        "INSERT INTO operations (id, candidateId, projectId, contentKey, kind, notebookId, path, documentId, blockId, status, data, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET candidateId = excluded.candidateId, projectId = excluded.projectId, contentKey = excluded.contentKey, kind = excluded.kind, notebookId = excluded.notebookId, path = excluded.path, documentId = excluded.documentId, blockId = excluded.blockId, status = excluded.status, data = excluded.data, createdAt = excluded.createdAt, updatedAt = excluded.updatedAt",
      )
      .run(
        parsed.id,
        parsed.candidateId,
        parsed.projectId,
        parsed.contentKey,
        parsed.kind,
        parsed.notebookId,
        parsed.path,
        parsed.documentId,
        parsed.blockId,
        parsed.status,
        JSON.stringify(parsed),
        parsed.createdAt,
        parsed.updatedAt,
      );
  }

  // ---------------------------------------------------------------- 心智卡

  private activeMentalRow(projectId: string): MentalRow | null {
    return this.db
      .query<MentalRow, [string]>(
        "SELECT id, projectId, revision, data FROM mental_cards WHERE projectId = ? AND status = 'active' ORDER BY revision DESC LIMIT 1",
      )
      .get(projectId);
  }

  mentalCards(projectId?: string): MentalCard[] {
    const rows =
      projectId === undefined
        ? this.db
            .query<DocumentRow, []>("SELECT id, data FROM mental_cards ORDER BY rowid DESC")
            .all()
        : this.db
            .query<DocumentRow, [string]>(
              "SELECT id, data FROM mental_cards WHERE projectId = ? ORDER BY rowid DESC",
            )
            .all(projectId);
    return rows.map((row) => mentalCardSchema.parse(JSON.parse(row.data)));
  }

  activeMental(projectId: string): MentalCard | null {
    const row = this.activeMentalRow(projectId);
    return row ? mentalCardSchema.parse(JSON.parse(row.data)) : null;
  }

  /**
   * 保存心智卡版本。
   *
   * 先判斷是否為既有列：完全相同代表重送已成功的寫入，直接無操作；不同則拒絕覆寫歷史。
   * 生效版本必須是「以現行版本為基準的下一個版本」：`baseRevision` 等於呼叫端預期基準、
   * 也等於現行版本，`revision` 必須緊接現行版本；提案保留歷史基準，不取代生效版本。
   */
  saveMental(card: MentalCard, expectedBase?: number): void {
    const parsed = mentalCardSchema.parse(card);
    this.tx(() => {
      const existing = this.db
        .query<MentalRow, [string]>(
          "SELECT id, projectId, revision, data FROM mental_cards WHERE id = ?",
        )
        .get(parsed.id);
      if (existing) {
        const stored = mentalCardSchema.parse(JSON.parse(existing.data));
        if (JSON.stringify(stored) === JSON.stringify(parsed)) return;
        throw new AppError(
          "mental_immutable",
          "既有心智卡版本不可覆寫，請建立新版本。",
          false,
          409,
        );
      }
      const active = this.activeMentalRow(parsed.projectId);
      const currentRevision = active?.revision ?? 0;
      if (expectedBase !== undefined && expectedBase !== currentRevision) {
        throw new AppError(
          "mental_conflict",
          `專案心智卡已更新為第 ${currentRevision} 版，請以最新版本重新提交。`,
          false,
          409,
        );
      }
      if (parsed.status === "active") {
        if (parsed.baseRevision !== expectedBase || parsed.baseRevision !== currentRevision) {
          throw new AppError(
            "mental_conflict",
            `心智卡生效版本的基準必須是目前第 ${currentRevision} 版。`,
            false,
            409,
          );
        }
        if (parsed.revision !== currentRevision + 1) {
          throw new AppError(
            "mental_conflict",
            `心智卡生效版本必須是第 ${currentRevision + 1} 版。`,
            false,
            409,
          );
        }
      } else if (parsed.baseRevision !== 0) {
        const base = this.db
          .query<{ revision: number }, [string, number]>(
            "SELECT revision FROM mental_cards WHERE projectId = ? AND revision = ? AND status = 'active' LIMIT 1",
          )
          .get(parsed.projectId, parsed.baseRevision);
        if (!base) {
          throw new AppError(
            "mental_conflict",
            `心智卡提案引用了不存在的生效版本 ${parsed.baseRevision}。`,
            false,
            409,
          );
        }
      }
      try {
        this.db
          .query(
            "INSERT INTO mental_cards (id, projectId, revision, baseRevision, status, author, candidateId, data, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            parsed.id,
            parsed.projectId,
            parsed.revision,
            parsed.baseRevision,
            parsed.status,
            parsed.author,
            parsed.candidateId,
            JSON.stringify(parsed),
            parsed.createdAt,
          );
      } catch (error) {
        this.rethrowConflict(error, "心智卡版本");
      }
    });
  }

  // -------------------------------------------------------- 稽核與來源健康

  private insertAudit(action: string, targetId: string, detail: string): void {
    const entry = auditSchema.parse({
      id: newId(),
      action,
      targetId,
      detail,
      createdAt: now(),
    });
    this.db
      .query("INSERT INTO audits (id, action, targetId, detail, createdAt) VALUES (?, ?, ?, ?, ?)")
      .run(entry.id, entry.action, entry.targetId, entry.detail, entry.createdAt);
  }

  audit(action: string, targetId: string, detail: string): void {
    this.tx(() => this.insertAudit(action, targetId, detail));
  }

  audits(): Audit[] {
    return this.db
      .query<AuditRow, []>(
        "SELECT id, action, targetId, detail, createdAt FROM audits ORDER BY rowid DESC",
      )
      .all()
      .map((row) => auditSchema.parse(row));
  }

  sourceHealth(): SourceHealth[] {
    return this.db
      .query<HealthRow, []>(
        "SELECT path, checkedAt, imported, error FROM source_health ORDER BY rowid DESC",
      )
      .all()
      .map((row) => sourceHealthSchema.parse(row));
  }

  saveSourceHealth(health: SourceHealth): void {
    const parsed = sourceHealthSchema.parse(health);
    try {
      this.db
        .query(
          "INSERT INTO source_health (path, checkedAt, imported, error) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET checkedAt = excluded.checkedAt, imported = excluded.imported, error = excluded.error",
        )
        .run(parsed.path, parsed.checkedAt, parsed.imported, parsed.error);
    } catch (error) {
      this.rethrowConflict(error, "來源健康紀錄");
    }
  }

  // ------------------------------------------------------------ 中斷復原

  /**
   * 重啟後的中斷復原。
   *
   * - 讀取與模型階段（extracting/judging/ready/writing）回到 `retry-wait`，保留既有的
   *   分段進度與摘錄完成狀態。
   * - 已送出的寫入（`sent`）結果未知，改記為 `uncertain`，交由對帳處理；
   *   其餘操作狀態原樣保留，已完成的發布與簽收不因重啟而重做或抹除。
   */
  recoverInterrupted(): void {
    this.tx(() => {
      const timestamp = now();
      const rows = this.db
        .query<{ id: string; status: string }, []>(
          "SELECT id, status FROM jobs WHERE status IN ('extracting', 'judging', 'ready', 'writing')",
        )
        .all();
      const updateJob = this.db.query(
        "UPDATE jobs SET status = 'retry-wait', nextAttemptAt = ?, error = ?, updatedAt = ? WHERE id = ?",
      );
      for (const row of rows) {
        updateJob.run(
          timestamp,
          JSON.stringify({
            code: "interrupted",
            message: `工作於「${row.status}」階段被中斷，已排入重試。`,
            stage: row.status,
            retryable: true,
          }),
          timestamp,
          row.id,
        );
      }
      const sentOperations = this.db
        .query<DocumentRow, []>("SELECT id, data FROM operations WHERE status = 'sent'")
        .all();
      for (const row of sentOperations) {
        const operation = operationSchema.parse(JSON.parse(row.data));
        this.writeOperation({ ...operation, status: "uncertain", updatedAt: timestamp });
      }
      if (rows.length > 0) {
        this.insertAudit(
          "recovery.interrupted",
          "jobs",
          `${rows.length} 件進行中的工作已排入重試。`,
        );
      }
    });
  }
}
