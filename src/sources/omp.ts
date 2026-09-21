import type { Conversation } from "../contracts/index.ts";
import { collectAttachments, extractText } from "./content.ts";
import { ConversationBuilder } from "./conversation-builder.ts";
import { asJsonObject, firstString, isoOrNull } from "./helpers.ts";

export interface OmpParseOptions {
  /** 完整檔案內容（可能含正在寫入、尚未結束的殘尾）。 */
  content: string;
  source: string;
  projectId: string;
  sourceSessionId?: string | undefined;
  sourceLocator: string | null;
  /**
   * 取得方式。`poll` 是輪詢掃描到的檔案：尾端只要沒有換行，即使 JSON 本身已經
   * 完整，也先當成「這一輪還沒寫完」而不匯入該行，等下一次掃描取得完整行。
   * `manual`（預設）是使用者主動上傳：檔案已是使用者給定的當下狀態，
   * 完整的尾端行直接採用，只有解析失敗的殘尾才丟棄。
   */
  acquisition?: "manual" | "poll" | undefined;
}

/**
 * OMP 記錄串的逐行解析結果。
 *
 * - 只有「完整的一行 JSON」才進入 `records`；無法解析的行一律略過，不猜測內容。
 * - `partialTail`：最後一個非空行沒有被採用，因為它可能是寫入中的殘尾
 *   （解析失敗），或輪詢模式下結尾沒有換行、尚未 commit。呼叫端據此決定要
 *   等待或匯入。
 * - 每次都完整重讀整份內容，不看位元組位移；因此被改寫過的舊記錄也會重新解析。
 */
export interface OmpRecords {
  records: Record<string, unknown>[];
  partialTail: boolean;
  malformed: number;
}

/**
 * 逐行解析。`completeLinesOnly` 為真時，最後一行若沒有以換行結束就不算完整：
 * 檔案系統上的最後一行可能還在被寫入，輪詢必須嚴格等到該行 commit。
 */
export function parseOmpRecords(content: string, completeLinesOnly = false): OmpRecords {
  const lines = content.split(/\r?\n/);
  let lastNonEmpty = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim().length > 0) lastNonEmpty = index;
  }
  // 有結尾換行時 split 才會多出空字串；最後非空行等於末項代表尚未 commit。
  const unterminated = lastNonEmpty >= 0 && lastNonEmpty === lines.length - 1;
  const records: Record<string, unknown>[] = [];
  let partialTail = false;
  let malformed = 0;
  const last = completeLinesOnly && unterminated ? lastNonEmpty - 1 : lastNonEmpty;
  if (completeLinesOnly && unterminated) partialTail = true;
  for (let index = 0; index <= last; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (!completeLinesOnly && unterminated && index === lastNonEmpty) partialTail = true;
      else malformed += 1;
      continue;
    }
    const record = asJsonObject(parsed);
    if (record !== null) records.push(record);
  }
  return { records, partialTail, malformed };
}

/**
 * OMP 訊息記錄：`type` 為 `message`，或沒有 `type` 但帶有訊息欄位。
 * 其他記錄（session 標頭、工具事件、擴充紀錄、provider payload）一律不當成對話
 * 訊息，因此不會被送往生成模型。
 */
export function isOmpMessageRecord(record: Record<string, unknown>): boolean {
  const type = record.type;
  if (typeof type === "string") return type === "message";
  const body = asJsonObject(record.message);
  return body !== null && (body.role !== undefined || body.content !== undefined);
}

/**
 * 解析 OMP session JSONL 成對話封裝。
 *
 * - 身分取自記錄本身：session 標頭提供 `sourceSessionId`，訊息提供
 *   `id`／`parentId`／`timestamp`。改寫過的舊記錄會改變內容摘要並產生新版本，
 *   但訊息身分不變。
 * - `toolResult` 對應契約的 `tool` 角色，工具輸出因此是可引用的證據。
 * - 思考內容、附件內容、provider payload 與憑證欄位不轉發；附件只保留位置與
 *   狀態（`not-analyzed`），不假稱已分析。
 */
export function parseOmp(options: OmpParseOptions): Conversation {
  const acquisition = options.acquisition ?? "manual";
  const { records, partialTail, malformed } = parseOmpRecords(
    options.content,
    acquisition === "poll",
  );

  const header = records.find((record) => record.type === "session" || record.type === "header");
  const declaredSessionId = firstString(header?.id, header?.sessionId);
  const fallbackLocator = options.sourceLocator ?? "OMP session";
  const builder = ConversationBuilder.create(
    {
      format: "omp",
      content: options.content,
      projectId: options.projectId,
      source: options.source,
      sourceSessionId: options.sourceSessionId,
      sourceLocator: options.sourceLocator,
    },
    [options.content],
    // 來源標頭就是這個檔案自己的身分，優先於請求帶進來的值（請求可能來自
    // 掃描器的檔案身分 fallback，或呼叫端的一般設定）。
    { declaredSessionId, preferDeclared: true },
  );

  const omittedKinds = new Set<string>();
  const attachmentLines: string[] = [];
  let nonMessageRecords = 0;
  let emptyText = 0;
  let unknownRole = 0;
  let missingTimestamp = 0;
  let skippedInstructions = 0;
  let inlineAttachments = 0;
  let reachedLimit = false;

  for (const [index, record] of records.entries()) {
    if (!isOmpMessageRecord(record)) {
      nonMessageRecords += 1;
      continue;
    }
    const body = asJsonObject(record.message);
    const rawRoleValue = body?.role ?? record.role;
    const roleText = typeof rawRoleValue === "string" ? rawRoleValue.trim().toLowerCase() : "";
    // 系統／開發者提示詞是主機設定，不是對話內容：不轉發給生成模型。
    if (roleText === "system" || roleText === "developer") {
      skippedInstructions += 1;
      continue;
    }
    const extracted = extractText(body?.content ?? record.content);
    for (const kind of extracted.omitted) omittedKinds.add(kind);
    inlineAttachments += extracted.unsavedInlineAttachments;
    inlineAttachments += collectAttachments(body?.attachments, extracted.attachments);
    inlineAttachments += collectAttachments(record.attachments, extracted.attachments);
    if (extracted.attachments.length > 0) attachmentLines.push(String(index + 1));

    if (roleText.length === 0) unknownRole += 1;
    const timestampRaw = body?.timestamp ?? record.timestamp ?? body?.createdAt ?? record.createdAt;
    if (isoOrNull(timestampRaw) === null) missingTimestamp += 1;
    if (extracted.text.trim().length === 0) emptyText += 1;

    // 來源沒有自己的識別碼時使用位置識別；那是可回溯的替代，但不是來源原生 id，
    // 必須讓下游看得出來。
    const declaredMessageId = firstString(record.id, body?.id);
    const message = builder.add({
      rawId: declaredMessageId,
      role: roleText,
      timestamp: timestampRaw,
      parentId: body?.parentId ?? record.parentId,
      text: extracted.text,
      attachments: extracted.attachments,
      rawLocator: `${fallbackLocator} 第 ${index + 1} 行`,
      fallbackId: `${fallbackLocator}#行${index + 1}`,
      missing: declaredMessageId === null ? ["sourceMessageId"] : [],
    });
    if (message === null) {
      reachedLimit = true;
      break;
    }
  }

  builder.finalize();

  if (partialTail) {
    builder.warn(
      acquisition === "poll"
        ? "來源檔尾端尚未有完整結束的記錄（可能仍在寫入中）：本輪先不匯入該行，待下一次掃描取得完整行再處理；既有的完整記錄仍全部納入。"
        : "來源檔最後一行不是完整的 JSON 記錄（可能仍在寫入中），已丟棄該行；既有的完整記錄仍全部納入。",
    );
  }
  if (malformed > 0) {
    builder.warn(`來源有 ${malformed} 行不是有效的 JSON 記錄，已略過，未推測其內容。`);
  }
  if (nonMessageRecords > 0) {
    builder.warn(
      `來源有 ${nonMessageRecords} 筆非訊息記錄（標頭、工具事件、擴充紀錄等），未進入對話內容。`,
    );
  }
  if (emptyText > 0) {
    builder.warn(`有 ${emptyText} 則訊息在過濾不可轉發內容後沒有可讀文字，已標記缺少 text。`);
  }
  if (omittedKinds.size > 0) {
    builder.warn(
      `已略過不可轉發的內容種類：${[...omittedKinds].join("、")}；這些內容不送往生成模型。`,
    );
  }
  if (attachmentLines.length > 0) {
    builder.warn(
      `第 ${attachmentLines.join("、")} 行含附件，只保留位置與狀態（not-analyzed），未分析其內容。`,
    );
  }
  if (inlineAttachments > 0) {
    builder.warn(
      `有 ${inlineAttachments} 個附件只有內嵌內容（例如 data: URL），未保存其本體也未送出，只保留不透明的存在證明。`,
    );
  }
  if (missingTimestamp > 0) {
    builder.warn(
      `有 ${missingTimestamp} 則訊息沒有可採用的時間戳，已留空並標記 missing；未以當下時間代替。`,
    );
  }
  if (unknownRole > 0) {
    builder.warn(`有 ${unknownRole} 則訊息的角色無法對應契約角色，已保留為 unknown。`);
  }
  if (skippedInstructions > 0) {
    builder.warn(
      `來源有 ${skippedInstructions} 則系統／開發者提示詞，屬主機設定而非對話內容，未納入也未送往生成模型。`,
    );
  }
  if (options.sourceLocator === null) {
    builder.warn("未提供來源路徑，訊息位置改用固定字串推導；呼叫端應傳入可回溯的完整路徑。");
  }
  if (reachedLimit) {
    builder.warn("已達單一對話的訊息量上限，來源的剩餘記錄未納入。");
  }

  return builder.finish(header?.createdAt ?? header?.startedAt ?? header?.timestamp);
}
