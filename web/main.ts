// 控制面板入口：建立 Surface、管理同源 API 狀態、以 5 秒輪詢維持資料新鮮，
// 並保證自動重繪不會覆蓋使用者正在編輯的表單或重複送出變更。

import type { Overview } from "../src/contracts";
import { ApiError, fetchOverview } from "./api";
import type { AppContext, AppState, Surface } from "./context";
import { button, type Child, el, notice } from "./dom";
import { createImportPanel } from "./panels/import";
import { createOverviewPanel } from "./panels/overview";
import { createReviewPanel } from "./panels/review";
import { createSettingsPanel } from "./panels/settings";

const POLL_INTERVAL_MS = 5_000;

function requireElement<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`控制面板缺少必要元素：${selector}`);
  return found;
}

const navList = requireElement<HTMLUListElement>("#nav-list");
const panelHost = requireElement<HTMLElement>("#panel-host");
const noticeRegion = requireElement<HTMLElement>("#notice-region");
const connectionStatus = requireElement<HTMLElement>("#connection-status");
const mutationStatus = requireElement<HTMLElement>("#mutation-status");
const refreshButton = requireElement<HTMLButtonElement>("#refresh-button");

let overview: Overview | null = null;
let rawSettings: unknown = null;
let fetchedAt = 0;
let selectedCandidateId: string | null = new URL(window.location.href).searchParams.get(
  "candidate",
);
let pendingMutations = 0;
let pollTimer: number | null = null;
let pollInFlight = false;
let currentPanelId = "overview";

const surfaces: Surface[] = [];

function currentState(): AppState | null {
  if (overview === null) return null;
  return { overview, rawSettings, fetchedAt };
}

// 只更新目前顯示的面板；每個 Surface 自行決定哪些區域可安全重繪，
// 因此輪詢永遠不會覆蓋使用者正在編輯的欄位。
function renderActiveSurface(): void {
  const surface = surfaces.find((item) => item.id === currentPanelId);
  if (surface === undefined) return;
  const state = currentState();
  if (state === null) return;
  surface.update(state);
}

function selectPanel(panelId: string): void {
  currentPanelId = panelId;
  for (const surface of surfaces) {
    surface.node.hidden = surface.id !== panelId;
  }
  for (const item of navList.querySelectorAll<HTMLAnchorElement>("a.nav-link")) {
    const active = item.dataset.panel === panelId;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
  const surface = surfaces.find((item) => item.id === panelId);
  if (surface === undefined) return;
  document.title = `${surface.title}｜SiYuan 知識整理與發布面板`;
  surface.activated?.();
  renderActiveSurface();
  window.location.hash = panelId;
}

function describeFailure(error: unknown): string {
  if (error instanceof ApiError) {
    const retry = error.retryable ? "（可重試）" : "（不可重試）";
    return `${error.message}｜代碼 ${error.code}｜階段 ${error.stage}${retry}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function renderMutationStatus(): void {
  mutationStatus.textContent =
    pendingMutations === 0 ? "" : `有 ${pendingMutations} 個變更正在送出，自動重新整理已暫停。`;
}

const ctx: AppContext = {
  get state(): AppState | null {
    return currentState();
  },
  get selectedCandidateId(): string | null {
    return selectedCandidateId;
  },
  async refresh(): Promise<void> {
    await load();
  },
  mutate(options): void {
    const node = options.button;
    const originalLabel = node?.textContent ?? "";
    if (node) {
      node.disabled = true;
      node.textContent = "處理中…";
    }
    pendingMutations += 1;
    renderMutationStatus();
    void (async () => {
      try {
        const message = await options.work();
        if (message !== null) ctx.notice("ok", message);
      } catch (error) {
        // 失敗訊息一律顯示，不吞掉；伺服器端已提供安全的繁體訊息。
        ctx.notice("danger", describeFailure(error));
      } finally {
        pendingMutations -= 1;
        if (node) {
          node.disabled = false;
          node.textContent = originalLabel;
        }
        renderMutationStatus();
        await load();
      }
    })();
  },
  notice(tone, message, detail): void {
    const node = notice(tone, detail === undefined ? message : `${message}\n${detail}`);
    noticeRegion.append(node);
    window.setTimeout(
      () => {
        node.remove();
      },
      tone === "danger" ? 20_000 : 10_000,
    );
  },
  openCandidate(candidateId: string): void {
    if (
      candidateId !== selectedCandidateId &&
      surfaces.find((surface) => surface.id === "review")?.isDirty() &&
      !window.confirm("切換候選會放棄尚未送出的修正，確定切換嗎？")
    )
      return;
    selectedCandidateId = candidateId;
    selectPanel("review");
  },
};

async function load(): Promise<void> {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const payload = await fetchOverview();
    overview = payload.parsed;
    rawSettings = payload.rawSettings;
    fetchedAt = Date.now();
    const failures = payload.parsed.jobs.filter((job) => job.error !== null).length;
    connectionStatus.textContent = `後端連線正常：${payload.parsed.jobs.length} 個工作${failures > 0 ? `，其中 ${failures} 個有錯誤` : ""}；最後更新 ${new Date(fetchedAt).toLocaleTimeString("zh-TW")}`;
    connectionStatus.className = "connection ok";
    if (surfaces.some((surface) => surface.node.parentElement !== panelHost)) {
      panelHost.replaceChildren(...surfaces.map((surface) => surface.node));
    }
    renderActiveSurface();
  } catch (error) {
    connectionStatus.textContent = `無法取得概覽資料：${describeFailure(error)}`;
    connectionStatus.className = "connection error";
    if (overview === null) {
      panelHost.replaceChildren(
        el("section", { class: "card" }, [
          el("h3", { text: "尚未取得資料" }),
          el("p", { class: "error-text", text: describeFailure(error) }),
          el("div", { class: "row-actions" }, [
            button("重試載入", () => {
              void load();
            }),
          ]),
        ]),
      );
    }
  } finally {
    pollInFlight = false;
  }
}

function startPolling(): void {
  if (pollTimer !== null) window.clearInterval(pollTimer);
  pollTimer = window.setInterval(() => {
    // 有未完成的變更或分頁不在前景時不輪詢，避免競態與無謂請求。
    if (pendingMutations > 0) return;
    if (document.hidden) return;
    void load();
  }, POLL_INTERVAL_MS);
}

function initialPanelId(): string {
  const hash = window.location.hash.replace(/^#/, "");
  return surfaces.some((surface) => surface.id === hash) ? hash : "overview";
}

function boot(): void {
  surfaces.push(
    createOverviewPanel(ctx),
    createImportPanel(ctx),
    createReviewPanel(ctx),
    createSettingsPanel(ctx),
  );

  const navItems: Child[] = surfaces.map((surface) =>
    el("li", {}, [
      el("a", {
        class: "nav-link",
        attrs: { href: `#${surface.id}` },
        data: { panel: surface.id },
        text: surface.title,
        on: {
          click: (event) => {
            event.preventDefault();
            selectPanel(surface.id);
          },
        },
      }),
    ]),
  );
  navList.replaceChildren(...navItems);
  panelHost.replaceChildren();

  for (const surface of surfaces) {
    surface.node.hidden = surface.id !== "overview";
    panelHost.append(surface.node);
  }

  refreshButton.addEventListener("click", () => {
    void load();
  });

  window.addEventListener("hashchange", () => {
    const next = initialPanelId();
    if (next !== currentPanelId) selectPanel(next);
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void load();
  });

  selectPanel(initialPanelId());
  startPolling();
  void load();
}

boot();
