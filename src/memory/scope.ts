import { AppError, type Destination } from "../contracts";
import type { Store } from "../storage/store";

/**
 * 轉接器可見的專案界線。
 *
 * 自動擷取與顯式搜尋都必須同時滿足兩件事：專案在伺服器端的允許清單內，而且該專案
 * 已設定思源的筆記本與受管路徑。任何一項缺少就回 403，不做跨專案的替代查詢，
 * 也不因為筆記本裡「看起來相關」就把別的專案內容回傳。
 */
export function requireAdapterProject(
  store: Store,
  allowedProjects: readonly string[],
  projectId: string,
): Destination {
  if (!allowedProjects.includes(projectId)) {
    throw new AppError(
      "project_not_allowed",
      "此專案未在伺服器允許的擷取與搜尋清單內。",
      false,
      403,
    );
  }
  const destination = store.settings().destinations.find((item) => item.projectId === projectId);
  if (!destination) {
    throw new AppError("project_not_allowed", "此專案尚未設定思源的筆記本與受管路徑。", false, 403);
  }
  return destination;
}
