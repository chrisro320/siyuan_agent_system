/**
 * 自動擷取的純邏輯：從 session 作用中分支挑出「新的原始人機對話」，組成契約封裝。
 *
 * 邊界：
 * - 只取 `user`／`assistant` 的原始文字。工具事件、壓縮摘要、擴充訊息、思考、
 *   附件本體、system/developer 紀錄一律不進封裝（`extractText` 既有的過濾負責
 *   最後一項，這裡只負責角色與來源層級）。
 * - 合成（自動續跑）訊息不是人類輸入，排除。
 * - 含已知憑證樣式、或含保留信封（＝退役的自動注入信封，現為 `siyuan_search`
 *   工具輸出的邊界）的訊息排除；後者是防止衍生知識被當成新證據回收的回饋迴圈
 *   防線。助手自己的一般回答不含信封，因此照常被擷取。
 * - 進度以「訊息修訂鍵」判斷，不是位元組位移：改寫過的舊訊息會取得新鍵，
 *   因此會被視為新修訂；未改寫的則不會重送。
 */

import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import {
  type CaptureRequest,
  captureRequestSchema,
  type ImportRequest,
  type SourceMessage,
} from "../../src/contracts/index.ts";
import { extractText } from "../../src/sources/content.ts";
import { ConversationBuilder } from "../../src/sources/conversation-builder.ts";
import { createRedactor } from "../../src/sources/helpers.ts";
import { containsReservedEnvelope } from "./envelope.ts";
import { captureIdFor, messageRevisionKey } from "./identity.ts";
import type { CaptureProgress, SessionCounters } from "./state.ts";

/**
 * `ConversationBuilder.create` 只讀 source／projectId／sourceSessionId／sourceLocator；
 * `content` 是手動匯入路徑才使用的欄位，這裡明示它未被使用，而不是塞入假資料。
 */
const CARRIER_CONTENT = "(自動擷取：內容來自 OMP session 事件，未使用此欄位。)";

export const DEFAULT_MAX_MESSAGES = 40;
export const DEFAULT_MAX_BYTES = 160 * 1024;
export const DEFAULT_REPLAY_CONTEXT = 2;

export type CaptureExclusion =
  | "role"
  | "synthetic"
  | "provider-only"
  | "empty"
  | "secret"
  | "knowledge-envelope";

export interface BranchDialogue {
  entryId: string;
  parentId: string | null;
  role: "user" | "assistant";
  /** 來源自己記載的時間；缺漏時為 null，絕不補上當下時間。 */
  timestamp: string | null;
  text: string;
  attachments: SourceMessage["attachments"];
  rawLocator: string;
  key: string;
}

export interface BranchReading {
  messages: BranchDialogue[];
  exclusions: Record<CaptureExclusion, number>;
  omittedKinds: string[];
}

export function readBranchDialogue(
  entries: readonly SessionEntry[],
  sessionFile: string,
): BranchReading {
  const exclusions: Record<CaptureExclusion, number> = {
    role: 0,
    synthetic: 0,
    "provider-only": 0,
    empty: 0,
    secret: 0,
    "knowledge-envelope": 0,
  };
  const omittedKinds = new Set<string>();
  const messages: BranchDialogue[] = [];
  // 只做既有樣式的偵測（PEM 私鑰、`key = value` 憑證指派、Bearer 標頭），
  // 不新增第二套憑證樣式。
  const redact = createRedactor([]);

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") {
      exclusions.role += 1;
      continue;
    }
    if (message.role === "user" && message.synthetic === true) {
      exclusions.synthetic += 1;
      continue;
    }
    if ("providerOnly" in message && message.providerOnly === true) {
      exclusions["provider-only"] += 1;
      continue;
    }
    const extracted = extractText(message.content);
    for (const kind of extracted.omitted) omittedKinds.add(kind);
    // 原始文字原樣保留（含前後空白與換行），只用 trim 判斷「是不是只有空白」。
    // 對內容 trim 會同時改寫送出正文與修訂雜湊，讓「只多打了外圍空白」的修訂看起來
    // 沒變，等於悄悄丟掉來源證據。
    const text = extracted.text;
    if (text.trim().length === 0) {
      exclusions.empty += 1;
      continue;
    }
    if (containsReservedEnvelope(text)) {
      exclusions["knowledge-envelope"] += 1;
      continue;
    }
    if (redact(text) !== text) {
      exclusions.secret += 1;
      continue;
    }
    messages.push({
      entryId: entry.id,
      parentId: entry.parentId,
      role: message.role,
      timestamp: entry.timestamp,
      text,
      attachments: extracted.attachments,
      rawLocator: `${sessionFile}#${entry.id}`,
      key: messageRevisionKey(entry.id, text),
    });
  }

  return { messages, exclusions, omittedKinds: [...omittedKinds] };
}

export interface CapturePlan {
  request: CaptureRequest;
  /** 這次真正新增的訊息修訂鍵（不含重播的脈絡）。 */
  newKeys: string[];
  replayedCount: number;
  exclusions: Record<CaptureExclusion, number>;
}

export interface PlanCaptureInput {
  entries: readonly SessionEntry[];
  sessionId: string;
  sessionFile: string;
  projectId: string;
  startedAt: string | null;
  branchLeafId: string | null;
  progress: CaptureProgress;
  maxMessages?: number;
  maxBytes?: number;
  replayContext?: number;
}

export type CaptureOutcome =
  | { kind: "none"; counters: Partial<SessionCounters> }
  | { kind: "plan"; plan: CapturePlan; counters: Partial<SessionCounters> }
  | { kind: "invalid"; reason: string; counters: Partial<SessionCounters> };

/**
 * 規劃下一批擷取。
 *
 * 進度由「已取用修訂帳本」決定，而不是位元組位移，也不是有界的水位窗：
 * - 去重一律以 `progress.consumedKeys`（帳本 ∪ 已耐久排隊 ∪ 已接受回條）為準，
 *   所以服務中斷期間已排入佇列、還沒被 ACK 的內容不會被重新排入。
 * - 帳本永不淘汰，因此回到很早的舊分支、超過分支數的互不相交分支，或很久以前
 *   的訊息被改寫（同一個 entryId、新內容 → 新修訂鍵），結果都只有一個：沒見過的
 *   修訂才會被選取；見過的一律略過。
 * - 已取用的訊息不重送；只有緊鄰這一批之前的至多 `replayContext` 則已接受訊息
 *   會重播，用來讓抽取模型看得到前文，並在 warnings 標明它們是重播。
 */
export function planCapture(input: PlanCaptureInput): CaptureOutcome {
  const reading = readBranchDialogue(input.entries, input.sessionFile);
  const counters: Partial<SessionCounters> = {
    excludedSecrets: reading.exclusions.secret,
    excludedSynthetic: reading.exclusions.synthetic,
    excludedNonDialogue: reading.exclusions.role + reading.exclusions["provider-only"],
    excludedKnowledgeEnvelopes: reading.exclusions["knowledge-envelope"],
    excludedEmpty: reading.exclusions.empty,
  };

  const consumed = new Set(input.progress.consumedKeys);
  const acceptedKeys = new Set(input.progress.acceptedKeys);

  const maxMessages = input.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const selected: BranchDialogue[] = [];
  let firstSelectedIndex = -1;
  let bytes = 0;
  for (let index = 0; index < reading.messages.length; index++) {
    const message = reading.messages[index];
    if (message === undefined || consumed.has(message.key)) continue;
    if (selected.length >= maxMessages) break;
    const size = message.text.length + message.rawLocator.length + 128;
    if (selected.length > 0 && bytes + size > maxBytes) break;
    if (firstSelectedIndex < 0) firstSelectedIndex = index;
    selected.push(message);
    bytes += size;
  }
  if (selected.length === 0) return { kind: "none", counters };

  const replayContext = input.replayContext ?? DEFAULT_REPLAY_CONTEXT;
  const replay = reading.messages
    .slice(Math.max(0, firstSelectedIndex - replayContext), firstSelectedIndex)
    .filter((message) => acceptedKeys.has(message.key));

  const carrier: ImportRequest = {
    format: "omp",
    content: CARRIER_CONTENT,
    projectId: input.projectId,
    source: "omp",
    sourceSessionId: input.sessionId,
    sourceLocator: input.sessionFile,
  };
  const newKeys = selected.map((message) => message.key);
  const builder = ConversationBuilder.create(carrier, [input.sessionId, ...newKeys], {
    declaredSessionId: input.sessionId,
    preferDeclared: true,
  });
  if (replay.length > 0) {
    builder.warn(
      `為保留對話脈絡，這次自動擷取重播了前 ${String(replay.length)} 則已接受的訊息；它們的修訂識別未改變，伺服器必須以既有來源修訂去重，不得重複發佈。`,
    );
  }
  if (reading.omittedKinds.length > 0) {
    builder.warn(
      `來源含有未被轉發的內容種類（${reading.omittedKinds.join("、")}）；這些內容未經分析，也未送出。`,
    );
  }
  for (const message of [...replay, ...selected]) {
    builder.add({
      rawId: message.entryId,
      role: message.role,
      timestamp: message.timestamp,
      parentId: message.parentId,
      text: message.text,
      attachments: message.attachments,
      rawLocator: message.rawLocator,
      fallbackId: message.key,
      truncated: false,
    });
  }
  builder.finalize();

  const request: CaptureRequest = {
    schemaVersion: 1,
    captureId: captureIdFor([
      input.projectId,
      input.sessionId,
      input.branchLeafId ?? "",
      ...newKeys,
    ]),
    branchLeafId: input.branchLeafId,
    conversation: builder.finish(input.startedAt),
  };

  // 送出前先過一次權威 schema：轉接器不得送出伺服器會拒絕的封裝。
  const validated = captureRequestSchema.safeParse(request);
  if (!validated.success) {
    return {
      kind: "invalid",
      reason: validated.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("；")
        .slice(0, 300),
      counters,
    };
  }
  return {
    kind: "plan",
    plan: {
      request: validated.data,
      newKeys,
      replayedCount: replay.length,
      exclusions: reading.exclusions,
    },
    counters,
  };
}

/**
 * 目前分支的取用基線。
 *
 * Fork 會把既有逐字稿帶進新 session（新 id／新時間），resume 也可能遇到沒有狀態
 * 檔的既有 session。那些訊息不是新的使用者輸入，因此一次全部記進已取用帳本，
 * 之後只會擷取真正新增的對話。
 */
export interface BranchBaseline {
  /** 分支上全部訊息的修訂鍵（依分支順序）。 */
  keys: string[];
}

export function branchBaseline(
  entries: readonly SessionEntry[],
  sessionFile: string,
): BranchBaseline {
  const reading = readBranchDialogue(entries, sessionFile);
  return { keys: reading.messages.map((message) => message.key) };
}
