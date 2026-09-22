import {
  AppError,
  type CaptureRequest,
  type CaptureResponse,
  type ImportRequest,
} from "../contracts";
import { normalizeImport } from "../sources";
import { digest } from "../storage/identity";
import type { CaptureReceipt, Store } from "../storage/store";
import { requireAdapterProject } from "./scope";

/**
 * 受理一次自動擷取。
 *
 * 邊界與不變條件：
 *
 * - 只有落在伺服器允許清單、且已設定發佈目的地的專案可以受理；其餘一律 403。
 * - 受理的判準是耐久結果，不是 HTTP 送出成功：原始位元組先落盤，接著回條、匯入與工作
 *   在 `Store.ingestCapture` 的同一個交易內建立。因此回條本身就代表「已持久接受」，
 *   重啟或回應遺失後重送不會遺失已接受的對話，也不可能出現沒有回條約束卻可執行的工作。
 * - 崩潰只可能留下沒有被任何回條引用的原始快照，這是刻意的：原始位元組先耐久寫完，
 *   才進入資料庫交易。
 * - `captureId` 不可重複使用：同一識別碼重送同一份內容會得到當初的受理結果
 *   （`duplicate` 為 true，`importId`／`jobId` 與第一次相同）；換成不同內容則是 409，
 *   而且不會建立新的匯入或工作。新的識別碼若帶來相同來源版本，則由既有的匯入去重處理，
 *   回報既有匯入與工作，不會產生第二篇筆記。
 * - 正規化只走 `normalizeImport`：轉接器送來的對話是資料，來源與專案身分取自請求與
 *   伺服器允許清單；訊息識別碼、父訊息與真實時間戳一律沿用原值，不重新編號也不合成。
 */
export async function acceptCapture(
  store: Store,
  allowedProjects: readonly string[],
  request: CaptureRequest,
): Promise<CaptureResponse> {
  const conversation = request.conversation;
  requireAdapterProject(store, allowedProjects, conversation.projectId);
  const payloadDigest = digest(JSON.stringify(request));

  const importRequest: ImportRequest = {
    format: "conversation",
    content: JSON.stringify(conversation),
    projectId: conversation.projectId,
    source: conversation.source,
    sourceSessionId: conversation.sourceSessionId,
    sourceLocator: conversation.sourceLocator,
    acquisition: "manual",
  };
  const result = await store.ingestCapture({
    captureId: request.captureId,
    payloadDigest,
    branchLeafId: request.branchLeafId,
    request: importRequest,
    conversation: normalizeImport(importRequest),
  });
  if (result.status === "conflict") return conflict(store, result.receipt, request.captureId);
  if (result.status === "replay") {
    return {
      captureId: request.captureId,
      importId: result.receipt.importId,
      jobId: result.receipt.jobId,
      duplicate: true,
    };
  }
  store.audit(
    "capture.accepted",
    request.captureId,
    `import:${result.import.id} duplicate:${result.duplicate}`,
  );
  return {
    captureId: request.captureId,
    importId: result.import.id,
    jobId: result.job.id,
    duplicate: result.duplicate,
  };
}

/**
 * 同一個識別碼被拿去送另一份內容時，衝突而不是更新：既不覆寫回條，也不動既有匯入，
 * 只留下可稽核的紀錄。交易內已確認沒有建立任何新紀錄，所以這裡不會有孤兒工作。
 */
function conflict(store: Store, receipt: CaptureReceipt, captureId: string): never {
  store.audit("capture.conflict", captureId, `import:${receipt.importId}`);
  throw new AppError(
    "capture_conflict",
    "此擷取識別碼已受理不同內容，已拒絕覆寫既有受理結果。",
    false,
    409,
  );
}
