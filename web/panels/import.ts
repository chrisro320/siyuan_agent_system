// 匯入與來源面板：通用對話 JSON、純文字／Markdown，以及 OMP session 檔案匯入。
// 內容一律由使用者提供，面板不產生任何假進度或假成功。

import { type ImportRequest, uploadRequestSchema } from "../../src/contracts";
import { submitImport } from "../api";
import type { AppContext, AppState, Surface } from "../context";
import {
  button,
  chip,
  el,
  hint,
  inputControl,
  labelled,
  notice,
  selectControl,
  textareaControl,
} from "../dom";
import {
  draftFrom,
  putSettings,
  type SettingsDraft,
  settingsDirty,
  settingsFingerprint,
} from "../settings-draft";

const FORMAT_OPTIONS = [
  { value: "conversation", label: "對話 JSON（本系統定義的標準格式）" },
  { value: "text", label: "純文字／Markdown（明確標示為非結構化）" },
  { value: "omp", label: "OMP session 檔（JSONL，逐行原始記錄）" },
] as const;

export function createImportPanel(ctx: AppContext): Surface {
  const formatSelect = selectControl({
    name: "format",
    options: FORMAT_OPTIONS,
    value: "conversation",
  });
  const projectInput = inputControl({
    name: "projectId",
    placeholder: "例如 my-project",
    required: true,
  });
  const sourceInput = inputControl({ name: "source", value: "manual" });
  const sessionInput = inputControl({
    name: "sourceSessionId",
    placeholder: "留空則由後端從內容或檔名推導",
  });
  const locatorInput = inputControl({
    name: "sourceLocator",
    placeholder: "OMP 檔案在伺服器上的完整路徑，例如 /data/omp/sessions/xxx.jsonl",
  });
  const contentArea = textareaControl({
    name: "content",
    rows: 14,
    placeholder: "貼上內容；或選擇下方檔案由瀏覽器讀入這個欄位。",
  });
  const fileInput = inputControl({
    name: "upload",
    type: "file",
    accept: ".json,.jsonl,.md,.markdown,.txt",
  });
  const submissionState = el("div", { class: "status-slot" });

  const readFileButton = button("讀取選取檔案", () => {
    const file = fileInput.files?.[0];
    if (!file) {
      submissionState.replaceChildren(notice("warn", "請先選擇檔案。"));
      return;
    }
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = reader.result;
      contentArea.value = typeof result === "string" ? result : "";
      const chosen = formatSelect.value;
      fileInput.value = "";
      submissionState.replaceChildren(
        notice(
          "info",
          `已讀入「${file.name}」（${file.size} 位元組），內容放在下方欄位，送出前可再修改。目前格式：${chosen}。`,
        ),
      );
    });
    reader.addEventListener("error", () => {
      submissionState.replaceChildren(
        notice("danger", `讀取檔案失敗：${String(reader.error?.message ?? "未知原因")}`),
      );
    });
    reader.readAsText(file);
  });

  const submitButton = button(
    "送出匯入",
    (node) => {
      const request: ImportRequest = {
        format: formatSelect.value as ImportRequest["format"],
        content: contentArea.value,
        projectId: projectInput.value.trim(),
        source: sourceInput.value.trim() === "" ? "manual" : sourceInput.value.trim(),
        sourceLocator: locatorInput.value.trim() === "" ? null : locatorInput.value.trim(),
      };
      const sessionId = sessionInput.value.trim();
      if (sessionId !== "") request.sourceSessionId = sessionId;

      // 送出前先用共享 schema 檢查，避免把明顯不完整的輸入送到後端。
      const validated = uploadRequestSchema.safeParse(request);
      if (!validated.success) {
        submissionState.replaceChildren(
          notice(
            "danger",
            `匯入內容未通過檢查：${validated.error.issues
              .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
              .join("；")}`,
          ),
        );
        return;
      }
      ctx.mutate({
        button: node,
        work: async () => {
          const result = await submitImport(validated.data);
          if (result.duplicate) {
            return `此來源修訂已匯入過，未建立重複工作（沿用工作 ${result.jobId}）。`;
          }
          return `已建立匯入與工作 ${result.jobId}，接著會送往雲端模型抽取。`;
        },
      });
    },
    { variant: "primary" },
  );

  const ompRootsSection = el("section", { class: "card" });

  const panel = el("div", { class: "panel panel-import" }, [
    el("section", { class: "card" }, [
      el("h3", { text: "匯入內容" }),
      el("p", {
        class: "warn-text",
        text: "提醒：送出的內容會上傳到伺服器設定的生成端點與 TypeSafe Jev，並非離線處理。請勿匯入你無權處理的資料。",
      }),
      labelled("來源格式", formatSelect),
      labelled("專案 ID", projectInput),
      hint("專案 ID 是候選與已發佈知識的歸屬鍵。不同來源使用同一個專案 ID 時會歸入同一個專案。"),
      labelled("來源標記", sourceInput),
      hint("預設 manual。OMP 請維持預設，不要拿內容裡的文字當來源標記。"),
      labelled("來源 session ID（可留空）", sessionInput),
      labelled("來源定位（可留空）", locatorInput),
      hint("OMP 匯入時填伺服器可見的檔案完整路徑，用來組成每則訊息的原始位置與後續重掃比對。"),
      labelled("內容", contentArea),
      labelled("從本機檔案讀入", fileInput),
      el("div", { class: "row-actions" }, [readFileButton]),
      hint(
        "檔案讀取只在使用者點擊後於瀏覽器本地進行。OMP 的 JSONL 若最後一行不完整，後端會丟棄殘行並回報警告，不會捏造歷史訊息。",
      ),
      el("div", { class: "row-actions" }, [submitButton]),
      submissionState,
      hint(
        "送出後可到「候選審閱」查看抽取結果；工作狀態在「概覽」以真實後端狀態呈現，面板不會模擬進度。",
      ),
    ]),
    ompRootsSection,
  ]);

  let draft: SettingsDraft | null = null;
  let baseline = "";
  let lastRevision = -1;
  const staleSlot = el("div");

  function savedSettings(saved: AppState["overview"]["settings"]): void {
    baseline = settingsFingerprint({ ...saved, raw: saved });
    lastRevision = saved.revision;
    staleSlot.replaceChildren();
    if (draft !== null && !settingsDirty(draft, baseline)) rebuildSourceList(draft);
  }

  function rebuildSourceList(draftValue: SettingsDraft): void {
    const allowed = ctx.state?.overview.allowedOmpRoots ?? [];
    ompRootsSection.replaceChildren(
      el("h3", { text: "OMP 唯讀來源根目錄" }),
      el("p", {
        class: "hint",
        text: "只能從後端允許的根目錄中選擇；不允許輸入任意路徑，避免意外掃描整個家目錄。",
      }),
    );
    if (allowed.length === 0) {
      ompRootsSection.append(
        notice("warn", "後端未設定任何允許的 OMP 根目錄，因此無法啟用輪詢來源。"),
      );
    }
    if (draftValue.ompRoots.length === 0) {
      ompRootsSection.append(el("p", { class: "empty", text: "目前沒有已設定的來源。" }));
    }
    for (const root of draftValue.ompRoots) {
      const enabledToggle = inputControl({ type: "checkbox" });
      enabledToggle.checked = root.enabled;
      enabledToggle.addEventListener("change", () => {
        root.enabled = enabledToggle.checked;
      });
      const projectEdit = inputControl({ value: root.projectId });
      projectEdit.addEventListener("input", () => {
        root.projectId = projectEdit.value.trim();
      });
      ompRootsSection.append(
        el("article", { class: "row-card" }, [
          el("div", { class: "row-head" }, [
            el("span", { class: "mono", text: root.path }),
            chip(root.enabled ? "啟用" : "停用", root.enabled ? "ok" : "neutral"),
          ]),
          labelled("啟用輪詢", enabledToggle),
          labelled("匯入專案 ID", projectEdit),
          el("div", { class: "row-actions" }, [
            button(
              "移除此來源",
              (node) => {
                const index = draftValue.ompRoots.indexOf(root);
                if (index >= 0) draftValue.ompRoots.splice(index, 1);
                putSettings(ctx, draftValue, node, `已移除來源 ${root.path}。`, savedSettings);
              },
              { variant: "danger" },
            ),
          ]),
        ]),
      );
    }
    if (allowed.length > 0) {
      const pathSelect = selectControl({
        options: [
          { value: "", label: "選擇允許的根目錄…" },
          ...allowed.map((path) => ({ value: path, label: path })),
        ],
      });
      const newProject = inputControl({ placeholder: "此來源的專案 ID" });
      ompRootsSection.append(
        el("article", { class: "row-card" }, [
          el("h4", { text: "新增來源" }),
          labelled("允許的根目錄", pathSelect),
          labelled("專案 ID", newProject),
          el("div", { class: "row-actions" }, [
            button(
              "新增並啟用",
              (node) => {
                const path = pathSelect.value;
                if (path === "") {
                  ctx.notice("warn", "請先選擇一個允許的根目錄。");
                  return;
                }
                if (newProject.value.trim() === "") {
                  ctx.notice("warn", "請填寫此來源的專案 ID。");
                  return;
                }
                if (draftValue.ompRoots.some((root) => root.path === path)) {
                  ctx.notice("warn", `來源 ${path} 已在清單中。`);
                  return;
                }
                draftValue.ompRoots.push({
                  path,
                  projectId: newProject.value.trim(),
                  enabled: true,
                });
                putSettings(
                  ctx,
                  draftValue,
                  node,
                  `已新增來源 ${path} 並啟用輪詢。`,
                  savedSettings,
                );
              },
              { variant: "primary" },
            ),
          ]),
        ]),
      );
    }
    ompRootsSection.append(
      el("p", {
        class: "hint",
        text: "變更以讀取時的 revision 做樂觀鎖；若後端設定已被其他流程改動，儲存會失敗並保留你的草稿。",
      }),
      el("div", { class: "row-actions" }, [
        button(
          "儲存來源設定",
          (node) => {
            putSettings(ctx, draftValue, node, "來源設定已儲存。", savedSettings);
          },
          { variant: "primary" },
        ),
      ]),
    );
    ompRootsSection.append(staleSlot);
  }

  function update(state: AppState): void {
    const revision = state.overview.settings.revision;
    if (draft === null) {
      draft = draftFrom(state);
      baseline = settingsFingerprint(draft);
      lastRevision = revision;
      rebuildSourceList(draft);
      return;
    }
    if (revision === lastRevision) return;
    // 外部已改動設定：若使用者正在編輯或已有未儲存變更，保留草稿不重建表單。
    if (
      settingsDirty(draft, baseline) ||
      (document.activeElement !== null && panel.contains(document.activeElement))
    ) {
      staleSlot.replaceChildren(
        notice("warn", "設定已由其他分頁更新；目前草稿仍保留，請重新載入後再修改。"),
        button("重新載入來源設定", () => {
          if (!window.confirm("重新載入會放棄尚未儲存的來源設定，確定嗎？")) return;
          draft = null;
          staleSlot.replaceChildren();
          if (ctx.state) update(ctx.state);
        }),
      );
      return;
    }
    draft = draftFrom(state);
    baseline = settingsFingerprint(draft);
    lastRevision = revision;
    rebuildSourceList(draft);
  }

  return {
    id: "import",
    title: "匯入與來源",
    node: panel,
    update,
    isDirty: () => {
      if (contentArea.value.trim() !== "" || projectInput.value.trim() !== "") return true;
      if (draft !== null && settingsDirty(draft, baseline)) return true;
      return document.activeElement !== null && panel.contains(document.activeElement);
    },
    activated: () => {
      if (ctx.state !== null) update(ctx.state);
    },
  };
}
