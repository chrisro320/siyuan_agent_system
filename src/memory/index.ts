/**
 * 自動擷取與顯式搜尋的服務邊界。
 *
 * 轉接器送出已完成的原始對話，服務端受理並持久化；抽取、Jev 判斷與思源發佈由 worker
 * 在背景完成。使用者（或明確的按需工具呼叫）要找回某則筆記時，才以 `search` 在該專案
 * 授權的思源範圍內做唯讀查詢——這裡沒有自動注入、也沒有每次對話的檢索迴圈。
 */
export { acceptCapture } from "./capture";
export { requireAdapterProject } from "./scope";
export { queryTerms, search } from "./search";
