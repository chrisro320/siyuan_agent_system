import { CryptoHasher } from "bun";
import { AppError, isoTime } from "../contracts/index.ts";

/**
 * 契約硬上限。`normalizeImport` 產生的物件必須落在這些範圍內，
 * 否則下游 `conversationSchema.parse` 會失敗。
 */
export const ID_MAX = 512;
export const LOCATOR_MAX = 4096;
export const RAW_LOCATOR_MAX = 100_000;
export const MESSAGE_LIMIT = 20_000;

export const REDACTED = "[REDACTED]";

/**
 * `missing` 的固定輸出順序。`redacted` 不是「來源缺少」，
 * 而是 `redactConversation` 標記「這段文字已在送出雲端前被改寫」。
 */
export const MISSING_FIELD_ORDER: readonly string[] = [
  "role",
  "timestamp",
  "parent",
  "sourceMessageId",
  "text",
  "attachments",
  "truncated",
  "redacted",
];

/** 已解析的 JSON 物件，或 null（陣列、null、純量都不是物件）。 */
export function asJsonObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 取第一個非空字串；空字串、空白、非字串一律視為不存在。 */
export function firstString(...values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

/** 拒絕超長識別碼，不截斷、不改名，避免改寫原始證據錨點。 */
export function boundedId(value: string): string {
  if (value.length > ID_MAX)
    throw new AppError("invalid_source", "來源識別碼超過 512 字元；未截斷或改名，已停止匯入。");
  return value;
}

export function asId(raw: unknown, fallback: string): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  return boundedId(value.length > 0 ? value : fallback);
}

export function asLocator(raw: unknown, fallback: string): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  return (value.length > 0 ? value : fallback).slice(0, LOCATOR_MAX);
}

export function asRawLocator(raw: unknown, fallback: string): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  return (value.length > 0 ? value : fallback).slice(0, RAW_LOCATOR_MAX);
}

/** 只接受契約 `isoTime` 格式；不接受的字串回傳 null，絕不猜測時區或補上當下時間。 */
export function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = isoTime.safeParse(value.trim());
  return parsed.success ? parsed.data : null;
}

export function contentDigest(parts: readonly string[]): string {
  const hasher = new CryptoHasher("sha256");
  for (const part of parts) {
    hasher.update(part);
    hasher.update("\u0000");
  }
  return hasher.digest("hex");
}

/** 依固定順序輸出 `missing`；未知欄位保留下來並排在後面，不靜默丟棄來源標記。 */
export function orderMissing(values: readonly string[]): string[] {
  const unique = [...new Set(values)];
  const known = MISSING_FIELD_ORDER.filter((field) => unique.includes(field));
  const extra = unique.filter((field) => !MISSING_FIELD_ORDER.includes(field)).sort();
  return [...known, ...extra];
}

const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g;

const ASSIGNED_SECRET =
  /((?:api[_-]?key|apikey|secret|token|password|passwd|access[_-]?key|client[_-]?secret|authorization|auth)\b["']?\s*[:=]\s*)(["']?)([A-Za-z0-9_\-./+=]{12,})\2/gi;

const BEARER_TOKEN = /\b(bearer\s+)([A-Za-z0-9_\-./+=]{12,})/gi;

export type Redactor = (value: string) => string;

/**
 * 建立可重用的局部遮蔽器。
 *
 * 明確範圍：政策字詞（literal 取代）、Bearer 標頭、`key = value` 形式的憑證指派、
 * PEM 私鑰區塊。這是「送雲前的最小本地遮蔽」，**不是**通用 DLP：
 * 無法辨識的自由文字秘密仍可能通過，呼叫端不得把它當成完整保證。
 *
 * 政策字詞依長度遞減排序後才組成 alternation。若短詞排在長詞之前，
 * `ABC` 會先吃掉 `ABCDEF` 的前綴，長字詞的尾段（`DEF`）就會殘留並送出。
 */
export function createRedactor(terms: readonly string[]): Redactor {
  const usable = [...new Set(terms.filter((term) => term.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  const literal =
    usable.length > 0
      ? new RegExp(usable.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")
      : null;
  const assignReplacement = `$1$2${REDACTED}$2`;
  const bearerReplacement = `$1${REDACTED}`;
  return (value: string): string => {
    let output = value.replace(PRIVATE_KEY_BLOCK, REDACTED);
    output = output.replace(ASSIGNED_SECRET, assignReplacement);
    output = output.replace(BEARER_TOKEN, bearerReplacement);
    if (literal !== null) output = output.replace(literal, REDACTED);
    return output;
  };
}
