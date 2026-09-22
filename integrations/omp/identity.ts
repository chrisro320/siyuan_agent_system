/**
 * 穩定身分推導。
 *
 * 兩種識別刻意分開，不共用一個鍵：
 * - 訊息修訂（`messageRevisionKey`）：來源訊息識別碼 + 內容雜湊。同一則訊息被
 *   改寫會得到新的鍵，因此改寫會被當成新修訂，而不是被位移量掩蓋。
 * - 擷取識別（`captureIdFor`）：內容定址。同樣的輸入永遠得到同樣的識別，
 *   所以重送具冪等性；內容不同則一定是另一個識別。
 */

import { contentDigest } from "../../src/sources/helpers.ts";

/** 來源訊息修訂鍵：識別碼 + 內文雜湊（32 hex 字元足以避免碰撞）。 */
export function messageRevisionKey(sourceMessageId: string, text: string): string {
  return `${sourceMessageId}#${contentDigest([text]).slice(0, 32)}`;
}

/**
 * 自動擷取識別。
 *
 * 呼叫端必須傳入會隨原文變動而變動的內容（專案、session、分支葉節點、每個新
 * 訊息的修訂鍵）。長度固定在 68 字元，遠低於契約的 512 上限。
 */
export function captureIdFor(parts: readonly string[]): string {
  return `omp-${contentDigest(["siyuan-omp-capture-1", ...parts])}`;
}
