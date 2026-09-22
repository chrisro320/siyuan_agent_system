/**
 * `/siyuan-memory` 狀態輸出。
 *
 * 只呈現真實狀態：設定是否可用、待送佇列、已取用修訂帳本、最近一次 degraded
 * 原因。刻意不顯示權杖、不顯示憑證檔內容，也不把「已送出」說成「已發佈」。
 *
 * 這個轉接器不再是自動記憶擁有者：它只做背景知識發布（擷取），以及使用者明確
 * 要求時的 `siyuan_search` 查詢，因此狀態裡沒有「單一擁有者」或注入錨點。
 */

import type { SessionCounters, StateFailure } from "./state.ts";

export type SetupState = "ready" | "disabled" | "unavailable";

export interface StatusReport {
  setup: SetupState;
  setupReasons: string[];
  warnings: string[];
  projectId: string | null;
  serviceOrigin: string | null;
  stateDir: string | null;
  /** 本機狀態檔被判為不可用時的具體分類；null 代表狀態可用。 */
  stateFailure: StateFailure | null;
  sessionFile: string | null;
  sessionEligible: boolean;
  sessionNote: string;
  pending: number;
  conflicts: number;
  accepted: number;
  /** 已取用修訂帳本長度（單調、永不淘汰；上限見 `CONSUMED_LIMIT`）。 */
  consumed: number;
  degraded: string | null;
  counters: SessionCounters | null;
  lastDeliveryAt: string | null;
}

/** 分類碼到人可讀說明的對照；只講分類與後果，不含檔案內容或憑證。 */
const STATE_FAILURE_NOTE: Record<StateFailure, string> = {
  state_oversized: "狀態檔過大，已停止送出；請人工確認後移開該檔。",
  state_corrupt: "狀態檔格式不符，已停止送出；請人工確認後移開該檔。",
  state_unreadable: "狀態檔無法讀取，已停止送出；請確認檔案權限。",
  state_identity_mismatch: "狀態檔屬於另一個專案或 session 身分，已停止送出。",
  state_unwritable: "狀態檔寫不進磁碟，已停止排入新擷取；既有待送內容原樣保留。",
  baseline_overflow: "既有分支的修訂鍵超過帳本上限，無法建立取用基線；本 session 已停用擷取。",
};

export function renderStatus(report: StatusReport): string {
  const lines: string[] = [
    `設定        ${report.setup}`,
    ...report.setupReasons.map((reason) => `            ${reason}`),
    `專案        ${report.projectId ?? "(未設定)"}`,
    `服務        ${report.serviceOrigin ?? "(未設定)"}`,
    `狀態目錄    ${report.stateDir ?? "(未設定)"}`,
    `本 session  ${report.sessionEligible ? "是" : "否"}｜${report.sessionNote}`,
    `本機狀態    ${
      report.stateFailure === null
        ? "可用"
        : `${report.stateFailure}｜${STATE_FAILURE_NOTE[report.stateFailure]}`
    }`,
    `待送         ${String(report.pending)}（永久衝突 ${String(report.conflicts)}）`,
    `已接受        ${String(report.accepted)} 則訊息`,
    `已取用修訂    ${String(report.consumed)}`,
    `最近送達      ${report.lastDeliveryAt ?? "(尚無)"}`,
    `降級狀態      ${report.degraded ?? "無"}`,
    "手動查詢      由使用者明確要求時呼叫 siyuan_search 工具；本轉接器不會自動搜尋或注入內容。",
  ];

  if (report.counters !== null) {
    const counters = report.counters;
    lines.push(
      `排除統計      機密 ${String(counters.excludedSecrets)}｜合成 ${String(counters.excludedSynthetic)}｜非對話 ${String(counters.excludedNonDialogue)}｜保留信封 ${String(counters.excludedKnowledgeEnvelopes)}｜空白 ${String(counters.excludedEmpty)}`,
    );
  }
  for (const warning of report.warnings) lines.push(`警告        ${warning}`);
  return lines.join("\n");
}
