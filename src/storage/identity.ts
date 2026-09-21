import { createHash, randomUUID } from "node:crypto";
import type { Conversation, SourceMessage } from "../contracts/index.ts";

/**
 * 來源記錄的內容摘要。原始快照檔名、來源版本與訊息版本一律使用此值。
 */
export function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * 目前的 UTC 時刻，格式符合契約的 `isoTime`。
 */
export function now(): string {
  return new Date().toISOString();
}

/**
 * 產生一個不與既有列衝突的識別碼。
 */
export function newId(): string {
  return randomUUID();
}

/**
 * 來源命名空間。不同平台或不同專案的相同 session 字串不得共用身分。
 */
export function sourceKeyOf(source: string, sourceSessionId: string, projectId: string): string {
  return digest(JSON.stringify([source, sourceSessionId, projectId]));
}

/**
 * 單一來源訊息的穩定鍵。同一來源訊息跨修訂共用此鍵，內容差異由版本雜湊表達。
 */
export function messageKeyOf(sourceKey: string, sourceMessageId: string): string {
  return digest(JSON.stringify([sourceKey, sourceMessageId]));
}

/**
 * 訊息的語義欄位。刻意排除 `rawLocator`：那是來源內部定位（檔名、位移、行號），
 * 重新掃描或搬移來源檔時會改變，但不代表對話內容改變。
 * `missing` 予以保留，因為它記錄來源真實缺失的欄位，屬來源記錄的一部分。
 */
function messageSemantics(message: SourceMessage) {
  return {
    sourceMessageId: message.sourceMessageId,
    parentId: message.parentId,
    role: message.role,
    timestamp: message.timestamp,
    text: message.text,
    attachments: message.attachments.map((attachment) => ({
      locator: attachment.locator,
      mediaType: attachment.mediaType,
      status: attachment.status,
    })),
    missing: [...message.missing],
    truncated: message.truncated,
  };
}

/**
 * 單一訊息的版本雜湊。
 */
export function messageRevisionOf(message: SourceMessage): string {
  return digest(JSON.stringify(messageSemantics(message)));
}

/**
 * 正規化對話的版本雜湊。
 *
 * 涵蓋來源身分、起始時間、完整性警告與每一則訊息的語義欄位，包含真實時間戳記（不合成時間）。
 * 警告先去重再排序：同一組警告的先後順序或重複次數不構成新版本，但警告本身代表來源
 * partial／truncated 的可見狀態，屬來源完整性語義，必須納入版本。
 * 排除 `sourceLocator` 與 `rawLocator`：那是來源內部位置，重新掃描或搬移來源檔時會改變，
 * 不代表對話內容改變。
 */
export function revisionOf(conversation: Conversation): string {
  return digest(
    JSON.stringify({
      schemaVersion: conversation.schemaVersion,
      source: conversation.source,
      sourceSessionId: conversation.sourceSessionId,
      projectId: conversation.projectId,
      startedAt: conversation.startedAt,
      warnings: [...new Set(conversation.warnings)].sort(),
      messages: conversation.messages.map(messageSemantics),
    }),
  );
}
