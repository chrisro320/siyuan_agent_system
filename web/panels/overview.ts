// 概覽面板：供應商設定存在與否、工作佇列與失敗、來源健康狀態。
// 只顯示 key 是否存在，永不顯示任何憑據值。

import type { Job, Operation, Overview, SourceHealth } from "../../src/contracts";
import { reprocessJob, retryJob } from "../api";
import type { AppContext, AppState, Surface } from "../context";
import { badge, button, chip, el, emptyState, keyValueList } from "../dom";
import {
  describeJobStatus,
  describeOperationStatus,
  formatRelative,
  formatTime,
  operationTargetLabel,
} from "../format";

function providerRow(label: string, configured: boolean): HTMLElement {
  const row = el("div", { class: "provider-row" }, [
    el("span", { class: "provider-name", text: label }),
  ]);
  row.append(configured ? chip("已設定憑據", "ok") : chip("未設定憑據", "danger"));
  row.append(
    el("span", {
      class: "provider-note",
      text: configured ? "後端可使用" : "此階段會停用，直到設定完成",
    }),
  );
  return row;
}

function renderProviders(container: HTMLElement, overview: Overview): void {
  container.replaceChildren(
    el("h3", { text: "雲端供應商設定" }),
    el("p", {
      class: "hint",
      text: "僅顯示憑據是否存在；憑據本身只保存在伺服器端環境或秘密檔，永遠不會回傳到瀏覽器。",
    }),
    el("div", { class: "provider-list" }, [
      providerRow("Ollama Cloud（抽取與知識整理）", overview.providers.ollamaConfigured),
      providerRow("TypeSafe Jev（保留判定）", overview.providers.jevConfigured),
      providerRow("SiYuan（發佈目的地）", overview.providers.siyuanConfigured),
    ]),
    keyValueList([
      {
        key: "生成模型",
        value: chip(overview.providers.generationModel, "info"),
      },
      {
        key: "雲端處理",
        value: el("span", {
          text: "所有候選都會送往上述雲端模型處理，並非離線作業。",
        }),
      },
    ]),
  );
}

function jobCard(ctx: AppContext, job: Job): HTMLElement {
  const status = describeJobStatus(job.status);
  const card = el("article", { class: "row-card" });
  const head = el("div", { class: "row-head" }, [
    badge(status.label, status.tone),
    el("span", { class: "mono", text: job.id }),
    chip(`嘗試 ${job.attempts} 次`, "neutral"),
  ]);
  card.append(head);
  card.append(
    keyValueList([
      { key: "匯入", value: el("span", { class: "mono", text: job.importId }) },
      { key: "政策版本", value: String(job.policyRevision) },
      { key: "更新", value: `${formatTime(job.updatedAt)}（${formatRelative(job.updatedAt)}）` },
      { key: "下次重試", value: job.nextAttemptAt === null ? "—" : formatTime(job.nextAttemptAt) },
      {
        key: "抽取進度",
        value: job.extractionComplete
          ? `已完成（第 ${job.nextSegment} 段）`
          : `進行中（第 ${job.nextSegment} 段）`,
      },
    ]),
  );
  if (job.error !== null) {
    card.append(
      el("div", { class: "error-block" }, [
        el("strong", { text: `失敗於階段：${job.error.stage}` }),
        el("p", { class: "error-text", text: `${job.error.message}（代碼 ${job.error.code}）` }),
        el("p", {
          class: "hint",
          text: job.error.retryable ? "此錯誤可重試。" : "此錯誤標記為不可重試。",
        }),
      ]),
    );
  }
  const actions = el("div", { class: "row-actions" });
  if (job.error !== null || job.status === "retry-wait" || job.status === "failed") {
    actions.append(
      button(
        "重試",
        (node) => {
          ctx.mutate({
            button: node,
            work: async () => {
              await retryJob(job.id);
              return `工作 ${job.id} 已排入重試。`;
            },
          });
        },
        { variant: "primary", title: "以既有匯入重新排程這個工作" },
      ),
    );
  }
  if (
    job.status === "failed" ||
    job.status === "complete" ||
    job.status === "review" ||
    job.status === "archive-only" ||
    job.status === "ready"
  ) {
    actions.append(
      button(
        "重新處理",
        (node) => {
          ctx.mutate({
            button: node,
            work: async () => {
              await reprocessJob(job.id);
              return `工作 ${job.id} 已要求重新處理；候選將建立新版本，既有發佈不會被重複寫入。`;
            },
          });
        },
        { title: "重跑抽取與 Jev 判定，並與既有發佈對帳" },
      ),
    );
  }
  if (actions.childElementCount > 0) card.append(actions);
  return card;
}

function sourceCard(source: SourceHealth): HTMLElement {
  const card = el("article", { class: "row-card" });
  card.append(
    el("div", { class: "row-head" }, [
      el("span", { class: "mono", text: source.path }),
      source.error === null ? chip("正常", "ok") : chip("讀取失敗", "danger"),
    ]),
  );
  card.append(
    keyValueList([
      { key: "已匯入", value: `${source.imported} 筆` },
      { key: "檢查時間", value: formatTime(source.checkedAt) },
      { key: "錯誤", value: source.error === null ? "—" : source.error },
    ]),
  );
  return card;
}

function failureCard(job: Job): HTMLElement {
  return el("article", { class: "row-card" }, [
    el("div", { class: "row-head" }, [
      badge(describeJobStatus(job.status).label, "danger"),
      el("span", { class: "mono", text: job.id }),
    ]),
    el("p", {
      class: "error-text",
      text: `${job.error?.stage ?? "unknown"}：${job.error?.message ?? "（無訊息）"}`,
    }),
    el("p", { class: "hint", text: `更新於 ${formatRelative(job.updatedAt)}` }),
  ]);
}

function failedOperationCard(operation: Operation): HTMLElement {
  const status = describeOperationStatus(operation.status);
  return el("article", { class: "row-card" }, [
    el("div", { class: "row-head" }, [
      badge(status.label, status.tone),
      el("span", { class: "mono", text: operation.id }),
    ]),
    el("p", { class: "error-text", text: operation.error ?? "（無錯誤訊息，但狀態非已驗證）" }),
    el("p", { class: "hint", text: `目標：${operationTargetLabel(operation)}` }),
  ]);
}

export function createOverviewPanel(ctx: AppContext): Surface {
  const providers = el("section", { class: "card" });
  const jobs = el("section", { class: "card" });
  const sources = el("section", { class: "card" });
  const failures = el("section", { class: "card" });
  const node = el("div", { class: "panel panel-overview" }, [providers, jobs, failures, sources]);

  function update(state: AppState): void {
    const overview = state.overview;
    renderProviders(providers, overview);

    const sortedJobs = [...overview.jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    jobs.replaceChildren(el("h3", { text: `工作佇列（${sortedJobs.length}）` }));
    if (sortedJobs.length === 0) {
      jobs.append(emptyState("尚無工作。到「匯入與來源」貼上或上傳內容後，工作會出現在這裡。"));
    } else {
      for (const job of sortedJobs) jobs.append(jobCard(ctx, job));
    }

    const problemJobs = sortedJobs.filter((job) => job.error !== null);
    const problemOperations = overview.operations.filter(
      (operation) => operation.status === "conflict" || operation.status === "uncertain",
    );
    failures.replaceChildren(
      el("h3", { text: `需要處理的失敗（${problemJobs.length + problemOperations.length}）` }),
    );
    if (problemJobs.length === 0 && problemOperations.length === 0) {
      failures.append(emptyState("目前沒有失敗的工作或未確定／衝突的寫入操作。"));
    } else {
      for (const job of problemJobs) failures.append(failureCard(job));
      for (const operation of problemOperations) failures.append(failedOperationCard(operation));
    }

    const sortedSources = [...overview.sources].sort((a, b) => a.path.localeCompare(b.path));
    sources.replaceChildren(el("h3", { text: `來源健康狀態（${sortedSources.length}）` }));
    sources.append(
      el("p", {
        class: "hint",
        text: `伺服器允許的 OMP 來源根目錄：${overview.allowedOmpRoots.length === 0 ? "（未設定）" : overview.allowedOmpRoots.join("、")}`,
      }),
    );
    if (sortedSources.length === 0) {
      sources.append(emptyState("尚無已掃描的來源。"));
    } else {
      for (const source of sortedSources) sources.append(sourceCard(source));
    }
  }

  const panel: Surface = {
    id: "overview",
    title: "概覽",
    node,
    update,
    // 概覽是唯讀顯示，沒有使用者輸入，可隨時重繪。
    isDirty: () => false,
  };
  return panel;
}
