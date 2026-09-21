// 專案心智面板：列出 active 與 proposal 心智卡、版本與來源、手動優先順序，
// 支援 JSON 編輯與 proposal 採納（帶目前 active 的 baseRevision）。

import { type MentalCard, type MentalContent, mentalContentSchema } from "../../src/contracts";
import { acceptMental, saveMentalEdit } from "../api";
import type { AppContext, AppState, Surface } from "../context";
import {
  button,
  chip,
  el,
  emptyState,
  hint,
  inputControl,
  labelled,
  notice,
  rawText,
  textareaControl,
} from "../dom";
import { describeAuthor, describeCardStatus, formatTime } from "../format";

const SECTION_LABELS: Record<keyof MentalContent, string> = {
  goals: "目前目標",
  decisions: "已確認決策",
  constraints: "限制條件",
  terminology: "術語",
  superseded: "已被取代的結論",
};

function contentRows(container: HTMLElement, content: MentalContent): void {
  for (const key of Object.keys(SECTION_LABELS) as (keyof MentalContent)[]) {
    const section = el("section", { class: "mental-section" }, [
      el("h4", { text: SECTION_LABELS[key] }),
    ]);
    const claims = content[key];
    if (claims.length === 0) {
      section.append(el("p", { class: "empty", text: "（無）" }));
    }
    for (const claim of claims) {
      section.append(
        el("div", { class: "claim" }, [
          el("p", { class: "claim-text", text: claim.text }),
          el("p", { class: "hint", text: `來源：${claim.sources.join("、")}` }),
        ]),
      );
    }
    container.append(section);
  }
}

// 手動編輯採「人類優先」：編輯結果以 author:human 送出，模型提案不得覆蓋。
function buildEditor(
  ctx: AppContext,
  projectId: string,
  card: MentalCard,
  activeCard: MentalCard | null,
  onClose: () => void,
): HTMLElement {
  const editor = el("section", { class: "card editor-card" }, [
    el("h3", { text: "人工編輯心智卡" }),
    hint(
      "送出後會以此內容建立新修訂並標記為人工來源，優先於模型提案。來源 ID 必須是既有候選或來源識別。",
    ),
  ]);
  const area = textareaControl({
    rows: 24,
    value: JSON.stringify(card.content, null, 2),
  });
  const statusSlot = el("div", { class: "status-slot" });
  editor.append(labelled("MentalContent JSON", area));
  editor.append(
    el("div", { class: "row-actions" }, [
      button(
        "送出人工修訂",
        (node) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(area.value) as unknown;
          } catch (error) {
            statusSlot.replaceChildren(
              notice(
                "danger",
                `JSON 解析失敗：${error instanceof Error ? error.message : String(error)}`,
              ),
            );
            return;
          }
          const validated = mentalContentSchema.safeParse(parsed);
          if (!validated.success) {
            statusSlot.replaceChildren(
              notice(
                "danger",
                `未通過 MentalContent 契約：${validated.error.issues
                  .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
                  .join("；")}`,
              ),
            );
            return;
          }
          const base =
            card.status === "proposal" && activeCard !== null ? activeCard.revision : card.revision;
          ctx.mutate({
            button: node,
            work: async () => {
              await saveMentalEdit(projectId, base, validated.data);
              onClose();
              return `已建立 ${projectId} 的心智卡人工修訂（基準版本 ${base}）。`;
            },
          });
        },
        { variant: "primary" },
      ),
      button("還原成目前內容", () => {
        area.value = JSON.stringify(card.content, null, 2);
        statusSlot.replaceChildren(notice("info", "已還原欄位，尚未送出。"));
      }),
      button("關閉編輯器", () => {
        onClose();
      }),
    ]),
  );
  editor.append(statusSlot);
  return editor;
}

export function createMentalPanel(ctx: AppContext): Surface {
  const listNode = el("div", { class: "mental-list" });
  // 編輯器放在獨立槽位：輪詢重建清單時不會摧毀使用者已開啟但未送出的編輯內容。
  const editorSlot = el("div", { class: "editor-slot" });
  const selectedProject = inputControl({ placeholder: "輸入專案 ID 以篩選" });
  const filterSection = el("section", { class: "card" }, [
    el("h3", { text: "專案心智卡" }),
    hint(
      "心智卡是專案的衍生摘要，不是原始對話或 SiYuan 內容的權威來源。模型提案需人工採納才會生效；人工修訂一律優先。",
    ),
    labelled("專案篩選", selectedProject),
  ]);
  const node = el("div", { class: "panel panel-mental" }, [filterSection, editorSlot, listNode]);
  selectedProject.addEventListener("input", () => {
    if (ctx.state !== null) renderList(ctx.state);
  });

  function closeEditor(): void {
    editorSlot.replaceChildren();
  }

  function openEditor(projectId: string, card: MentalCard, activeCard: MentalCard | null): void {
    editorSlot.replaceChildren(buildEditor(ctx, projectId, card, activeCard, closeEditor));
    editorSlot.scrollIntoView({ block: "nearest" });
  }

  function renderList(state: AppState): void {
    const cards = state.overview.mentalCards;
    const filter = selectedProject.value.trim();
    const visible = filter === "" ? cards : cards.filter((card) => card.projectId.includes(filter));
    listNode.replaceChildren();
    if (visible.length === 0) {
      listNode.append(
        emptyState("目前沒有符合條件的心智卡。已確認的發佈內容可能觸發模型提出新修訂。"),
      );
      return;
    }
    const projects = [...new Set(visible.map((card) => card.projectId))].sort();
    for (const projectId of projects) {
      const projectCards = visible
        .filter((card) => card.projectId === projectId)
        .sort((a, b) => b.revision - a.revision);
      const activeCard = projectCards.find((card) => card.status === "active") ?? null;
      const proposals = projectCards.filter((card) => card.status === "proposal");
      const history = projectCards;
      const section = el("section", { class: "card project-card" }, [
        el("h3", { text: `專案：${projectId}` }),
      ]);
      section.append(
        el("div", { class: "chip-row" }, [
          activeCard === null
            ? chip("尚無生效心智卡", "warn")
            : chip(`生效版本 revision ${activeCard.revision}`, "ok"),
          chip(`提案 ${proposals.length} 件`, proposals.length > 0 ? "warn" : "neutral"),
          chip(`歷史修訂 ${history.length} 件`, "neutral"),
        ]),
      );
      if (activeCard !== null) {
        const activeBlock = el("article", { class: "mental-block" }, [
          el("div", { class: "row-head" }, [
            chip(describeCardStatus(activeCard.status).label, "ok"),
            chip(describeAuthor(activeCard.author).label, describeAuthor(activeCard.author).tone),
            chip(
              `手動優先：${activeCard.author === "human" ? "是" : "否"}`,
              activeCard.author === "human" ? "ok" : "neutral",
            ),
            el("span", { class: "hint", text: `建立於 ${formatTime(activeCard.createdAt)}` }),
          ]),
        ]);
        if (activeCard.candidateId !== null) {
          activeBlock.append(
            el("p", { class: "hint" }, [
              el("span", { text: "來源候選：" }),
              el("button", {
                class: "link-button",
                attrs: { type: "button" },
                text: activeCard.candidateId,
                on: {
                  click: () => {
                    ctx.openCandidate(activeCard.candidateId ?? "");
                  },
                },
              }),
            ]),
          );
        }
        if (activeCard.generation !== null) {
          activeBlock.append(
            el("p", {
              class: "hint",
              text: `模型 ${activeCard.generation.model}｜提示版本 ${activeCard.generation.promptVersion}`,
            }),
          );
        }
        const contentBlock = el("div", { class: "mental-content" });
        contentRows(contentBlock, activeCard.content);
        activeBlock.append(
          el("details", { open: true }, [el("summary", { text: "生效內容" }), contentBlock]),
        );
        activeBlock.append(
          el("details", {}, [
            el("summary", { text: "原始 JSON" }),
            rawText(JSON.stringify(activeCard.content, null, 2), "raw-text tall"),
          ]),
        );
        activeBlock.append(
          el("div", { class: "row-actions" }, [
            button("以此版本為底編輯", () => {
              openEditor(projectId, activeCard, activeCard);
            }),
          ]),
        );
        section.append(activeBlock);
      }

      for (const proposal of proposals) {
        const block = el("article", { class: "mental-block proposal" }, [
          el("div", { class: "row-head" }, [
            chip(describeCardStatus(proposal.status).label, "warn"),
            chip(describeAuthor(proposal.author).label, describeAuthor(proposal.author).tone),
            chip(`revision ${proposal.revision}`, "neutral"),
            chip(`baseRevision ${proposal.baseRevision}`, "neutral"),
            el("span", { class: "hint", text: formatTime(proposal.createdAt) }),
          ]),
        ]);
        const contentBlock = el("div", { class: "mental-content" });
        contentRows(contentBlock, proposal.content);
        block.append(
          el("details", { open: true }, [el("summary", { text: "提案內容" }), contentBlock]),
        );
        const baseRevision = activeCard === null ? proposal.baseRevision : activeCard.revision;
        block.append(
          el("p", {
            class: "hint",
            text:
              activeCard === null
                ? "目前沒有生效卡片；採納會直接建立生效修訂。"
                : `採納時將以目前生效版本 revision ${activeCard.revision} 作為 baseRevision，避免覆蓋期間的新修訂。`,
          }),
        );
        block.append(
          el("div", { class: "row-actions" }, [
            button(
              "採納此提案",
              (node) => {
                ctx.mutate({
                  button: node,
                  work: async () => {
                    await acceptMental(proposal.id, baseRevision);
                    return `已採納提案 ${proposal.id}（baseRevision ${baseRevision}）。`;
                  },
                });
              },
              { variant: "primary" },
            ),
            button("以此提案為底編輯", () => {
              openEditor(projectId, proposal, activeCard);
            }),
          ]),
        );
        block.append(
          el("details", {}, [
            el("summary", { text: "原始 JSON" }),
            rawText(JSON.stringify(proposal.content, null, 2), "raw-text tall"),
          ]),
        );
        section.append(block);
      }

      const historyList = el("details", { class: "history" }, [
        el("summary", { text: `修訂歷史（${history.length}）` }),
      ]);
      for (const card of history) {
        const entry = el("article", { class: "history-entry" }, [
          el("div", { class: "row-head" }, [
            chip(`revision ${card.revision}`, "neutral"),
            chip(describeCardStatus(card.status).label, describeCardStatus(card.status).tone),
            chip(describeAuthor(card.author).label, describeAuthor(card.author).tone),
            el("span", { class: "hint", text: formatTime(card.createdAt) }),
          ]),
        ]);
        const sourceIds = [
          ...new Set(
            Object.values(card.content).flatMap((claims) =>
              claims.flatMap((claim) => claim.sources),
            ),
          ),
        ];
        entry.append(
          hint(
            `來源 ID（${sourceIds.length}）：${sourceIds.length === 0 ? "（無）" : sourceIds.join("、")}`,
          ),
        );
        if (card.candidateId !== null) entry.append(hint(`觸發候選：${card.candidateId}`));
        const contentBlock = el("div", { class: "mental-content" });
        contentRows(contentBlock, card.content);
        entry.append(contentBlock);
        historyList.append(entry);
      }
      section.append(historyList);
      listNode.append(section);
    }
  }

  return {
    id: "mental",
    title: "專案心智",
    node,
    update: (state: AppState) => {
      renderList(state);
    },
    isDirty: () => document.activeElement !== null && node.contains(document.activeElement),
    activated: () => {
      if (ctx.state !== null) renderList(ctx.state);
    },
  };
}
