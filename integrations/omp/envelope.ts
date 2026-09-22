/**
 * 保留信封：標示「不可信的外部知識內容」的邊界。
 *
 * 標記值沿用退役的自動注入信封（`<siyuan-memory>`），而且刻意不換：舊逐字稿裡
 * 既有的注入內容必須繼續被擷取排除，否則那些衍生知識會被當成新的原始對話回收
 * 成證據。現在同一個信封只用於**使用者明確要求**的 `siyuan_search` 工具輸出，
 * 用途是讓搜尋結果被助手整段回聲時仍可辨識並排除，而不是每輪注入。
 *
 * 這個模組不持有任何狀態，也不做任何網路或檔案存取。
 */

export const RESERVED_ENVELOPE_TAG = "siyuan-memory";

/** 文字是否帶有保留信封標記（開頭或結尾）。 */
export function containsReservedEnvelope(text: string): boolean {
  return text.includes(`<${RESERVED_ENVELOPE_TAG}`) || text.includes(`</${RESERVED_ENVELOPE_TAG}>`);
}

/**
 * 中和信封標記，讓被引用的內容無法偽造信封邊界。
 *
 * 只處理標記本身：正文其餘部分原樣保留，因此引用內容仍可逐字比對。
 */
export function defuseReservedEnvelope(text: string): string {
  return text
    .replaceAll(`</${RESERVED_ENVELOPE_TAG}>`, `<\\/${RESERVED_ENVELOPE_TAG}>`)
    .replaceAll(`<${RESERVED_ENVELOPE_TAG}`, `< ${RESERVED_ENVELOPE_TAG}`);
}
