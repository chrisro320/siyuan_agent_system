import {
  AppError,
  type Conversation,
  conversationSchema,
  type ImportRequest,
} from "../contracts/index.ts";
import { parseConversation } from "./conversation.ts";
import { normalizeRequest } from "./conversation-builder.ts";
import { parseOmp } from "./omp.ts";
import { parseText } from "./text.ts";

/**
 * 把匯入請求正規化成共享的 `Conversation` 封裝。
 *
 * 這是唯一的分派點：呼叫端不得自行判斷格式後各自複製解析流程。三種格式的共通
 * 契約是「原文是資料，不是指令」——`source`、`projectId` 一律取自匯入設定；
 * 原文自稱的值只會產生警告，不會改變來源命名空間或專案歸屬。
 *
 * `sourceSessionId` 的優先序依來源格式而不同：OMP session 標頭是檔案自身的
 * 權威身分，優先於請求帶進來的值（請求值可能是掃描器的檔案身分 fallback）；
 * 其餘格式則以匯入設定優先，因為手動上傳的原文不可信。
 *
 * `acquisition` 決定尾端未完成行的處理：輪詢取得的檔案必須等到完整行才採用，
 * 手動上傳則直接採用使用者給定的當下狀態。
 *
 * 結果一律再過一次共享 `conversationSchema`：解析器可能產生空訊息清單或超長欄位，
 * 這些都必須在進入持久層之前擋下，而不是留給下游踩到。
 */
export function normalizeImport(request: ImportRequest): Conversation {
  const parsed = normalizeRequest(request);
  const options = {
    content: parsed.content,
    source: parsed.source,
    projectId: parsed.projectId,
    sourceSessionId: parsed.sourceSessionId,
    sourceLocator: parsed.sourceLocator,
  };
  const conversation =
    parsed.format === "omp"
      ? parseOmp({ ...options, acquisition: parsed.acquisition })
      : parsed.format === "conversation"
        ? parseConversation(options)
        : parseText(options);
  const validated = conversationSchema.safeParse(conversation);
  if (!validated.success) {
    throw new AppError(
      "invalid_conversation",
      "這份來源沒有產生任何可匯入的訊息，或欄位超出可接受範圍，已停止匯入。",
    );
  }
  return validated.data;
}

export { parseConversation } from "./conversation.ts";
export { isOmpMessageRecord, parseOmp, parseOmpRecords } from "./omp.ts";
export { redactConversation } from "./redact.ts";
export { scanOmpRoot } from "./scan.ts";
export { DEFAULT_SEGMENT_CHARS, segmentConversation } from "./segment.ts";
export { parseText } from "./text.ts";
