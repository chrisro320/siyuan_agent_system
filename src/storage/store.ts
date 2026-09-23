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
  type ErrorInfo,
  type GenerationProfile,
  type GenerationProfileUpdate,
  generationProfileSchema,
  generationProfileUpdateSchema,
  type ImportRecord,
  type ImportRequest,
  id,
  importRecordSchema,
  importRequestSchema,
  isoTime,
  type Job,
  jobSchema,
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
  generationFingerprint,
  messageKeyOf,
  messageRevisionOf,
  newId,
  now,
  revisionOf,
  sourceKeyOf,
} from "./identity.ts";

const SCHEMA_VERSION = 4;

/**
 * 第一版結構。每一條 unique 都對應一種不可混淆的身分：來源版本、工作執行與發布操作。
 *
 * `mental_cards` 是已退役的自動脈絡卡資料表：本版不再有任何讀取或寫入路徑，
 * 保留定義只是為了讓既有的資料庫與新安裝有一致的結構，既有列不會被刪除或改寫。
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
-- 已退役的自動脈絡卡資料表：僅保留既有列，本版沒有任何讀寫路徑。
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

/**
 * 第二版結構：自動擷取的受理回條。
 *
 * `captureId` 由轉接器提供且不可重複使用；同一識別碼只代表一次受理。內容摘要
 * 用來分辨「重送同一份內容」與「拿同一識別碼送不同內容」，後者是衝突而不是更新。
 * 這張表只是受理紀錄：來源身分、版本與發布保護仍由既有的 imports/jobs/operations 決定。
 */
const SCHEMA_V2 = `
CREATE TABLE capture_receipts (
  captureId TEXT PRIMARY KEY,
  payloadDigest TEXT NOT NULL,
  branchLeafId TEXT,
  importId TEXT NOT NULL,
  jobId TEXT NOT NULL,
  projectId TEXT NOT NULL,
  sourceKey TEXT NOT NULL,
  revision TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX capture_receipts_import ON capture_receipts(importId);
`;

/**
 * 第三版結構：發布查詢用的索引。
 *
 * 顯式搜尋以「全文檢索命中的區塊／文件識別碼」查詢已驗證的發布操作，這些索引讓查詢
 * 都是有界的索引查找，而不是掃描全庫的操作。`operations_candidate` 與
 * `candidates_status` 來自已退役的自動脈絡卡查詢，既有的資料庫已經建立；這裡保留
 * 定義讓新舊資料庫的索引集合一致，但目前的執行路徑不再使用它們。
 * 只新增索引，不動任何既有資料。
 */
const SCHEMA_V3 = `
CREATE INDEX operations_block ON operations(blockId);
CREATE INDEX operations_document ON operations(documentId);
CREATE INDEX operations_candidate ON operations(candidateId);
CREATE INDEX candidates_status ON candidates(projectId, status);
`;

/**
 * 第四版結構：生成供應商設定的草稿鏈與每件工作的生成身分。
 *
 * `generation_profiles` 只保存非機密的 profile 草稿（協定／端點／模型／認證模式）與
 * 各自的 revision，憑據、原始回應與模型輸出都不進入此表。它與 `settings` 是兩條
 * 獨立的版本鏈：改供應商不會使 Jev 政策失效，反之亦然。
 *
 * `jobs.generationProfile` 是工作建立時釘住的生成指紋。舊資料庫的既有列在遷移後為
 * `NULL`，代表「不知道原本由哪個供應商產生」；未完成的工作一律視為與目前設定不符而
 * 停止，不會被猜成目前設定。
 */
const SCHEMA_V4 = `
CREATE TABLE generation_profiles (
  revision INTEGER PRIMARY KEY,
  data TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
ALTER TABLE jobs ADD COLUMN generationProfile TEXT;
`;

/**
 * 依序套用的結構遷移。索引 0 對應 `user_version` 1。
 *
 * 新安裝會依序跑完所有版本；既有資料庫只補跑缺少的版本，不會重建或改寫既有資料表。
 */
const MIGRATIONS: readonly ((db: Database) => void)[] = [
  (db) => {
    db.run(SCHEMA_V1);
    db.query("INSERT INTO settings (revision, data, createdAt) VALUES (?, ?, ?)").run(
      0,
      JSON.stringify(defaultSettings()),
      now(),
    );
  },
  (db) => {
    db.run(SCHEMA_V2);
  },
  (db) => {
    db.run(SCHEMA_V3);
  },
  (db) => {
    db.run(SCHEMA_V4);
  },
];

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

/**
 * 自動擷取回條。`payloadDigest` 是受理當下的請求內容摘要：
 * 同一 `captureId` 重送相同內容是重播，換成不同內容則是衝突。
 */
const captureReceiptSchema = z.object({
  captureId: id,
  payloadDigest: id,
  /** 轉接器回報的分支末端訊息；只是受理紀錄的一部分，不參與匯入身分。 */
  branchLeafId: id.nullable(),
  importId: id,
  jobId: id,
  projectId: id,
  sourceKey: id,
  revision: id,
  createdAt: isoTime,
});
export type CaptureReceipt = z.infer<typeof captureReceiptSchema>;

interface JobRow {
  id: string;
  importId: string;
  generationProfile: string | null;
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

interface CaptureRow {
  captureId: string;
  payloadDigest: string;
  branchLeafId: string | null;
  importId: string;
  jobId: string;
  projectId: string;
  sourceKey: string;
  revision: string;
  createdAt: string;
}

interface ImportKeyRow {
  id: string;
  revision: string;
}

/**
 * 一次匯入的來源身分。內容摘要只取請求的原始位元組，來源鍵與版本取自正規化後的對話；
 * 三者在交易外算好，因此交易內只做比對與寫入，不做任何非同步工作。
 */
interface SourceIdentity {
  sourceKey: string;
  revision: string;
  rawDigest: string;
  sourceLocator: string | null;
}

function sourceIdentity(request: ImportRequest, conversation: Conversation): SourceIdentity {
  return {
    sourceKey: sourceKeyOf(
      conversation.source,
      conversation.sourceSessionId,
      conversation.projectId,
    ),
    revision: revisionOf(conversation),
    rawDigest: digest(request.content),
    sourceLocator: request.sourceLocator ?? conversation.sourceLocator,
  };
}

/**
 * 自動擷取的受理結果。
 *
 * - `created`：這次是首次受理，`import`／`job` 與回條在同一交易內建立。
 * - `replay`：同一個 `captureId` 送來相同內容，回覆既有回條，沒有建立任何新紀錄。
 * - `conflict`：同一個 `captureId` 送來不同內容，不覆寫也不建立匯入或工作。
 */
export type CaptureIngestResult =
  | {
      status: "created";
      receipt: CaptureReceipt;
      import: ImportRecord;
      job: Job;
      duplicate: boolean;
    }
  | { status: "replay"; receipt: CaptureReceipt }
  | { status: "conflict"; receipt: CaptureReceipt };

/**
 * 一次發布的現況：候選與操作一起讀出。搜尋端以這個組合判斷資格，
 * 不會只看候選狀態或只看子區塊就決定是否回傳。
 */
export interface PublicationSnapshot {
  candidate: Candidate;
  operation: Operation;
}

interface PublicationRow {
  candidate: string;
  operation: string;
}

function notFound(kind: string, id: string): never {
  throw new AppError("not_found", `找不到${kind}（${id}）。`, false, 404);
}

/**
 * job 的完整欄位清單。所有讀取路徑共用同一份清單，避免新增欄位時漏掉某一條查詢，
 * 讓同一件工作在不同呼叫端出現不同內容。
 */
const JOB_COLUMNS =
  "id, importId, generationProfile, policyRevision, status, attempts, nextAttemptAt, error, nextSegment, extractionComplete, extractionPlan, run, createdAt, updatedAt";

/**
 * 讀取 job 的 SQLite 列。`promptVersion` 是索引欄位，不屬於對外 DTO；
 * `generationProfile` 欄位保存的是生成指紋，對外以 `generationFingerprint` 呈現。
 */
function readJob(row: JobRow): Job {
  return jobSchema.parse({
    id: row.id,
    importId: row.importId,
    generationFingerprint: row.generationProfile,
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
        for (let index = version; index < MIGRATIONS.length; index += 1) {
          const apply = MIGRATIONS[index];
          if (!apply) {
            throw new AppError(
              "storage_migration_missing",
              "資料庫結構遷移不完整，已停止啟動以免留下半套結構。",
            );
          }
          apply(this.db);
        }
        this.db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
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

  // -------------------------------------------------- 生成供應商設定

  /**
   * 開機凍結的生成身分指紋。只在啟動流程設定，且必須在任何工作被建立或執行之前完成；
   * 之後草稿改變也不會影響它，執行中的 worker 與新工作的指紋都以此為準。
   */
  private activeFingerprint: string | null = null;

  /**
   * 凍結目前的生效生成選擇。這是啟動流程的動作，不是使用者操作：
   * 儲存草稿不會呼叫它，因此正在執行與新建立的工作都不會中途被換掉設定。
   */
  activateGeneration(profile: GenerationProfile): void {
    this.activeFingerprint = generationFingerprint(generationProfileSchema.parse(profile));
  }

  /**
   * 生效選擇的指紋，也是新工作釘住的值。尚未啟用時為 `null`：這樣的工作與舊資料庫
   * 留下的未知身分同樣會被視為不符，不會被當成目前設定而誤用。
   */
  activeGenerationFingerprint(): string | null {
    return this.activeFingerprint;
  }

  /** 已保存的生成選擇草稿；沒有草稿時 `null`，代表生效設定是唯一選擇。 */
  stagedGeneration(): { profile: GenerationProfile; revision: number } | null {
    const row = this.db
      .query<{ revision: number; data: string }, []>(
        "SELECT revision, data FROM generation_profiles ORDER BY revision DESC LIMIT 1",
      )
      .get();
    if (!row) return null;
    try {
      return {
        profile: generationProfileSchema.parse(JSON.parse(row.data)),
        revision: row.revision,
      };
    } catch {
      // 讀不出來的草稿不猜測、也不略過：啟動時就必須停下來讓人看見，而不是安靜地
      // 換回上一個供應商。訊息不含列內容，避免把資料庫裡的片段外洩到日誌。
      throw new AppError(
        "generation_profile_corrupt",
        "已保存的生成設定無法解讀，已停止啟動以免誤用其他供應商。",
        false,
        500,
      );
    }
  }

  /**
   * 儲存生成選擇草稿。
   *
   * 以讀取當下的 `revision` 做樂觀鎖；版本鏈與一般設定各自獨立，因此改供應商不會讓
   * Jev 政策失效，反之亦然。寫入的 profile 由呼叫端先正規化，所以同一個選擇不會因
   * 尾斜線或空白等寫法差異而變成另一個版本。這裡只寫草稿：生效設定、既有工作與已
   * 驗證的發布都不會改變。
   */
  saveGenerationProfile(update: GenerationProfileUpdate): {
    profile: GenerationProfile;
    revision: number;
  } {
    const parsed = generationProfileUpdateSchema.parse(update);
    return this.tx(() => {
      const current = this.stagedGeneration()?.revision ?? 0;
      if (parsed.revision !== current) {
        throw new AppError(
          "revision_conflict",
          `生成設定已變更為第 ${current} 版，請重新載入後再儲存。`,
          false,
          409,
        );
      }
      const next = current + 1;
      try {
        this.db
          .query("INSERT INTO generation_profiles (revision, data, createdAt) VALUES (?, ?, ?)")
          .run(next, JSON.stringify(parsed.profile), now());
      } catch (error) {
        this.rethrowConflict(error, "生成設定版本");
      }
      this.insertAudit(
        "generation-profile.saved",
        String(next),
        `生成設定草稿更新為第 ${next} 版，重新啟動後才會生效。`,
      );
      return { profile: parsed.profile, revision: next };
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
    const identity = sourceIdentity(parsedRequest, parsedConversation);

    await this.persistRaw(identity.rawDigest, parsedRequest.content);

    return this.tx(() => this.ingestInTx(parsedConversation, identity));
  }

  /**
   * 交易內的匯入：比對來源版本，寫入匯入、訊息版本與工作。
   *
   * 交易內不得有非同步工作，因此原始位元組由呼叫端在交易外先行耐久落盤；
   * 這也讓上層的擷取受理可以在同一個交易裡再寫入回條。
   */
  private ingestInTx(
    parsedConversation: Conversation,
    identity: SourceIdentity,
  ): { import: ImportRecord; job: Job; duplicate: boolean } {
    const existing = this.importRowByRevision(identity.sourceKey, identity.revision);
    if (existing) {
      const record = this.importFromRow(existing);
      this.recordRawSnapshot(record.id, identity.rawDigest, identity.sourceLocator);
      return {
        import: record,
        job: this.createJobInTx(record.id, false),
        duplicate: true,
      };
    }
    const record: ImportRecord = importRecordSchema.parse({
      id: newId(),
      sourceKey: identity.sourceKey,
      revision: identity.revision,
      rawDigest: identity.rawDigest,
      conversation: parsedConversation,
      createdAt: now(),
    });
    this.insertImport(record, parsedConversation);
    this.writeMessageRevisions(record, parsedConversation);
    this.recordRawSnapshot(record.id, identity.rawDigest, identity.sourceLocator);
    this.insertAudit(
      "import.ingested",
      record.id,
      `來源 ${parsedConversation.source} 專案 ${parsedConversation.projectId} 共 ${parsedConversation.messages.length} 則訊息。`,
    );
    return { import: record, job: this.createJobInTx(record.id, false), duplicate: false };
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

  // ------------------------------------------------------------ 擷取回條

  private captureReceiptRow(captureId: string): CaptureRow | null {
    return (
      this.db
        .query<CaptureRow, [string]>(
          "SELECT captureId, payloadDigest, branchLeafId, importId, jobId, projectId, sourceKey, revision, createdAt FROM capture_receipts WHERE captureId = ?",
        )
        .get(captureId) ?? null
    );
  }

  /**
   * 讀取自動擷取的受理回條。`null` 只代表這個 `captureId` 尚未受理過。
   */
  captureReceipt(captureId: string): CaptureReceipt | null {
    const row = this.captureReceiptRow(captureId);
    return row ? captureReceiptSchema.parse(row) : null;
  }

  /**
   * 受理一次自動擷取：回條、匯入與工作在同一個交易內建立。
   *
   * 邊界與不變條件：
   *
   * - 原始位元組先在交易外耐久落盤。崩潰最多留下一份沒有被任何回條引用的原始快照，
   *   不可能留下沒有回條約束、卻已經可以被抽取與發布的工作。
   * - `captureId` 的比對與匯入、工作的建立同屬一個交易：同一個識別碼的併發送達由
   *   `BEGIN IMMEDIATE` 序列化，落後的那一次只會看到既有回條，不會另外建立匯入或工作。
   * - 同一個識別碼帶著不同內容時不覆寫、也不建立任何新紀錄，由呼叫端回報衝突。
   */
  async ingestCapture(input: {
    captureId: string;
    payloadDigest: string;
    branchLeafId: string | null;
    request: ImportRequest;
    conversation: Conversation;
  }): Promise<CaptureIngestResult> {
    const captureId = id.parse(input.captureId);
    const payloadDigest = id.parse(input.payloadDigest);
    const branchLeafId = input.branchLeafId === null ? null : id.parse(input.branchLeafId);
    const parsedRequest = importRequestSchema.parse(input.request);
    const parsedConversation = conversationSchema.parse(input.conversation);
    const identity = sourceIdentity(parsedRequest, parsedConversation);

    await this.persistRaw(identity.rawDigest, parsedRequest.content);

    return this.tx((): CaptureIngestResult => {
      const existing = this.captureReceiptRow(captureId);
      if (existing) {
        const receipt = captureReceiptSchema.parse(existing);
        return receipt.payloadDigest === payloadDigest
          ? { status: "replay", receipt }
          : { status: "conflict", receipt };
      }
      const result = this.ingestInTx(parsedConversation, identity);
      const receipt = captureReceiptSchema.parse({
        captureId,
        payloadDigest,
        branchLeafId,
        importId: result.import.id,
        jobId: result.job.id,
        projectId: parsedConversation.projectId,
        sourceKey: result.import.sourceKey,
        revision: result.import.revision,
        createdAt: now(),
      });
      this.insertCaptureReceipt(receipt);
      return {
        status: "created",
        receipt,
        import: result.import,
        job: result.job,
        duplicate: result.duplicate,
      };
    });
  }

  private insertCaptureReceipt(receipt: CaptureReceipt): void {
    try {
      this.db
        .query(
          "INSERT INTO capture_receipts (captureId, payloadDigest, branchLeafId, importId, jobId, projectId, sourceKey, revision, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          receipt.captureId,
          receipt.payloadDigest,
          receipt.branchLeafId,
          receipt.importId,
          receipt.jobId,
          receipt.projectId,
          receipt.sourceKey,
          receipt.revision,
          receipt.createdAt,
        );
    } catch (error) {
      this.rethrowConflict(error, "擷取回條");
    }
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
          `SELECT ${JOB_COLUMNS} FROM jobs WHERE importId = ? ORDER BY rowid DESC LIMIT 1`,
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
      // 開機凍結的生成身分：不論是手動匯入、自動擷取或重新處理，都釘住同一個來源。
      generationFingerprint: this.activeGenerationFingerprint(),
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
        "INSERT INTO jobs (id, importId, generationProfile, policyRevision, promptVersion, run, status, attempts, nextAttemptAt, error, nextSegment, extractionComplete, extractionPlan, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        job.id,
        job.importId,
        job.generationFingerprint,
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
      .query<JobRow, []>(`SELECT ${JOB_COLUMNS} FROM jobs ORDER BY rowid DESC`)
      .all()
      .map(readJob);
  }

  getJob(jobId: string): Job {
    const row = this.db
      .query<JobRow, [string]>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`)
      .get(jobId);
    if (!row) notFound("工作", jobId);
    return readJob(row);
  }

  saveJob(job: Job): void {
    const parsed = jobSchema.parse(job);
    const stored = this.getJob(parsed.id);
    for (const key of [
      "importId",
      "generationFingerprint",
      "policyRevision",
      "run",
      "createdAt",
    ] as const) {
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
   * 讀取發布快照。候選與操作在同一筆查詢取出，識別碼清單以 JSON 陣列傳入，
   * 因此查詢只有固定幾個參數，且只走既有的索引，不隨歷史成長。
   */
  private publicationRows(sql: string, params: (string | number)[]): PublicationSnapshot[] {
    return this.db
      .query<PublicationRow, (string | number)[]>(sql)
      .all(...params)
      .map((row) => ({
        operation: operationSchema.parse(JSON.parse(row.operation)),
        candidate: candidateSchema.parse(JSON.parse(row.candidate)),
      }));
  }

  /**
   * 檢索命中對應的已驗證發布：以命中的區塊與文件識別碼為界，並在 SQL 端同時篩選
   * 專案、筆記本、操作狀態與候選狀態。
   *
   * - 命中的文件根不會放大成掃描全庫操作：查詢只走 `operations(blockId)` 與
   *   `operations(documentId)` 索引，識別碼清單本身也有界（查詢詞數 × 每頁命中數）。
   * - 超過 `limit` 時只取最新的幾筆；較舊的命中不另行補查，也不會為了它們擴大請求。
   */
  publicationsForBlocks(
    projectId: string,
    notebookId: string,
    blockIds: readonly string[],
    limit: number,
  ): PublicationSnapshot[] {
    const ids = [...new Set(blockIds)];
    if (ids.length === 0) return [];
    const list = JSON.stringify(ids);
    return this.publicationRows(
      [
        "SELECT o.data AS operation, c.data AS candidate",
        "FROM operations AS o JOIN candidates AS c ON c.id = o.candidateId",
        "WHERE c.projectId = ? AND c.status IN ('published', 'duplicate')",
        "AND o.projectId = ? AND o.notebookId = ? AND o.status = 'verified'",
        "AND (o.blockId IN (SELECT value FROM json_each(?))",
        "OR o.documentId IN (SELECT value FROM json_each(?)))",
        "ORDER BY o.rowid DESC",
        "LIMIT ?",
      ].join(" "),
      [projectId, projectId, notebookId, list, list, limit],
    );
  }

  /**
   * 依操作識別碼重新讀取同一批發布的現況（不做任何狀態篩選）。
   *
   * 搜尋端在最後一次網路等待之後呼叫這個方法，才能發現等待期間的撤回、改歸屬或
   * 候選狀態變更；資格判斷由呼叫端依現況重新做，不會沿用等待前的快照。
   */
  publicationsByOperations(operationIds: readonly string[]): PublicationSnapshot[] {
    const ids = [...new Set(operationIds)];
    if (ids.length === 0) return [];
    return this.publicationRows(
      [
        "SELECT o.data AS operation, c.data AS candidate",
        "FROM operations AS o JOIN candidates AS c ON c.id = o.candidateId",
        "WHERE o.id IN (SELECT value FROM json_each(?))",
      ].join(" "),
      [JSON.stringify(ids)],
    );
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

  /**
   * 開機時停止與目前生效生成指紋不符的未完成工作。
   *
   * - 未完成指 worker 還能續行的狀態，包含尚未開始抽取的 `queued`：即使一則訊息都還沒
   *   送出去，也不能在新設定下繼續。
   * - 舊版資料庫的列在遷移後沒有指紋（`NULL`），代表不知道原本由哪個供應商產生；
   *   一律視為不符，不猜測、也不改寫既有候選或已驗證的發布。
   * - 停止只留下可見的錯誤與稽核紀錄；要改用目前設定必須由使用者明示重新處理，
   *   那會建立新的執行並釘住目前指紋。
   *
   * 呼叫端必須先 `recoverInterrupted`，否則進行中的工作還停在原狀態。
   */
  stopStaleGenerationJobs(): void {
    const fingerprint = this.activeGenerationFingerprint();
    this.tx(() => {
      const stale = this.db
        .query<JobRow, []>(
          `SELECT ${JOB_COLUMNS} FROM jobs WHERE status IN ('queued', 'retry-wait', 'extracting', 'judging', 'ready', 'writing')`,
        )
        .all()
        .map(readJob)
        .filter((job) => job.generationFingerprint !== fingerprint);
      if (stale.length === 0) return;
      const timestamp = now();
      const stop = this.db.query(
        "UPDATE jobs SET status = 'failed', error = ?, nextAttemptAt = NULL, updatedAt = ? WHERE id = ?",
      );
      for (const job of stale) {
        stop.run(
          JSON.stringify({
            code: "generation_config_changed",
            message: "這件工作建立時的生成設定與目前不同，已停止；請重新處理以使用目前設定。",
            stage: "generation-config",
            retryable: false,
          } satisfies ErrorInfo),
          timestamp,
          job.id,
        );
      }
      this.insertAudit(
        "recovery.generation-changed",
        "jobs",
        `${stale.length} 件未完成工作因生成設定變更而停止，等待使用者明示重新處理。`,
      );
    });
  }
}
