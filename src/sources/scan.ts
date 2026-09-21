import { constants, type Stats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  AppError,
  type ImportRequest,
  MAX_SOURCE_BYTES,
  type OmpScanItem,
} from "../contracts/index.ts";
import { firstString } from "./helpers.ts";
import { normalizeImport } from "./index.ts";
import { isOmpMessageRecord, parseOmpRecords } from "./omp.ts";

/**
 * 掃描一個允許的 OMP session 根目錄，逐檔產出匯入請求或該檔的問題。
 *
 * 邊界（刻意保守，與「不要收集整個家目錄」的要求一致）：
 * - 只讀 `root` 直屬的普通 `*.jsonl`；不遞迴子目錄，因此不會撈到巢狀的 agent
 *   transcript 或其他工作階段的檔案。
 * - `root` 以 `lstat` 檢查，符號連結、非目錄一律明確拒絕。child 以
 *   `O_NOFOLLOW` 開啟，再對同一個 descriptor `fstat` 確認是普通檔案後才從該
 *   descriptor 讀取；列目錄與開啟之間被換成符號連結時，開啟本身就失敗，
 *   不會讀到授權範圍外的內容。
 * - 每個檔案最多讀取 `MAX_SOURCE_BYTES`。讀取量有明確上限，不是無界：超過上限
 *   的檔案不會被讀入，只產生一筆問題，且不影響同一 root 的其他檔案。
 * - `source` 固定為 `omp`。來源命名空間不能是檔名：檔名可改名，改名不應產生
 *   第二個邏輯來源或繞過來源排除政策。可回溯的位置放在 `sourceLocator`。
 * - 沒有 session 標頭的檔案改用檔案自己的穩定身分（裝置＋inode）當
 *   `sourceSessionId`。這不是內容雜湊，因此改寫或正在增長的 partial 內容都不會
 *   改變身分；檔案被替換（inode 改變）才代表新來源。
 * - 單一檔案的失敗只產生該檔的問題並繼續處理其餘檔案；只有 root 本身不可讀、
 *   不是目錄或是符號連結時才拋出錯誤。
 *
 * 逐檔 `yield`，因此不會把所有大檔同時累積在記憶體中。
 */
export async function* scanOmpRoot(root: string, projectId: string): AsyncGenerator<OmpScanItem> {
  let rootStats: Stats;
  try {
    rootStats = await lstat(root);
  } catch {
    throw new AppError("source_unreadable", "無法讀取來源根目錄，請確認路徑存在且服務可讀取。");
  }
  if (rootStats.isSymbolicLink()) {
    throw new AppError(
      "source_unreadable",
      "來源根目錄是符號連結，已拒絕掃描；請改設實際目錄路徑。",
    );
  }
  if (!rootStats.isDirectory()) {
    throw new AppError("source_unreadable", "來源根目錄不是目錄，請確認設定路徑。");
  }

  let names: string[];
  try {
    const listing = await readdir(root, { withFileTypes: true });
    names = listing
      // 列目錄當下已是符號連結的 child 先排除；開啟時再以 O_NOFOLLOW 確認一次。
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.toLowerCase().endsWith(".jsonl"))
      .sort();
  } catch {
    throw new AppError("source_unreadable", "無法讀取來源根目錄，請確認路徑存在且服務可讀取。");
  }

  for (const name of names) {
    const item = await scanSourceFile(join(root, name), name, projectId);
    if (item !== null) yield item;
  }
}

/**
 * 讀取並分類單一來源檔。
 * 回傳 `null` 代表「確定沒有可匯入訊息且不是故障」：空檔或只有標頭的檔案，
 * 這種情況刻意不產生任何輸出，其餘狀態一律要有可見的結果。
 */
async function scanSourceFile(
  path: string,
  name: string,
  projectId: string,
): Promise<OmpScanItem | null> {
  let content: string;
  let fileIdentity: string;
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        return issue(name, "source_unsafe", "來源項目不是普通檔案，已略過。");
      }
      if (stats.size > MAX_SOURCE_BYTES) {
        return issue(
          name,
          "source_too_large",
          `來源檔超過 ${MAX_SOURCE_BYTES} 位元組的讀取上限，未讀入；請縮小或輪替該來源檔。`,
        );
      }
      fileIdentity = `omp-file-${stats.dev.toString(16)}-${stats.ino.toString(16)}`;
      // 只讀 stat 當下確認過的長度：即使檔案正在成長，讀取量仍在上限內。
      const buffer = Buffer.allocUnsafe(stats.size);
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      content = buffer.subarray(0, filled).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (cause) {
    return (cause as NodeJS.ErrnoException | null)?.code === "ELOOP"
      ? issue(name, "source_unsafe", "來源項目在掃描期間變成符號連結，已拒絕讀取。")
      : issue(name, "source_unreadable", "無法讀取來源檔案，請確認權限與檔案狀態。");
  }

  if (content.trim().length === 0) return null;

  const request: ImportRequest = {
    format: "omp",
    content,
    projectId,
    source: "omp",
    sourceLocator: path,
    acquisition: "poll",
  };

  // 嚴格完整行：尾端沒有換行的記錄代表這一輪還沒寫完，解析層不會採用它。
  const { records, partialTail, malformed } = parseOmpRecords(content, true);
  const header = records.find((record) => record.type === "session" || record.type === "header");
  const declaredSessionId = header === undefined ? null : firstString(header.id, header.sessionId);
  // 有標頭時身分由標頭決定（解析層以標頭優先）；沒有標頭才使用檔案自己的穩定身分。
  if (declaredSessionId === null) request.sourceSessionId = fileIdentity;

  if (!records.some(isOmpMessageRecord)) {
    if (partialTail) {
      return issue(
        name,
        "source_pending",
        "來源檔只有標頭與尚未寫完的殘尾，這一輪沒有可匯入的訊息；等待下一次掃描。",
      );
    }
    return malformed > 0
      ? issue(
          name,
          "invalid_source",
          `來源檔有 ${malformed} 行不是有效的 JSON 記錄，且沒有可匯入的訊息；未推測其內容。`,
        )
      : null;
  }

  try {
    // 分類用的解析與正式匯入走同一條路徑，確保回傳的請求真的能產生對話；
    // 這裡的錯誤屬於這個檔案，不影響同一 root 的其他檔案。
    normalizeImport(request);
  } catch (cause) {
    return issue(
      name,
      cause instanceof AppError ? cause.code : "invalid_source",
      cause instanceof AppError ? cause.message : "來源檔無法匯入；未推測其內容。",
    );
  }
  return { request, issue: null };
}

function issue(file: string, code: string, message: string): OmpScanItem {
  return { request: null, issue: { file, code, message } };
}
