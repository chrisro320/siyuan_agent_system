// 候選審閱面板：清單、詳情（證據對照、Jev 判定、發佈連結）、完整 CandidateDraft 編輯，
// 以及「重送 Jev」與「僅封存」。沒有跳過 Jev 的強制保留按鈕。

import {
  type Candidate,
  type CandidateDetail,
  type CandidateDraft,
  candidateDraftSchema,
  type Operation,
} from "../../src/contracts";
import { fetchCandidateDetail, reviewCandidate, undoOperation } from "../api";
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
  loadingState,
  markdown,
  notice,
  rawText,
  selectControl,
  textareaControl,
} from "../dom";
import {
  describeCandidateStatus,
  describeDisposition,
  describeDomain,
  describeInformationStatus,
  describeJudgmentAction,
  describeKind,
  describeOperationStatus,
  formatRelative,
  formatTime,
  noteHref,
  operationTargetLabel,
  stringifyValue,
} from "../format";

const KIND_OPTIONS = [
  { value: "conclusion", label: "conclusion（結論）" },
  { value: "decision", label: "decision（決策）" },
  { value: "method", label: "method（方法）" },
  { value: "project", label: "project（專案資訊）" },
  { value: "question", label: "question（問題）" },
  { value: "action", label: "action（待辦行動）" },
];

function textLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

// 目前後端沒有公開「依候選查詢來源訊息」的獨立端點，因此編輯證據時以既有的
// 證據錨點為底，並允許使用者調整訊息 ID 與引文；送出時仍由後端做存在性驗證。
interface EvidenceRow {
  messageId: string;
  quote: string;
}

interface DraftFormState {
  kind: string;
  title: string;
  summary: string;
  bodyMarkdown: string;
  topic: string;
  limitations: string;
  actions: string;
  uncertainties: string;
  evidence: EvidenceRow[];
}

function formStateFrom(draft: CandidateDraft): DraftFormState {
  return {
    kind: draft.kind,
    title: draft.title,
    summary: draft.summary,
    bodyMarkdown: draft.bodyMarkdown,
    topic: draft.topic,
    limitations: draft.limitations.join("\n"),
    actions: draft.actions.join("\n"),
    uncertainties: draft.uncertainties.join("\n"),
    evidence: draft.evidence.map((item) => ({ messageId: item.messageId, quote: item.quote })),
  };
}

function formStateTo(state: DraftFormState): unknown {
  return {
    kind: state.kind,
    title: state.title,
    summary: state.summary,
    bodyMarkdown: state.bodyMarkdown,
    topic: state.topic,
    limitations: textLines(state.limitations),
    actions: textLines(state.actions),
    uncertainties: textLines(state.uncertainties),
    evidence: state.evidence.map((item) => ({
      messageId: item.messageId.trim(),
      quote: item.quote,
    })),
  };
}

export function createReviewPanel(ctx: AppContext): Surface {
  const listNode = el("div", { class: "candidate-list" });
  const detailNode = el("div", { class: "candidate-detail" });
  const filterInput = inputControl({ placeholder: "以關鍵字過濾標題、摘要或主題" });
  const statusSelect = selectControl({
    options: [
      { value: "", label: "全部狀態" },
      { value: "review", label: "待審閱" },
      { value: "ready", label: "可發佈" },
      { value: "archive-only", label: "僅封存" },
      { value: "published", label: "已發佈" },
      { value: "duplicate", label: "重複內容" },
    ],
  });

  const node = el("div", { class: "panel panel-review" }, [
    el("aside", { class: "candidate-side" }, [
      el("section", { class: "card" }, [
        el("h3", { text: "候選清單" }),
        labelled("關鍵字", filterInput),
        labelled("狀態", statusSelect),
        hint("選取候選以檢視原始證據與 Jev 判定；需要修正時在右側編輯後重送 Jev。"),
      ]),
      listNode,
    ]),
    el("section", { class: "candidate-main" }, [detailNode]),
  ]);

  let detail: CandidateDetail | null = null;
  let loadingId: string | null = null;
  let detailError: string | null = null;
  let form: DraftFormState | null = null;
  let formBaseline = "";
  let lastRequestedId: string | null = null;
  let evidenceSlot: HTMLDivElement | null = null;
  let detailPublicUrl = "";

  function loadDetail(candidateId: string): void {
    loadingId = candidateId;
    detailError = null;
    lastRequestedId = candidateId;
    renderDetail();
    fetchCandidateDetail(candidateId)
      .then((value) => {
        if (lastRequestedId !== candidateId) return;
        detail = value;
        detailPublicUrl = ctx.state?.overview.providers.siyuanPublicUrl ?? "";
        form = formStateFrom(value.candidate.draft);
        formBaseline = JSON.stringify(form);
        loadingId = null;
        renderDetail();
      })
      .catch((error: unknown) => {
        if (lastRequestedId !== candidateId) return;
        detail = null;
        form = null;
        loadingId = null;
        detailError = error instanceof Error ? error.message : String(error);
        renderDetail();
      });
  }

  function renderEvidenceInto(slot: HTMLElement): void {
    if (form === null) {
      slot.replaceChildren();
      return;
    }
    // 以目前的編輯內容重繪對照區，讓使用者在改動證據 ID 後立刻看到對應結果。
    const draftValue: CandidateDraft = {
      kind: form.kind as CandidateDraft["kind"],
      title: form.title,
      summary: form.summary,
      bodyMarkdown: form.bodyMarkdown,
      topic: form.topic,
      limitations: textLines(form.limitations),
      actions: textLines(form.actions),
      uncertainties: textLines(form.uncertainties),
      evidence: form.evidence.map((item) => ({
        messageId: item.messageId.trim(),
        quote: item.quote,
      })),
    };
    slot.replaceChildren(renderEvidence(draftValue));
  }

  function renderEvidence(draftValue: CandidateDraft): HTMLElement {
    const sourceRecord = detail?.source ?? null;
    const messages = sourceRecord?.conversation.messages ?? [];
    const section = el("section", { class: "card" }, [el("h3", { text: "證據與原始訊息對照" })]);
    if (sourceRecord === null) {
      section.append(notice("warn", "此候選的原始匯入內容無法載入，因此無法對照。"));
      return section;
    }
    section.append(
      hint(
        `來源 ${sourceRecord.conversation.source}／session ${sourceRecord.conversation.sourceSessionId}／專案 ${sourceRecord.conversation.projectId}；匯入修訂 ${sourceRecord.revision}。`,
      ),
    );
    if (sourceRecord.conversation.warnings.length > 0) {
      section.append(notice("warn", `匯入警告：${sourceRecord.conversation.warnings.join("；")}`));
    }
    for (const evidence of draftValue.evidence) {
      const message = messages.find((item) => item.sourceMessageId === evidence.messageId) ?? null;
      const block = el("article", { class: "evidence-block" });
      block.append(
        el("div", { class: "row-head" }, [
          chip(
            message === null ? "找不到對應訊息" : "已對應原始訊息",
            message === null ? "danger" : "ok",
          ),
          el("span", { class: "mono", text: evidence.messageId }),
          message === null ? el("span") : chip(message.role, "neutral"),
          message?.timestamp
            ? el("span", { class: "hint", text: formatTime(message.timestamp) })
            : el("span"),
        ]),
      );
      block.append(el("h4", { text: "候選引文" }), rawText(evidence.quote, "quote-text"));
      if (message === null) {
        block.append(
          notice(
            "danger",
            "候選引用的訊息不存在於這份匯入內容中。後端會在寫入前以同一規則再次驗證並阻止發佈。",
          ),
        );
      } else {
        block.append(el("h4", { text: "原始訊息全文" }));
        block.append(rawText(message.text, "message-text"));
        if (message.missing.length > 0 || message.truncated) {
          block.append(
            notice(
              "warn",
              `原始訊息本身不完整${message.truncated ? "（已截斷）" : ""}${message.missing.length > 0 ? `；缺少欄位：${message.missing.join("、")}` : ""}。`,
            ),
          );
        }
        if (message.attachments.length > 0) {
          block.append(
            hint(
              `附件 ${message.attachments.length} 個，狀態：${message.attachments
                .map(
                  (item) =>
                    `${item.locator}（${item.status === "missing" ? "檔案不存在" : "未分析內容"}）`,
                )
                .join("；")}。附件內容未被分析。`,
            ),
          );
        }
        if (!message.text.includes(evidence.quote)) {
          block.append(
            notice("danger", "引文並非原始訊息中的連續片段，後端會視為無效證據並阻止發佈。"),
          );
        }
      }
      section.append(block);
    }
    section.append(
      el("details", { class: "raw-source" }, [
        el("summary", { text: `完整匯入原文（${messages.length} 則訊息）` }),
        rawText(JSON.stringify(sourceRecord.conversation, null, 2), "raw-text tall"),
      ]),
    );
    return section;
  }

  function renderJudgment(candidate: Candidate): HTMLElement {
    const section = el("section", { class: "card" }, [el("h3", { text: "Jev 保留判定" })]);
    const judgment = candidate.judgment;
    if (judgment === null) {
      section.append(
        notice("warn", "尚無 Jev 判定結果。沒有通過判定的候選不會自動發佈到 SiYuan。"),
      );
      return section;
    }
    const disposition = describeDisposition(judgment.disposition);
    const info = describeInformationStatus(judgment.informationStatus);
    const domain = describeDomain(judgment.domain);
    const action = describeJudgmentAction(judgment.action);
    const job = ctx.state?.overview.jobs.find((item) => item.id === candidate.jobId) ?? null;
    section.append(
      el("div", { class: "chip-row" }, [
        chip(`處置：${disposition.label}`, disposition.tone),
        chip(`資訊狀態：${info.label}`, info.tone),
        chip(`領域：${domain.label}`, domain.tone),
        chip(`建議動作：${action.label}`, action.tone),
      ]),
    );
    section.append(
      el("dl", { class: "kv" }, [
        el("dt", { text: "信心值" }),
        el("dd", { text: judgment.confidence.toFixed(3) }),
        el("dt", { text: "可重用價值" }),
        el("dd", { text: judgment.reusableValue.toFixed(3) }),
        el("dt", { text: "敏感度" }),
        el("dd", { text: judgment.sensitivity.toFixed(3) }),
        el("dt", { text: "判定模型" }),
        el("dd", { text: judgment.model }),
        el("dt", { text: "判定時的政策版本" }),
        el("dd", { text: String(judgment.policyRevision) }),
        el("dt", { text: "目前工作政策版本" }),
        el("dd", { text: job === null ? "（找不到對應工作）" : String(job.policyRevision) }),
      ]),
    );
    if (job !== null && job.policyRevision !== judgment.policyRevision) {
      section.append(
        notice(
          "warn",
          `此判定以政策版本 ${judgment.policyRevision} 產生，目前工作已使用版本 ${job.policyRevision}。若要依新規則重判，請使用「重新處理」或重新送出 Jev。`,
        ),
      );
    }
    const answers = Object.entries(judgment.answers);
    section.append(el("h4", { text: `Jev 逐題回答（${answers.length} 題）` }));
    if (answers.length === 0) {
      section.append(notice("danger", "判定結果沒有任何逐題回答，視為不完整，不得據此發佈。"));
    } else {
      const list = el("div", { class: "answers" });
      for (const [question, answer] of answers) {
        list.append(
          el("div", { class: "answer-row" }, [
            el("span", { class: "answer-question", text: question }),
            rawText(stringifyValue(answer), "answer-value"),
          ]),
        );
      }
      section.append(list);
    }
    section.append(el("h4", { text: "用量統計（供應商回報）" }));
    const usage = Object.entries(judgment.usage);
    if (usage.length === 0) {
      section.append(hint("供應商未回報用量欄位。"));
    } else {
      section.append(
        el(
          "ul",
          { class: "usage" },
          usage.map(([key, value]) => el("li", { text: `${key}：${value}` })),
        ),
      );
    }
    return section;
  }

  function renderPublication(operations: readonly Operation[]): HTMLElement {
    const section = el("section", { class: "card" }, [el("h3", { text: "發佈與操作紀錄" })]);
    if (operations.length === 0) {
      section.append(emptyState("此候選尚無任何寫入操作，因此沒有 SiYuan 連結。"));
      return section;
    }
    for (const operation of operations) {
      const status = describeOperationStatus(operation.status);
      const block = el("article", { class: "operation-block" });
      block.append(
        el("div", { class: "row-head" }, [
          chip(`操作：${status.label}`, status.tone),
          chip(operation.kind === "create" ? "建立筆記" : "附加內容", "neutral"),
          el("span", { class: "mono", text: operation.id }),
        ]),
      );
      block.append(
        el("dl", { class: "kv" }, [
          el("dt", { text: "筆記本" }),
          el("dd", { text: operation.notebookId }),
          el("dt", { text: "受管根目錄" }),
          el("dd", { text: operation.rootPath }),
          el("dt", { text: "文件路徑" }),
          el("dd", { text: operation.path }),
          el("dt", { text: "主題" }),
          el("dd", { text: operation.topic }),
          el("dt", { text: "文件 ID" }),
          el("dd", { text: operation.documentId }),
          el("dt", { text: "區塊 ID" }),
          el("dd", { text: operation.blockId }),
          el("dt", { text: "內容鍵" }),
          el("dd", { text: operation.contentKey }),
          el("dt", { text: "更新時間" }),
          el("dd", {
            text: `${formatTime(operation.updatedAt)}（${formatRelative(operation.updatedAt)}）`,
          }),
        ]),
      );
      if (operation.status === "verified" || operation.status === "undone") {
        const href = noteHref(
          operation.status === "undone" ? operation.documentId : operation.blockId,
          ctx.state?.overview.providers.siyuanPublicUrl,
        );
        block.append(
          el("p", {}, [
            el("span", { text: "開啟筆記：" }),
            el("a", {
              class: "md-link",
              attrs: { href, target: "_blank", rel: "noreferrer noopener" },
              text: "在 SiYuan 開啟",
            }),
          ]),
        );
      }
      if (operation.status === "undone") {
        block.append(
          notice("info", "此操作已撤回。若原內容仍存在於 SiYuan，代表有人在撤回後又重新寫入。"),
        );
      }
      if (operation.status === "conflict") {
        block.append(
          notice("danger", "內容已被人工修改，撤回會停止並顯示衝突，不會刪除或還原整份歷史內容。"),
        );
      }
      if (operation.status === "uncertain") {
        block.append(
          notice(
            "warn",
            "先前送出後未取得確定回應。後端會先對帳再決定是否重送，不會盲目重複附加。",
          ),
        );
      }
      if (operation.receipt !== null) {
        block.append(
          el("details", { class: "receipt" }, [
            el("summary", { text: "讀回憑證" }),
            el("dl", { class: "kv" }, [
              el("dt", { text: "內容雜湊" }),
              el("dd", { text: operation.receipt.contentHash }),
            ]),
            el("h4", { text: "讀回的 Markdown" }),
            rawText(operation.receipt.markdown, "raw-text"),
            el("h4", { text: "讀回的屬性" }),
            rawText(stringifyValue(operation.receipt.attributes), "raw-text"),
          ]),
        );
      }
      if (operation.error !== null) block.append(errorText(operation.error));
      block.append(el("h4", { text: "本操作寫入的內容" }), markdown(operation.markdown));

      if (operation.status === "verified" || operation.status === "undoing") {
        block.append(
          el("div", { class: "row-actions" }, [
            button(
              operation.status === "undoing" ? "再次嘗試撤回" : "撤回此筆寫入",
              (node) => {
                const confirmed = window.confirm(
                  `確定要撤回這筆由本系統寫入的內容嗎？\n\n操作 ID：${operation.id}\n目標：${operationTargetLabel(operation)}\n\n` +
                    "只會處理本系統擁有且內容未被修改的資料；若已被人工修改，撤回會停止並顯示衝突。",
                );
                if (!confirmed) {
                  ctx.notice("info", `已取消撤回操作 ${operation.id}。`);
                  return;
                }
                ctx.mutate({
                  button: node,
                  work: async () => {
                    await undoOperation(operation.id);
                    if (ctx.selectedCandidateId !== null) loadDetail(ctx.selectedCandidateId);
                    return `已送出撤回請求（操作 ${operation.id}），結果以操作狀態呈現。`;
                  },
                });
              },
              { variant: "danger" },
            ),
          ]),
        );
      }
      section.append(block);
    }
    return section;
  }

  function renderDraftEditor(candidate: Candidate): HTMLElement {
    const section = el("section", { class: "card" }, [
      el("h3", { text: "候選內容（完整 CandidateDraft）" }),
      hint(
        "可編輯欄位與後端 CandidateDraft 契約一對一。證據必須對應匯入原文中的訊息與連續引文，否則後端會拒絕。",
      ),
    ]);
    if (form === null) return section;

    const kindSelect = selectControl({ options: KIND_OPTIONS, value: form.kind });
    kindSelect.addEventListener("change", () => {
      form = form === null ? null : { ...form, kind: kindSelect.value };
    });
    const titleInput = inputControl({ value: form.title, required: true });
    titleInput.addEventListener("input", () => {
      form = form === null ? null : { ...form, title: titleInput.value };
    });
    const topicInput = inputControl({ value: form.topic });
    topicInput.addEventListener("input", () => {
      form = form === null ? null : { ...form, topic: topicInput.value };
    });
    const summaryArea = textareaControl({ value: form.summary, rows: 4 });
    summaryArea.addEventListener("input", () => {
      form = form === null ? null : { ...form, summary: summaryArea.value };
    });
    const bodyArea = textareaControl({ value: form.bodyMarkdown, rows: 12 });
    bodyArea.addEventListener("input", () => {
      form = form === null ? null : { ...form, bodyMarkdown: bodyArea.value };
    });
    const limitationsArea = textareaControl({ value: form.limitations, rows: 3 });
    limitationsArea.addEventListener("input", () => {
      form = form === null ? null : { ...form, limitations: limitationsArea.value };
    });
    const actionsArea = textareaControl({ value: form.actions, rows: 3 });
    actionsArea.addEventListener("input", () => {
      form = form === null ? null : { ...form, actions: actionsArea.value };
    });
    const uncertaintiesArea = textareaControl({ value: form.uncertainties, rows: 3 });
    uncertaintiesArea.addEventListener("input", () => {
      form = form === null ? null : { ...form, uncertainties: uncertaintiesArea.value };
    });

    section.append(
      labelled("類型", kindSelect),
      labelled("標題", titleInput),
      labelled("主題", topicInput),
      labelled("摘要", summaryArea),
      labelled("內容（Markdown）", bodyArea),
      labelled("限制（每行一項）", limitationsArea),
      labelled("後續行動（每行一項）", actionsArea),
      labelled("不確定處（每行一項）", uncertaintiesArea),
    );

    const evidenceSection = el("div", { class: "evidence-editor" }, [el("h4", { text: "證據" })]);
    for (const [index, row] of form.evidence.entries()) {
      const idInput = inputControl({ value: row.messageId });
      idInput.addEventListener("input", () => {
        if (form !== null && form.evidence[index] !== undefined)
          form.evidence[index].messageId = idInput.value;
        if (evidenceSlot !== null) renderEvidenceInto(evidenceSlot);
      });
      const quoteArea = textareaControl({ value: row.quote, rows: 3 });
      quoteArea.addEventListener("input", () => {
        if (form !== null && form.evidence[index] !== undefined)
          form.evidence[index].quote = quoteArea.value;
        if (evidenceSlot !== null) renderEvidenceInto(evidenceSlot);
      });
      evidenceSection.append(
        el("article", { class: "evidence-block" }, [
          labelled(`證據 ${index + 1}：原始訊息 ID`, idInput),
          labelled("引文（必須是原文中的連續片段）", quoteArea),
          el("div", { class: "row-actions" }, [
            button(
              "移除這筆證據",
              () => {
                if (form === null) return;
                form.evidence.splice(index, 1);
                renderDetail();
              },
              { variant: "danger", disabled: form.evidence.length <= 1 },
            ),
          ]),
        ]),
      );
    }
    evidenceSection.append(
      el("div", { class: "row-actions" }, [
        button("新增一筆證據", () => {
          if (form === null) return;
          form.evidence.push({ messageId: "", quote: "" });
          renderDetail();
        }),
      ]),
    );
    section.append(evidenceSection);

    const submitRow = el("div", { class: "row-actions" });
    submitRow.append(
      button(
        "儲存修正並重送 Jev",
        (node) => {
          if (form === null) return;
          const payload = formStateTo(form);
          const validated = candidateDraftSchema.safeParse(payload);
          if (!validated.success) {
            ctx.notice(
              "danger",
              `修正後的候選內容未通過契約檢查，未送出：${validated.error.issues
                .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
                .join("；")}`,
            );
            return;
          }
          ctx.mutate({
            button: node,
            work: async () => {
              // 以讀取當下的 version 送審，避免覆蓋其他人／流程期間產生的新版本。
              const submittedForm = JSON.stringify(form);
              const result = await reviewCandidate(
                candidate.id,
                candidate.version,
                "rejudge",
                validated.data,
              );
              formBaseline = submittedForm;
              ctx.openCandidate(result.candidateId);
              return `已送出修正並重送 Jev 判定（基準版本 ${candidate.version}）。`;
            },
          });
        },
        { variant: "primary" },
      ),
    );
    submitRow.append(
      button(
        "僅封存（不發佈）",
        (node) => {
          const confirmed = window.confirm(
            `確定要把候選「${candidate.draft.title}」標記為僅封存嗎？\n\n版本：${candidate.version}\n` +
              "內容會保留供日後查閱，但不會寫入 SiYuan。此操作需要人工明確決定。",
          );
          if (!confirmed) {
            ctx.notice("info", "已取消封存。");
            return;
          }
          ctx.mutate({
            button: node,
            work: async () => {
              await reviewCandidate(candidate.id, candidate.version, "archive");
              if (ctx.selectedCandidateId !== null) loadDetail(ctx.selectedCandidateId);
              return `候選 ${candidate.id} 已標記為僅封存（基準版本 ${candidate.version}）。`;
            },
          });
        },
        { variant: "danger" },
      ),
    );
    submitRow.append(
      button(
        "不修改內容，重新送 Jev 判定",
        (node) => {
          if (
            form !== null &&
            JSON.stringify(form) !== formBaseline &&
            !window.confirm("這次只重送已儲存的候選，不會送出目前草稿修正。確定繼續嗎？")
          )
            return;
          ctx.mutate({
            button: node,
            work: async () => {
              const submittedForm = JSON.stringify(form);
              const result = await reviewCandidate(candidate.id, candidate.version, "rejudge");
              formBaseline = submittedForm;
              ctx.openCandidate(result.candidateId);
              return `已要求以目前內容重送 Jev（基準版本 ${candidate.version}），未附帶草稿修改。`;
            },
          });
        },
        { title: "不修改草稿，只重新判定" },
      ),
    );
    section.append(submitRow);
    section.append(
      hint(
        `目前候選版本 ${candidate.version}，最後更新 ${formatTime(candidate.updatedAt)}。若期間有其他人修正，送審會因版本不符而失敗，面板不會覆蓋較新的版本。`,
      ),
    );

    section.append(el("h4", { text: "內容預覽" }));
    section.append(markdown(form.bodyMarkdown));

    const jsonArea = textareaControl({
      rows: 16,
      value: JSON.stringify(formStateTo(form), null, 2),
    });
    const jsonApply = button("以 JSON 覆蓋上方欄位", () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonArea.value) as unknown;
      } catch (error) {
        ctx.notice(
          "danger",
          `JSON 解析失敗：${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      const validated = candidateDraftSchema.safeParse(parsed);
      if (!validated.success) {
        ctx.notice(
          "danger",
          `JSON 未通過 CandidateDraft 契約：${validated.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
            .join("；")}`,
        );
        return;
      }
      form = formStateFrom(validated.data);
      renderDetail();
      ctx.notice("ok", "已套用 JSON 內容，記得按「儲存修正並重送 Jev」才會送出。");
    });
    section.append(
      el("details", { class: "json-editor" }, [
        el("summary", { text: "JSON 編輯器（完整 CandidateDraft）" }),
        hint("貼上完整 JSON 物件後按下方按鈕套用；欄位仍會先以共享 schema 驗證。"),
        jsonArea,
        el("div", { class: "row-actions" }, [jsonApply]),
      ]),
    );
    return section;
  }

  function renderDetail(): void {
    if (loadingId !== null) {
      detailNode.replaceChildren(loadingState(`正在載入候選 ${loadingId} 的詳情…`));
      return;
    }
    if (detailError !== null) {
      detailNode.replaceChildren(
        el("section", { class: "card" }, [
          el("h3", { text: "載入失敗" }),
          errorText(detailError),
          el("div", { class: "row-actions" }, [
            button("重新載入", () => {
              if (lastRequestedId !== null) loadDetail(lastRequestedId);
            }),
          ]),
        ]),
      );
      return;
    }
    if (detail === null) {
      detailNode.replaceChildren(
        el("section", { class: "card" }, [
          el("h3", { text: "候選詳情" }),
          emptyState("從左側清單選擇一個候選，即可檢視證據對照、Jev 判定與發佈結果。"),
        ]),
      );
      return;
    }
    const candidate = detail.candidate;
    const status = describeCandidateStatus(candidate.status);
    const kind = describeKind(candidate.draft.kind);
    const header = el("section", { class: "card" }, [
      el("div", { class: "chip-row" }, [
        chip(`狀態：${status.label}`, status.tone),
        chip(`類型：${kind.label}`, kind.tone),
        chip(`版本 ${candidate.version}`, "neutral"),
        chip(`模型 ${candidate.generation.model}`, "neutral"),
        chip(`提示版本 ${candidate.generation.promptVersion}`, "neutral"),
      ]),
      el("h3", { text: candidate.draft.title }),
      el("p", { class: "summary", text: candidate.draft.summary }),
      hint(
        `候選 ID ${candidate.id}｜邏輯 ID ${candidate.logicalId}｜工作 ${candidate.jobId}｜匯入 ${candidate.importId}｜建立於 ${formatTime(candidate.createdAt)}`,
      ),
    ]);
    if (candidate.relatedIds.length > 0) {
      header.append(
        el("p", { class: "hint", text: `相關候選：${candidate.relatedIds.join("、")}` }),
      );
    }
    if (candidate.operationId !== null) {
      header.append(el("p", { class: "hint", text: `發佈操作：${candidate.operationId}` }));
    }
    const evidenceContainer = el("div", { class: "evidence-live" });
    evidenceSlot = evidenceContainer;
    renderEvidenceInto(evidenceContainer);
    detailNode.replaceChildren(
      header,
      evidenceContainer,
      renderJudgment(candidate),
      renderPublication(detail.operations),
      renderDraftEditor(candidate),
    );
  }

  function renderList(state: AppState): void {
    const keyword = filterInput.value.trim().toLowerCase();
    const statusFilter = statusSelect.value;
    const candidates = state.overview.candidates
      .filter((candidate) => (statusFilter === "" ? true : candidate.status === statusFilter))
      .filter((candidate) => {
        if (keyword === "") return true;
        return (
          candidate.draft.title.toLowerCase().includes(keyword) ||
          candidate.draft.summary.toLowerCase().includes(keyword) ||
          candidate.draft.topic.toLowerCase().includes(keyword)
        );
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    listNode.replaceChildren();
    if (candidates.length === 0) {
      listNode.append(emptyState("沒有符合條件的候選。匯入內容後，抽取結果會出現在這裡。"));
      return;
    }
    for (const candidate of candidates) {
      const status = describeCandidateStatus(candidate.status);
      const disposition =
        candidate.judgment === null ? null : describeDisposition(candidate.judgment.disposition);
      const item = el("button", { class: "candidate-item", attrs: { type: "button" } });
      item.classList.toggle("selected", candidate.id === ctx.selectedCandidateId);
      item.append(
        el("span", { class: "candidate-title", text: candidate.draft.title }),
        el("span", { class: "chip-row" }, [
          chip(status.label, status.tone),
          disposition === null
            ? chip("尚無 Jev 判定", "warn")
            : chip(disposition.label, disposition.tone),
        ]),
        el("span", {
          class: "hint",
          text: `${candidate.draft.topic}｜${formatRelative(candidate.updatedAt)}`,
        }),
      );
      item.addEventListener("click", () => {
        ctx.openCandidate(candidate.id);
      });
      listNode.append(item);
    }
  }

  filterInput.addEventListener("input", () => {
    if (ctx.state !== null) renderList(ctx.state);
  });
  statusSelect.addEventListener("change", () => {
    if (ctx.state !== null) renderList(ctx.state);
  });

  function update(state: AppState): void {
    renderList(state);
    if (
      ctx.selectedCandidateId !== null &&
      detail?.candidate.id !== ctx.selectedCandidateId &&
      loadingId !== ctx.selectedCandidateId
    ) {
      loadDetail(ctx.selectedCandidateId);
    } else if (
      detail !== null &&
      loadingId === null &&
      form !== null &&
      JSON.stringify(form) === formBaseline
    ) {
      const current = state.overview.candidates.find(
        (candidate) => candidate.id === detail?.candidate.id,
      );
      const operations = state.overview.operations.filter(
        (operation) =>
          operation.candidateId === detail?.candidate.id || operation.id === current?.operationId,
      );
      if (
        current?.version !== detail.candidate.version ||
        JSON.stringify(operations) !== JSON.stringify(detail.operations) ||
        detailPublicUrl !== state.overview.providers.siyuanPublicUrl
      )
        loadDetail(detail.candidate.id);
    }
  }

  return {
    id: "review",
    title: "候選審閱",
    node,
    update,
    isDirty: () => form !== null && JSON.stringify(form) !== formBaseline,
    activated: () => {
      if (ctx.state !== null) {
        renderList(ctx.state);
        if (ctx.selectedCandidateId !== null && detail === null)
          loadDetail(ctx.selectedCandidateId);
      }
    },
  };
}
