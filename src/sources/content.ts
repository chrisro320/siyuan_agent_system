import type { SourceMessage } from "../contracts/index.ts";
import { asJsonObject, asLocator, firstString } from "./helpers.ts";

export interface ExtractedText {
  text: string;
  attachments: SourceMessage["attachments"];
  /** 被略過的內容種類，用於警告文字。 */
  omitted: string[];
  /** 只有內嵌本體、因此未保存內容的附件數量。 */
  unsavedInlineAttachments: number;
}

/**
 * 內嵌內容 scheme（`data:` URL 等）把附件本體直接放在參照位置裡。
 * 這種值一旦存進 `locator`，宣稱「附件內容未轉發」就不成立，
 * 因此只保留不透明的位置，不保存本體。
 */
const INLINE_CONTENT_SCHEME = /^\s*data:/i;

/**
 * 把來源的附件清單轉成契約格式；缺位置時仍保留一筆「存在但未分析」的紀錄。
 *
 * 回傳被丟棄的內嵌內容筆數：位置若只有 `data:` 形式的內嵌本體，改用不透明的
 * 摘要佔位，呼叫端應據此警告使用者附件雖然存在但內容未被分析、也未保存。
 */
export function collectAttachments(raw: unknown, into: SourceMessage["attachments"]): number {
  if (!Array.isArray(raw)) return 0;
  let inlinePayloads = 0;
  for (const item of raw) {
    const detail = asJsonObject(item);
    if (detail === null) continue;
    const declaredStatus = detail.status;
    // 位置優先取可回溯的檔案路徑／網址；只有在沒有路徑時才退用不透明的識別碼。
    const declared = [
      detail.url,
      detail.path,
      detail.locator,
      detail.file,
      detail.name,
      detail.id,
      detail.file_id,
    ];
    const usable = firstString(...declared.filter((value) => !isInlineContent(value)));
    if (usable === null && declared.some(isInlineContent)) inlinePayloads += 1;
    into.push({
      // 只有內嵌本體時不保存本體，改用不透明的存在證明。
      locator: asLocator(usable ?? `未保存的內嵌附件#${inlinePayloads}`, "未命名附件"),
      mediaType: firstString(detail.media_type, detail.mediaType, detail.mime_type),
      status: declaredStatus === "missing" || detail.missing === true ? "missing" : "not-analyzed",
    });
  }
  return inlinePayloads;
}

/** 只保留「存在但未分析」的可回溯位置；內嵌本體一律視為不可用位置。 */
function isInlineContent(value: unknown): boolean {
  return typeof value === "string" && INLINE_CONTENT_SCHEME.test(value);
}

/**
 * 只取出可安全送給生成模型的文字。
 *
 * 明確不轉發：模型思考內容（`thinking`／`reasoning`）、附件內容（僅保留位置與
 * 是否存在的狀態）、provider payload、憑證類欄位。非文字部分不會被改寫成摘要，
 * 只回報「存在但未分析」。無法辨識的內容一律略過，不猜測其文字。
 */
export function extractText(content: unknown): ExtractedText {
  const attachments: SourceMessage["attachments"] = [];
  const omitted: string[] = [];
  let unsavedInlineAttachments = 0;
  const note = (kind: string): void => {
    if (!omitted.includes(kind)) omitted.push(kind);
  };
  const takeAttachments = (raw: unknown): void => {
    const unsaved = collectAttachments(raw, attachments);
    if (unsaved === 0) return;
    unsavedInlineAttachments += unsaved;
    note("內嵌附件本體");
  };
  const readPart = (part: unknown): string => {
    if (typeof part === "string") return part;
    const record = asJsonObject(part);
    if (record === null) {
      note("無法辨識的內容片段");
      return "";
    }
    const type = typeof record.type === "string" ? record.type : "";
    if (type === "thinking" || type === "reasoning" || type === "analysis") {
      note("模型思考內容");
      return "";
    }
    if (/image|audio|video|file|document|attachment/.test(type)) {
      takeAttachments([record]);
      note("附件內容");
      return "";
    }
    if (typeof record.text === "string") return record.text;
    note("未支援的內容欄位");
    return "";
  };

  const result = (text: string): ExtractedText => ({
    text,
    attachments,
    omitted,
    unsavedInlineAttachments,
  });

  if (typeof content === "string") return result(content);
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      const value = readPart(part);
      if (value.length > 0) parts.push(value);
    }
    return result(parts.join("\n"));
  }
  if (content === null || content === undefined) return result("");
  return result(readPart(content));
}
