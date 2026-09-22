/**
 * 轉接器的本機持久狀態：待送佇列、已取用修訂帳本。
 *
 * 設計要點：
 * - 每個 session 一個檔案，路徑由 session 識別碼決定；不同 session 不可能
 *   互相汙染佇列。
 * - 寫入是「暫存檔 → fsync → rename」，所以不會出現半截狀態；檔案權限固定
 *   0600，目錄 0700。
 * - 讀取有大小上限；超過或格式不符時回報 warning 並拒絕載入，呼叫端必須
 *   據此停止送出（寧可這一輪沒有擷取，也不要把不確定的位元組當成已取用進度）。
 * - 進度的真源是 `consumed` 帳本：所有已耐久排隊、已接受、以及建立基線時既有
 *   的原始修訂鍵都在裡面，單調追加、永不淘汰。回條明細（`accepted`）只是有界
 *   的顯示脈絡。因此回到早期分支、多條互不相交的分支、或很久以前
 *   的訊息被改寫，都不會把舊內容當成新證據。
 * - 帳本到達上限時停止新增擷取（`ledger_full`），而不是淘汰最舊的身分：淘汰會
 *   讓舊訊息重新變成「新證據」。
 * - 待送佇列滿了回報 `outbox_full`，**不會**丟棄既有項目：靜默資料遺失比慢一點
 *   送達更糟。
 * - 退役的自動召回版本同樣寫 `schemaVersion: 2`，但多了 `anchors`／`observedFrom`。
 *   那些欄位已不再使用：載入時被忽略，下一次寫入就不再出現，而 pending／consumed／
 *   accepted 與身分欄位原樣保留，因此既有進度不會被丟掉、也不會重採歷史。
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { captureRequestSchema, id, isoTime } from "../../src/contracts/index.ts";
import { messageRevisionKey } from "./identity.ts";

export const SESSION_STATE_VERSION = 2;
/** 狀態檔讀取上限：超過即視為損壞，不嘗試部分解析。 */
export const MAX_STATE_BYTES = 16 * 1024 * 1024;
/** 單次擷取酬載上限；超過即切成下一批。 */
export const MAX_CAPTURE_BYTES = 256 * 1024;
export const PENDING_LIMIT = 32;
export const ACCEPTED_LIMIT = 64;
/**
 * 已取用修訂帳本的上限。
 *
 * 帳本單調追加、永不淘汰；到達上限就停止新增擷取並顯示 degraded。每筆鍵約 45
 * 位元組（entryId ＋ 32 字元內容摘要），兩萬筆約 0.9 MB，仍遠低於狀態檔 16 MB
 * 的讀取上限，也遠超真實 session 的訊息數（一輪對話兩則）。寧可在極端長度下
 * 停止累積，也不要把舊身分淘汰掉、讓整段歷史重新被當成新證據。
 */
export const CONSUMED_LIMIT = 20_000;

export type PendingStatus = "pending" | "conflict";

const pendingCaptureSchema = z.object({
  captureId: id,
  payload: z.string().min(2).max(MAX_CAPTURE_BYTES),
  messageKeys: z.array(id).min(1).max(2000),
  createdAt: isoTime,
  attempts: z.number().int().nonnegative(),
  /** 只存分類碼（例如 `transport`／`capture_conflict`），不存回應本文。 */
  lastError: z.string().max(200).nullable(),
  status: z.enum(["pending", "conflict"]),
});
export type PendingCapture = z.infer<typeof pendingCaptureSchema>;

const acceptedCaptureSchema = z.object({
  key: id,
  captureId: id,
  importId: id,
  jobId: id,
  acceptedAt: isoTime,
});
export type AcceptedCapture = z.infer<typeof acceptedCaptureSchema>;

const countersSchema = z.object({
  capturedMessages: z.number().int().nonnegative(),
  excludedSecrets: z.number().int().nonnegative(),
  excludedSynthetic: z.number().int().nonnegative(),
  excludedNonDialogue: z.number().int().nonnegative(),
  /**
   * 被排除的保留信封訊息數。
   *
   * 欄位名與退役的自動召回版本不同，因此舊狀態檔沒有這個鍵；預設 0 讓舊檔案
   * 仍可載入，而舊的 `excludedRecallTags` 會被忽略。
   */
  excludedKnowledgeEnvelopes: z.number().int().nonnegative().default(0),
  excludedEmpty: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
});
export type SessionCounters = z.infer<typeof countersSchema>;

const degradedSchema = z.object({
  kind: z.string().max(80),
  detail: z.string().max(400),
  at: isoTime,
});
export type SessionDegraded = z.infer<typeof degradedSchema>;

export const sessionStateSchema = z.object({
  schemaVersion: z.literal(2),
  sessionId: id,
  projectId: id,
  sessionFile: z.string().max(4096).nullable(),
  activatedAt: isoTime,
  accepted: z.array(acceptedCaptureSchema).max(ACCEPTED_LIMIT),
  pending: z.array(pendingCaptureSchema).max(PENDING_LIMIT),
  /**
   * 已取用修訂帳本（`<entryId>#<內容摘要>`）：已耐久排隊、已接受，以及建立
   * 基線時既有的原始修訂鍵。單調、追加、永不淘汰；上限見 `CONSUMED_LIMIT`。
   */
  consumed: z.array(id).max(CONSUMED_LIMIT),
  counters: countersSchema,
  degraded: degradedSchema.nullable(),
  lastDeliveryAt: isoTime.nullable(),
});
export type SessionState = z.infer<typeof sessionStateSchema>;

/** 每個 session 的狀態檔路徑。識別碼會被安全化成單一檔名片段。 */
export function sessionStatePath(stateDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return join(stateDir, "sessions", `${safe.length > 0 ? safe : "unknown"}.json`);
}

/**
 * 讀取檔案系統錯誤的分類碼（`ENOENT`、`EACCES`…）。
 *
 * 用 `in` 縮窄而不是轉型：錯誤物件的形狀不受本檔控制，未經驗證的欄位存取會
 * 安靜地讀到 undefined。
 */
export function errorCodeOf(error: unknown): string | null {
  if (error instanceof Error && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

export function emptySessionState(input: {
  sessionId: string;
  projectId: string;
  sessionFile: string | null;
  activatedAt: string;
}): SessionState {
  return {
    schemaVersion: SESSION_STATE_VERSION,
    sessionId: input.sessionId,
    projectId: input.projectId,
    sessionFile: input.sessionFile,
    activatedAt: input.activatedAt,
    accepted: [],
    pending: [],
    consumed: [],
    counters: {
      capturedMessages: 0,
      excludedSecrets: 0,
      excludedSynthetic: 0,
      excludedNonDialogue: 0,
      excludedKnowledgeEnvelopes: 0,
      excludedEmpty: 0,
      conflicts: 0,
    },
    degraded: null,
    lastDeliveryAt: null,
  };
}

/**
 * 狀態不可用的具體分類；呼叫端必須據此 fail closed（不送出、不重採）。
 *
 * 前四種是讀取失敗；後兩種是「讀得到、但用不下去」：狀態寫不進磁碟，或既有分支
 * 的修訂鍵記不進帳本。
 */
export type StateFailure =
  | "state_oversized"
  | "state_corrupt"
  | "state_unreadable"
  | "state_identity_mismatch"
  /** 狀態寫不進磁碟（權限、空間、rename 失敗…）。 */
  | "state_unwritable"
  /** 既有分支的修訂鍵超過帳本上限，無法建立取用基線。 */
  | "baseline_overflow";

export interface StateLoadResult {
  /** 只有完整通過 schema 與身分核對時才有值。 */
  state: SessionState | null;
  /** 只有「檔案不存在」為 true；其餘失敗一律 false。 */
  fresh: boolean;
  /** 具體分類碼（供狀態指令顯示），成功或首次建立時為 null。 */
  failure: StateFailure | null;
  warning: string | null;
}

/** 這份狀態應該代表的 session 身分；不符即拒絕載入。 */
export interface StateIdentity {
  projectId: string;
  sessionFile: string | null;
  activatedAt: string;
}

function identityMatches(state: SessionState, sessionId: string, expected: StateIdentity): boolean {
  return (
    state.sessionId === sessionId &&
    state.projectId === expected.projectId &&
    state.sessionFile === expected.sessionFile &&
    state.activatedAt === expected.activatedAt
  );
}

/**
 * 核對待送項目與其耐久酬載的語意一致性。
 *
 * `pending.payload` 是先前序列化並耐久保存的擷取封裝，重送時會被直接送出。外層
 * 狀態通過 schema 不代表酬載仍然一致：被改寫、複製或錯置過的狀態可能載入成功，
 * 卻會送出別筆擷取、別的專案／session 的內容，或把沒記進帳本的修訂鍵當成已取用。
 * 因此逐筆重新解析共享擷取契約並核對身分，任何不符都回報原因；呼叫端必須 fail
 * closed，而不是把不確定的位元組照樣送到服務。
 *
 * 合法的退役 `schemaVersion` 2 檔案其 pending 就是完整的 `captureRequestSchema`
 * 封裝，因此這道核對不會拒絕可升級的舊資料。
 */
function pendingCorruption(state: SessionState): string | null {
  const consumed = new Set(state.consumed);
  for (const entry of state.pending) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.payload);
    } catch {
      return `待送項目 ${entry.captureId} 的酬載不是合法 JSON。`;
    }
    const request = captureRequestSchema.safeParse(parsed);
    if (!request.success) return `待送項目 ${entry.captureId} 的酬載不符擷取契約。`;
    if (request.data.captureId !== entry.captureId) {
      return `待送項目 ${entry.captureId} 的酬載記載了另一個擷取識別。`;
    }
    const conversation = request.data.conversation;
    if (conversation.projectId !== state.projectId) {
      return `待送項目 ${entry.captureId} 的酬載屬於另一個專案。`;
    }
    if (conversation.sourceSessionId !== state.sessionId) {
      return `待送項目 ${entry.captureId} 的酬載屬於另一個 session。`;
    }
    const revisions = new Set(
      conversation.messages.map((message) =>
        messageRevisionKey(message.sourceMessageId, message.text),
      ),
    );
    for (const key of revisions) {
      if (!consumed.has(key)) {
        return `待送項目 ${entry.captureId} 的酬載包含未記入已取用帳本的修訂。`;
      }
    }
    for (const key of entry.messageKeys) {
      if (!revisions.has(key)) {
        return `待送項目 ${entry.captureId} 記載的修訂鍵不存在於其酬載中。`;
      }
    }
  }
  return null;
}

/**
 * 讀取本 session 的狀態。
 *
 * 只有 `ENOENT`（這個 session 還沒寫過狀態）允許呼叫端建立新狀態；損壞、過大、
 * 不可讀，或已持久狀態的 projectId／sessionFile／activatedAt／sessionId 與目前
 * 設定不符時，一律回報分類碼並要求 fail closed——靜靜重建空狀態會讓整段歷史被
 * 重新擷取，重複送出已經發佈過的對話。
 *
 * 退役版本寫下的 `anchors`／`observedFrom` 不在 schema 內，載入時被忽略；其餘
 * 進度欄位原樣保留，因此升級不會丟掉 pending／consumed／accepted。
 */
export function loadSessionState(
  stateDir: string,
  sessionId: string,
  expected?: StateIdentity,
): StateLoadResult {
  const file = sessionStatePath(stateDir, sessionId);
  let raw: string;
  try {
    if (statSync(file).size > MAX_STATE_BYTES) {
      return {
        state: null,
        fresh: false,
        failure: "state_oversized",
        warning: "本機狀態檔過大，未載入；已停止送出。",
      };
    }
    raw = readFileSync(file, "utf8");
  } catch (error) {
    const code = errorCodeOf(error);
    if (code === "ENOENT") return { state: null, fresh: true, failure: null, warning: null };
    return {
      state: null,
      fresh: false,
      failure: "state_unreadable",
      warning: "本機狀態檔無法讀取，未載入；已停止送出。",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      state: null,
      fresh: false,
      failure: "state_corrupt",
      warning: "本機狀態檔不是合法 JSON，未載入；已停止送出。",
    };
  }
  const validated = sessionStateSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      state: null,
      fresh: false,
      failure: "state_corrupt",
      warning: "本機狀態檔格式不符，未載入；已停止送出。",
    };
  }
  if (expected !== undefined && !identityMatches(validated.data, sessionId, expected)) {
    return {
      state: null,
      fresh: false,
      failure: "state_identity_mismatch",
      warning: "本機狀態檔屬於另一個專案或 session 身分，未載入；已停止送出。",
    };
  }
  const corruption = pendingCorruption(validated.data);
  if (corruption !== null) {
    return {
      state: null,
      fresh: false,
      failure: "state_corrupt",
      warning: `本機狀態檔的待送內容與其酬載不一致（${corruption}），未載入；已停止送出。`,
    };
  }
  return { state: validated.data, fresh: false, failure: null, warning: null };
}

/** 原子且耐斷電的狀態寫入：暫存檔 fsync 後 rename，目錄權限 0700、檔案 0600。 */
export function saveSessionState(stateDir: string, state: SessionState): void {
  const file = sessionStatePath(stateDir, state.sessionId);
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const bytes = JSON.stringify(state);
  if (bytes.length > MAX_STATE_BYTES) throw new Error("本機狀態超過大小上限，未寫入。");

  const tmp = `${file}.${String(process.pid)}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // 清不掉暫存檔不影響正確性；下次寫入會覆蓋它。
    }
    throw error;
  }
  try {
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // 目錄 fsync 不是所有檔案系統都支援；rename 本身已提供原子性。
  }
}

/**
 * 合併帳本：只追加沒見過的鍵，永不淘汰既有身分。
 *
 * 超過 `CONSUMED_LIMIT` 時回 `null`：呼叫端必須停止新增擷取，而不是淘汰舊身分。
 */
function mergeConsumedKeys(
  existing: readonly string[],
  incoming: readonly string[],
): string[] | null {
  const seen = new Set(existing);
  const merged = [...existing];
  for (const key of incoming) {
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(key);
  }
  if (merged.length > CONSUMED_LIMIT) return null;
  return merged;
}

/** 一批擷取排入的結果；容量不足時不改動狀態，只回報分類碼讓呼叫端顯示 degraded。 */
export type CaptureQueueOutcome =
  | { kind: "queued"; state: SessionState }
  | { kind: "duplicate" }
  | { kind: "outbox_full" }
  | { kind: "ledger_full" };

/**
 * 把一批擷取排入待送佇列，同時把它的修訂鍵記進帳本。
 *
 * 為什麼是一件交易：帳本記「這批修訂已經取用」，佇列記「還沒送達」。先記帳才
 * 發現佇列滿了，那些修訂永遠不會送出；先入列才發現帳本滿了，下一次規劃又會把
 * 它們當成新證據。因此先確認容量，兩者要嘛一起前進，要嘛一起不動。
 *
 * 同一個擷取識別已在佇列中時回報 `duplicate`（detached 的 `agent_end` 可能對同一
 * 批觸發兩次）：狀態不變，呼叫端據此停止這一輪的批次迴圈，且不重複計數。
 */
export function queueCapture(
  state: SessionState,
  entry: PendingCapture,
  keys: readonly string[],
): CaptureQueueOutcome {
  if (state.pending.some((queued) => queued.captureId === entry.captureId)) {
    return { kind: "duplicate" };
  }
  if (state.pending.length >= PENDING_LIMIT) return { kind: "outbox_full" };
  const consumed = mergeConsumedKeys(state.consumed, keys);
  if (consumed === null) return { kind: "ledger_full" };
  return { kind: "queued", state: { ...state, consumed, pending: [...state.pending, entry] } };
}

export function withAccepted(
  state: SessionState,
  entries: readonly AcceptedCapture[],
): SessionState {
  const accepted = [...state.accepted, ...entries];
  return { ...state, accepted: accepted.slice(Math.max(0, accepted.length - ACCEPTED_LIMIT)) };
}

/** 送達並接受後移除待送項目。 */
export function withCaptureSettled(state: SessionState, captureId: string): SessionState {
  return { ...state, pending: state.pending.filter((entry) => entry.captureId !== captureId) };
}

/** 記錄一次失敗：永久衝突標為 `conflict`（不再重送），其餘留在 `pending` 等重試。 */
export function withCaptureFailure(
  state: SessionState,
  captureId: string,
  kind: string,
  status: PendingStatus,
): SessionState {
  return {
    ...state,
    pending: state.pending.map((entry) =>
      entry.captureId === captureId
        ? { ...entry, attempts: entry.attempts + 1, lastError: kind, status }
        : entry,
    ),
  };
}

export function withCounters(state: SessionState, delta: Partial<SessionCounters>): SessionState {
  const counters: SessionCounters = { ...state.counters };
  for (const [key, value] of Object.entries(delta)) {
    if (typeof value === "number") counters[key as keyof SessionCounters] += value;
  }
  return { ...state, counters };
}

export function withDegraded(state: SessionState, degraded: SessionDegraded | null): SessionState {
  return { ...state, degraded };
}

export function withDeliveryAttempt(state: SessionState, at: string): SessionState {
  return { ...state, lastDeliveryAt: at };
}

/**
 * 規劃游標。
 *
 * - `consumedKeys`：已取用修訂鍵（帳本 ∪ 已耐久排隊 ∪ 已接受回條）。規劃一律以它
 *   為去重依據，因此「已排隊但還沒 ACK」的內容不會被再次排入。
 * - `acceptedKeys`：只取回條明細（有界），供有界重播脈絡使用。
 */
export interface CaptureProgress {
  consumedKeys: readonly string[];
  acceptedKeys: readonly string[];
}

/** 由狀態推導規劃游標。 */
export function captureProgress(state: SessionState): CaptureProgress {
  const consumed = new Set<string>(state.consumed);
  for (const entry of state.pending) {
    for (const key of entry.messageKeys) consumed.add(key);
  }
  for (const entry of state.accepted) consumed.add(entry.key);
  return {
    consumedKeys: [...consumed],
    acceptedKeys: state.accepted.map((entry) => entry.key),
  };
}

/**
 * 建立取用基線。
 *
 * 用在 fork（宿主把整份逐字稿帶進新 session）以及狀態檔不存在就 resume 的
 * session：當下分支上的既有訊息不是新的使用者輸入，因此一次記進帳本，之後只會
 * 擷取真正新增的對話。記不下（帳本會爆）時回 `null`，呼叫端必須停用本 session
 * 的擷取，而不是改用空帳本重採歷史。
 */
export function withBaseline(
  state: SessionState,
  input: { keys: readonly string[] },
): SessionState | null {
  const consumed = mergeConsumedKeys(state.consumed, input.keys);
  if (consumed === null) return null;
  return { ...state, consumed };
}
