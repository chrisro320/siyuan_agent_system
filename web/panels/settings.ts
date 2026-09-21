// 設定與操作歷史面板：政策（instructions／門檻／遮蔽詞／排除來源）、
// 目的地（notebook 與受管根目錄）對應，以及操作歷史狀態、憑證、錯誤與撤回。
// 所有設定以完整 Settings 加 revision CAS 送出，並保留伺服器端未知欄位。

import { type Destination, destinationSchema } from "../../src/contracts";
import { fetchNotebooks, undoOperation } from "../api";
import type { AppContext, AppState, Surface } from "../context";
import {
  button,
  chip,
  el,
  emptyState,
  errorText,
  hint,
  inputControl,
  labelled,
  notice,
  rawText,
  selectControl,
  textareaControl,
} from "../dom";
import {
  describeOperationStatus,
  formatRelative,
  formatTime,
  noteHref,
  operationTargetLabel,
  stringifyValue,
} from "../format";
import {
  draftFrom,
  putSettings,
  type SettingsDraft,
  settingsDirty,
  settingsFingerprint,
  staleAgainst,
} from "../settings-draft";

function numberField(
  label: string,
  value: number,
  bounds: { min: string; max: string; step: string },
  onChange: (value: number) => void,
): HTMLElement {
  const control = inputControl({ type: "number", value: String(value), ...bounds });
  control.addEventListener("change", () => {
    const parsed = Number.parseFloat(control.value);
    if (Number.isFinite(parsed)) onChange(parsed);
  });
  return labelled(label, control);
}

export function createSettingsPanel(ctx: AppContext): Surface {
  const node = el("div", { class: "panel panel-settings" });
  const operationsSection = el("section", { class: "card" });
  const notebooksSlot = el("div", { class: "status-slot" });
  let notebooks: { id: string; name: string }[] | null = null;
  let notebooksError: string | null = null;
  let draft: SettingsDraft | null = null;
  let baseline = "";
  let lastRevision = -1;
  const staleSlot = el("div");
  let newDestination = { projectId: "", notebookId: "", rootPath: "" };
  const hasNewDestination = () => Object.values(newDestination).some((value) => value !== "");

  function savedSettings(saved: AppState["overview"]["settings"]): void {
    baseline = settingsFingerprint({ ...saved, raw: saved });
    lastRevision = saved.revision;
    staleSlot.replaceChildren();
    if (ctx.state && draft !== null && !settingsDirty(draft, baseline)) {
      renderSettings({ ...ctx.state, overview: { ...ctx.state.overview, settings: saved } });
    }
  }

  function renderOperations(state: AppState): void {
    const operations = [...state.overview.operations].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
    operationsSection.replaceChildren(
      el("h3", { text: `操作歷史（${operations.length}）` }),
      hint(
        "撤回只針對本系統擁有、且內容與紀錄一致的資料；已被人工修改時會顯示衝突並停止，不會還原整份舊文件。",
      ),
    );
    if (operations.length === 0) {
      operationsSection.append(emptyState("尚無寫入操作。"));
      return;
    }
    for (const operation of operations) {
      const status = describeOperationStatus(operation.status);
      const block = el("article", { class: "row-card" });
      block.append(
        el("div", { class: "row-head" }, [
          chip(status.label, status.tone),
          chip(operation.kind === "create" ? "建立" : "附加", "neutral"),
          el("span", { class: "mono", text: operation.id }),
        ]),
      );
      block.append(
        el("dl", { class: "kv" }, [
          el("dt", { text: "候選" }),
          el("dd", { text: operation.candidateId }),
          el("dt", { text: "專案" }),
          el("dd", { text: operation.projectId }),
          el("dt", { text: "目標" }),
          el("dd", { text: operationTargetLabel(operation) }),
          el("dt", { text: "筆記本" }),
          el("dd", { text: operation.notebookId }),
          el("dt", { text: "區塊 ID" }),
          el("dd", { text: operation.blockId }),
          el("dt", { text: "更新時間" }),
          el("dd", {
            text: `${formatTime(operation.updatedAt)}（${formatRelative(operation.updatedAt)}）`,
          }),
        ]),
      );
      if (operation.status === "verified" || operation.status === "undone") {
        const href = noteHref(
          operation.status === "undone" ? operation.documentId : operation.blockId,
          state.overview.providers.siyuanPublicUrl,
        );
        block.append(
          el("p", {}, [
            el("span", { text: "SiYuan 連結：" }),
            el("a", {
              class: "md-link",
              attrs: { href, target: "_blank", rel: "noreferrer noopener" },
              text: "在 SiYuan 開啟",
            }),
          ]),
        );
      }
      if (operation.receipt !== null) {
        block.append(
          el("details", {}, [
            el("summary", { text: "讀回憑證" }),
            el("p", { class: "hint", text: `內容雜湊：${operation.receipt.contentHash}` }),
            rawText(stringifyValue(operation.receipt.attributes), "raw-text"),
          ]),
        );
      }
      if (operation.error !== null) block.append(errorText(operation.error));
      if (operation.status === "conflict") {
        block.append(notice("danger", "內容已被人工修改，撤回會停止並顯示衝突。"));
      }
      if (operation.status === "uncertain") {
        block.append(notice("warn", "送出後未取得確定回應，後端會先對帳再決定，不會盲目重送。"));
      }
      if (operation.status === "undoing") {
        block.append(notice("warn", "撤回已送出但尚未確認，可再次嘗試撤回。"));
      }
      const actions = el("div", { class: "row-actions" });
      if (operation.status === "verified" || operation.status === "undoing") {
        actions.append(
          button(
            operation.status === "undoing" ? "再次嘗試撤回" : "撤回此筆寫入",
            (node) => {
              const confirmed = window.confirm(
                `確定要撤回嗎？\n\n操作 ID：${operation.id}\n目標：${operationTargetLabel(operation)}\n` +
                  "只會處理本系統擁有且未被修改的資料。",
              );
              if (!confirmed) {
                ctx.notice("info", `已取消撤回操作 ${operation.id}。`);
                return;
              }
              ctx.mutate({
                button: node,
                work: async () => {
                  await undoOperation(operation.id);
                  return `已送出撤回請求（操作 ${operation.id}）。`;
                },
              });
            },
            { variant: "danger" },
          ),
        );
      }
      if (actions.childElementCount > 0) block.append(actions);
      operationsSection.append(block);
    }
  }

  function renderSettings(state: AppState): void {
    if (draft === null) return;
    const settings = draft;
    const revisionChanged = staleAgainst(settings, state);
    const policySection = el("section", { class: "card" }, [
      el("h3", { text: "保留政策" }),
      hint(
        `目前 revision ${settings.revision}。送出時以這個版本做樂觀鎖；若後端已被改動，儲存會失敗並保留你的輸入。`,
      ),
    ]);
    if (revisionChanged) {
      policySection.append(
        notice(
          "warn",
          `後端設定的 revision 已變成 ${state.overview.settings.revision}。你的草稿仍保留；請按「重新載入設定」取得最新版本後再儲存，以免覆寫他人變更。`,
        ),
      );
    }
    const instructionsArea = textareaControl({ rows: 4, value: settings.policy.instructions });
    instructionsArea.addEventListener("input", () => {
      settings.policy.instructions = instructionsArea.value;
    });
    policySection.append(labelled("政策指示（提供給抽取與判定的規範）", instructionsArea));
    policySection.append(
      numberField(
        "最低信心值",
        settings.policy.minConfidence,
        { min: "0", max: "1", step: "0.01" },
        (value) => {
          settings.policy.minConfidence = value;
        },
      ),
      numberField(
        "最低可重用價值",
        settings.policy.minValue,
        { min: "0", max: "2", step: "0.01" },
        (value) => {
          settings.policy.minValue = value;
        },
      ),
      numberField(
        "可接受最高敏感度",
        settings.policy.maxSensitivity,
        { min: "0", max: "1", step: "0.01" },
        (value) => {
          settings.policy.maxSensitivity = value;
        },
      ),
    );
    const excludedArea = textareaControl({
      rows: 3,
      value: settings.policy.excludedSources.join("\n"),
    });
    excludedArea.addEventListener("input", () => {
      settings.policy.excludedSources = excludedArea.value
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    });
    policySection.append(
      labelled("排除來源（每行一個來源標記）", excludedArea),
      hint("被排除的來源不會送入雲端模型，也不會產生候選。"),
    );
    const redactedArea = textareaControl({
      rows: 3,
      value: settings.policy.redactedTerms.join("\n"),
    });
    redactedArea.addEventListener("input", () => {
      settings.policy.redactedTerms = redactedArea.value
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    });
    policySection.append(
      labelled("遮蔽詞（每行一個）", redactedArea),
      hint("符合的詞彙會在送出前處理；請以實際敏感詞維護這份清單。"),
    );

    const destinationSection = el("section", { class: "card" }, [
      el("h3", { text: "發佈目的地對應" }),
    ]);
    destinationSection.append(
      hint("目的地決定候選要發佈到哪個 notebook 與受管根目錄。路徑必須是根目錄下的絕對路徑。"),
    );
    destinationSection.append(notebooksSlot);
    for (const destination of settings.destinations) {
      const projectInput = inputControl({ value: destination.projectId });
      projectInput.addEventListener("input", () => {
        destination.projectId = projectInput.value.trim();
      });
      const notebookOptions =
        notebooks === null
          ? [{ value: destination.notebookId, label: `${destination.notebookId}（未載入名稱）` }]
          : notebooks.some((item) => item.id === destination.notebookId)
            ? notebooks.map((item) => ({ value: item.id, label: `${item.name}（${item.id}）` }))
            : [
                {
                  value: destination.notebookId,
                  label: `${destination.notebookId}（後端目前找不到此 notebook）`,
                },
                ...notebooks.map((item) => ({
                  value: item.id,
                  label: `${item.name}（${item.id}）`,
                })),
              ];
      const notebookSelect = selectControl({
        options: notebookOptions,
        value: destination.notebookId,
      });
      notebookSelect.dataset.notebook = "true";
      notebookSelect.addEventListener("change", () => {
        destination.notebookId = notebookSelect.value;
      });
      const rootInput = inputControl({ value: destination.rootPath });
      rootInput.addEventListener("input", () => {
        destination.rootPath = rootInput.value.trim();
      });
      destinationSection.append(
        el("article", { class: "row-card" }, [
          labelled("專案 ID", projectInput),
          labelled("Notebook", notebookSelect),
          labelled("受管根目錄路徑", rootInput),
          el("div", { class: "row-actions" }, [
            button(
              "移除此對應",
              (node) => {
                const position = settings.destinations.indexOf(destination);
                if (position >= 0) settings.destinations.splice(position, 1);
                putSettings(ctx, settings, node, "已移除目的地對應。", savedSettings);
              },
              { variant: "danger" },
            ),
          ]),
        ]),
      );
    }
    const newProject = inputControl({ placeholder: "專案 ID", value: newDestination.projectId });
    const newRoot = inputControl({
      placeholder: "/受管/根目錄路徑",
      value: newDestination.rootPath,
    });
    newProject.addEventListener("input", () => {
      newDestination.projectId = newProject.value;
    });
    newRoot.addEventListener("input", () => {
      newDestination.rootPath = newRoot.value;
    });
    const newNotebookOptions =
      notebooks === null
        ? [{ value: "", label: "（筆記本清單尚未載入）" }]
        : [
            { value: "", label: "選擇 notebook…" },
            ...notebooks.map((item) => ({ value: item.id, label: `${item.name}（${item.id}）` })),
          ];
    const newNotebook = selectControl({
      options: newNotebookOptions,
      value: newDestination.notebookId,
    });
    newNotebook.addEventListener("change", () => {
      newDestination.notebookId = newNotebook.value;
    });
    newNotebook.dataset.notebook = "true";
    destinationSection.append(
      el("article", { class: "row-card" }, [
        el("h4", { text: "新增目的地對應" }),
        labelled("專案 ID", newProject),
        labelled("Notebook", newNotebook),
        labelled("受管根目錄路徑", newRoot),
        el("div", { class: "row-actions" }, [
          button(
            "新增對應",
            (node) => {
              const candidate: Destination = {
                projectId: newProject.value.trim(),
                notebookId: newNotebook.value,
                rootPath: newRoot.value.trim(),
              };
              const validated = destinationSchema.safeParse(candidate);
              if (!validated.success) {
                ctx.notice(
                  "danger",
                  `目的地未通過契約檢查：${validated.error.issues
                    .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
                    .join("；")}`,
                );
                return;
              }
              if (
                settings.destinations.some((item) => item.projectId === validated.data.projectId)
              ) {
                ctx.notice(
                  "warn",
                  `專案 ${validated.data.projectId} 已有目的地對應，請先移除舊的再新增。`,
                );
                return;
              }
              settings.destinations.push(validated.data);
              newDestination = { projectId: "", notebookId: "", rootPath: "" };
              putSettings(
                ctx,
                settings,
                node,
                `已新增專案 ${validated.data.projectId} 的目的地對應。`,
                savedSettings,
              );
            },
            { variant: "primary" },
          ),
        ]),
      ]),
    );
    destinationSection.append(notebooksSlot);

    const ompSection = el("section", { class: "card" }, [
      el("h3", { text: "OMP 來源根目錄" }),
      hint("此處與「匯入與來源」共用同一份設定；只能選用後端允許的根目錄。"),
    ]);
    const allowed = state.overview.allowedOmpRoots;
    if (settings.ompRoots.length === 0) {
      ompSection.append(emptyState("目前沒有已設定的 OMP 來源。"));
    }
    for (const root of settings.ompRoots) {
      const toggle = inputControl({ type: "checkbox" });
      toggle.checked = root.enabled;
      toggle.addEventListener("change", () => {
        root.enabled = toggle.checked;
      });
      const projectEdit = inputControl({ value: root.projectId });
      projectEdit.addEventListener("input", () => {
        root.projectId = projectEdit.value.trim();
      });
      ompSection.append(
        el("article", { class: "row-card" }, [
          el("div", { class: "row-head" }, [el("span", { class: "mono", text: root.path })]),
          labelled("啟用輪詢", toggle),
          labelled("專案 ID", projectEdit),
        ]),
      );
    }
    ompSection.append(
      hint(`後端允許的根目錄：${allowed.length === 0 ? "（未設定）" : allowed.join("、")}`),
    );

    const saveRow = el("div", { class: "row-actions" });
    saveRow.append(
      button(
        "儲存設定",
        (node) => {
          putSettings(ctx, settings, node, "設定已儲存。", savedSettings);
        },
        { variant: "primary", disabled: revisionChanged },
      ),
      button("重新載入設定", (node) => {
        const confirmed = window.confirm("重新載入會丟棄你目前未儲存的設定變更，確定嗎？");
        if (!confirmed) {
          ctx.notice("info", "已保留目前草稿。");
          return;
        }
        lastRevision = -1;
        draft = null;
        newDestination = { projectId: "", notebookId: "", rootPath: "" };
        ctx.mutate({
          button: node,
          work: async () => {
            await ctx.refresh();
            return "已重新載入後端設定。";
          },
        });
      }),
    );

    node.replaceChildren(
      staleSlot,
      policySection,
      destinationSection,
      ompSection,
      saveRow,
      operationsSection,
    );
  }

  async function loadNotebooks(buttonNode?: HTMLButtonElement): Promise<void> {
    notebooksError = null;
    notebooksSlot.replaceChildren(el("p", { class: "loading", text: "正在載入筆記本清單…" }));
    if (buttonNode) buttonNode.disabled = true;
    try {
      notebooks = await fetchNotebooks();
      notebooksSlot.replaceChildren(
        notebooks.length === 0
          ? notice("warn", "後端回報的筆記本清單為空，請先確認 SiYuan 連線與權限。")
          : notice("info", `已載入 ${notebooks.length} 個筆記本。`),
      );
    } catch (error) {
      notebooks = null;
      notebooksError = error instanceof Error ? error.message : String(error);
      notebooksSlot.replaceChildren(
        notice("danger", `載入筆記本失敗：${notebooksError}`),
        button("重新載入筆記本", (node) => {
          void loadNotebooks(node);
        }),
      );
    } finally {
      if (buttonNode) buttonNode.disabled = false;
      if (notebooks !== null) {
        for (const select of node.querySelectorAll<HTMLSelectElement>("select[data-notebook]")) {
          const selected = select.value;
          select.replaceChildren(
            new Option("選擇 notebook…", ""),
            ...notebooks.map((item) => new Option(`${item.name}（${item.id}）`, item.id)),
          );
          if (selected && !notebooks.some((item) => item.id === selected))
            select.add(new Option(`${selected}（目前找不到）`, selected));
          select.value = selected;
        }
      }
    }
  }

  return {
    id: "settings",
    title: "設定與操作",
    node,
    update: (state: AppState) => {
      const revision = state.overview.settings.revision;
      if (
        draft !== null &&
        revision !== lastRevision &&
        (settingsDirty(draft, baseline) || hasNewDestination())
      ) {
        staleSlot.replaceChildren(
          notice("warn", "後端設定已更新；你的未儲存草稿仍保留，請按「重新載入設定」再修改。"),
        );
        renderOperations(state);
        return;
      }
      if (draft === null || revision !== lastRevision) {
        draft = draftFrom(state);
        baseline = settingsFingerprint(draft);
        lastRevision = revision;
        renderSettings(state);
        renderOperations(state);
        return;
      }
      // 使用者正在編輯或有未儲存變更時，只更新唯讀的操作歷史，不重建表單。
      renderOperations(state);
      const editing =
        hasNewDestination() ||
        (document.activeElement !== null && node.contains(document.activeElement)) ||
        settingsDirty(draft, baseline);
      if (!editing) renderSettings(state);
    },
    isDirty: () =>
      (draft !== null && settingsDirty(draft, baseline)) ||
      hasNewDestination() ||
      (document.activeElement !== null && node.contains(document.activeElement)),
    activated: () => {
      if (notebooks === null && notebooksError === null) void loadNotebooks();
      if (ctx.state !== null) {
        renderOperations(ctx.state);
        if (draft !== null && !settingsDirty(draft, baseline)) renderSettings(ctx.state);
      }
    },
  };
}
