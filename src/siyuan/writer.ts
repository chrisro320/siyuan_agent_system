import {
  AppError,
  type Candidate,
  type Destination,
  type ImportRecord,
  type Operation,
  operationSchema,
  validateEvidence,
} from "../contracts";
import { digest } from "../storage/identity";
import {
  AGENT_ATTR,
  AGENT_OWNER,
  type BlockReadback,
  isNodeId,
  isSafeHref,
  rootScope,
  type SiyuanClient,
  withinRoot,
} from "./client";

function nodeId(seed: string, now: string): string {
  return `${now.replace(/\D/g, "").slice(0, 14)}-${digest(seed).slice(0, 7)}`;
}

function segment(value: string): string {
  return (
    value
      .normalize("NFC")
      .replace(/[\\/:*?"<>|\r\n]/g, "_")
      .replaceAll("\0", "_")
      .replace(/\.{2,}/g, "_")
      .trim()
      .slice(0, 60) || "未分類"
  );
}

function inline(value: string): string {
  return value.replace(/[\\`*_[\]{}<>#]/g, "\\$&").replace(/[\r\n]+/g, " ");
}

function attribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/[\r\n]/g, " ");
}

/** 圍籬以引用層級與 marker 配對；開頭與收尾的合法縮排可不同。 */
interface Fence {
  quoteDepth: number;
  marker: string;
}

function nextFence(line: string, current: Fence | null): Fence | null {
  const prefix = /^((?: {0,3}>)+ {0,3}| {0,3})/.exec(line)?.[0] ?? "";
  let quoteDepth = 0;
  for (const character of prefix) if (character === ">") quoteDepth += 1;
  const content = line.slice(prefix.length);
  if (current) {
    const close = /^(`+|~+)[ \t]*$/.exec(content)?.[1];
    if (!close || quoteDepth !== current.quoteDepth || close[0] !== current.marker[0])
      return current;
    return close.length >= current.marker.length ? null : current;
  }
  const open = /^(`{3,}|~{3,})(.*)$/.exec(content);
  if (!open?.[1] || (open[1][0] === "`" && open[2]?.includes("`"))) return null;
  return { quoteDepth, marker: open[1] };
}

/** Generated text cannot escape its owned superblock or assign foreign block IDs. */
function checkedMarkdown(markdown: string): string {
  let fence: Fence | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const inside = fence !== null;
    fence = nextFence(line, fence);
    if (!inside && !fence && /\{\{|\}\}\}|\{:/.test(line)) {
      throw new AppError(
        "unsafe_note_markup",
        "候選含有可改變思源區塊身分的語法，請先人工修正。",
        false,
        409,
      );
    }
  }
  if (fence)
    throw new AppError(
      "unsafe_note_markup",
      "候選有未關閉的程式碼區塊，請先人工修正。",
      false,
      409,
    );
  return markdown.trim();
}

/**
 * 思源在行內程式碼邊界補上的零寬空格（U+200B）。
 *
 * Lute 產生 Protyle DOM 時會在行內程式碼的收尾標記後固定補一個零寬空格
 * （`render/protyle_renderer.go` 的 `renderCodeSpanCloseMarker`），再於讀回的行內程式碼
 * 開頭前留下一個；使用者原本緊貼程式碼邊界的零寬空格則會被保留或被吃掉。因此「緊貼
 * 行內程式碼邊界的零寬空格」在儲存後分不出是使用者寫的還是思源補的。
 */
const ZWSP = "\u200b";

/** 去掉緊貼行內程式碼邊界的 U+200B；程式碼內容與其他位置的零寬空格一律保留。 */
function withoutCodeBoundaryZwsp(line: string): string {
  if (!line.includes(ZWSP)) return line;
  const runs: { start: number; end: number; escaped: boolean }[] = [];
  for (let index = 0; index < line.length; ) {
    if (line[index] !== "`") {
      index += 1;
      continue;
    }
    let slashes = 0;
    for (let before = index - 1; before >= 0 && line[before] === "\\"; before -= 1) slashes += 1;
    let end = index;
    while (end < line.length && line[end] === "`") end += 1;
    // `\`` 是跳脫後的字面反引號，不是行內程式碼的開頭。
    runs.push({ start: index, end, escaped: slashes % 2 === 1 });
    index = end;
  }
  const dropped = new Set<number>();
  let open: { start: number; end: number } | null = null;
  for (const run of runs) {
    if (!open) {
      if (!run.escaped) open = run;
      continue;
    }
    // 收尾的反引號長度必須與開頭完全相同，否則那一段只是程式碼內容。
    if (run.end - run.start !== open.end - open.start) continue;
    for (let index = open.start - 1; index >= 0 && line[index] === ZWSP; index -= 1)
      dropped.add(index);
    for (let index = run.end; index < line.length && line[index] === ZWSP; index += 1)
      dropped.add(index);
    open = null;
  }
  if (dropped.size === 0) return line;
  let result = "";
  for (let index = 0; index < line.length; index += 1)
    if (!dropped.has(index)) result += line[index];
  return result;
}

/**
 * Only SiYuan-generated IALs and inline-code boundary zero-width spaces outside fenced code
 * are omitted during first read-back.
 */
export function canonicalMarkdown(markdown: string): string {
  let fence: Fence | null = null;
  const lines: string[] = [];
  const input = markdown.replace(/\r\n/g, "\n").split("\n");
  const ialLine = /^\s*(?:>\s*)*\{:(?:[^{}"]|"[^"]*")*\}\s*$/;
  for (const [index, line] of input.entries()) {
    const inside = fence !== null;
    fence = nextFence(line, fence);
    if (inside || fence) {
      lines.push(line);
      continue;
    }
    if (ialLine.test(line)) continue;
    // SiYuan emits an empty quote marker immediately before its blockquote IAL.
    if (/^(?:\s*>)+\s*$/.test(line) && ialLine.test(input[index + 1] ?? "")) continue;
    lines.push(withoutCodeBoundaryZwsp(line.replace(/\{:(?:[^{}"]|"[^"]*")*\}/g, "")));
  }
  return lines.join("\n").replace(/\n+$/, "");
}

function sameAttributes(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

function noteMarkdown(candidate: Candidate, source: ImportRecord, panelOrigin: string): string {
  const draft = candidate.draft;
  const parts = [
    `## ${inline(draft.title)}`,
    inline(draft.summary),
    checkedMarkdown(draft.bodyMarkdown),
  ];
  for (const [title, items] of [
    ["適用範圍與限制", draft.limitations],
    ["後續行動", draft.actions],
    ["尚未確認", draft.uncertainties],
  ] as const) {
    if (items.length)
      parts.push(`### ${title}\n\n${items.map((item) => `- ${inline(item)}`).join("\n")}`);
  }
  parts.push(
    "### 原始依據",
    `[在控制面板查看證據](${panelOrigin}/?candidate=${encodeURIComponent(candidate.id)}#review)`,
  );
  const locator = source.conversation.sourceLocator;
  if (locator && isSafeHref(locator))
    parts.push(`[開啟來源](${new URL(locator).href.replace(/\(/g, "%28").replace(/\)/g, "%29")})`);
  parts.push(
    `來源：${inline(source.conversation.source)} / ${inline(source.conversation.sourceSessionId)}\n\n來源修訂：${source.revision}`,
  );
  for (const evidence of draft.evidence) {
    const message = source.conversation.messages.find(
      (item) => item.sourceMessageId === evidence.messageId,
    );
    parts.push(
      `訊息：${inline(evidence.messageId)}；原始位置：${inline(message?.rawLocator ?? "未知")}`,
    );
    parts.push(
      evidence.quote
        .split(/\r?\n/)
        .map((line) => `> ${inline(line)}`)
        .join("\n"),
    );
  }
  return parts.join("\n\n");
}

export class SiyuanWriter {
  constructor(
    private readonly client: SiyuanClient,
    private readonly save: (operation: Operation) => unknown,
    private readonly panelOrigin: string,
  ) {}

  plan(
    candidate: Candidate,
    destination: Destination,
    source: ImportRecord,
    appendDocumentId?: string,
  ): Operation {
    if (
      candidate.projectId !== destination.projectId ||
      candidate.projectId !== source.conversation.projectId ||
      candidate.judgment?.disposition !== "retain" ||
      !["create", "append"].includes(candidate.judgment.action)
    ) {
      throw new AppError("publication_denied", "候選沒有適用於此專案的 Jev 發佈授權。", false, 409);
    }
    validateEvidence(candidate.draft, source.conversation.messages);
    if (appendDocumentId && !isNodeId(appendDocumentId))
      throw new AppError("invalid_block_id", "追加目標識別碼不正確。");
    const { evidence: _evidence, ...knowledge } = candidate.draft;
    const contentKey = digest(JSON.stringify([candidate.projectId, knowledge]));
    const id = digest(`publish:${contentKey}`);
    const now = new Date().toISOString();
    const documentId = appendDocumentId ?? nodeId(`document:${id}`, now);
    const blockId = nodeId(`block:${id}`, now);
    const path = appendDocumentId
      ? destination.rootPath
      : `${rootScope(destination.rootPath)}/${segment(candidate.projectId)}/${segment(candidate.draft.topic)}/${segment(candidate.draft.title)}-${id.slice(0, 8)}`;
    const attrs: Record<string, string> = {
      id: blockId,
      [AGENT_ATTR.owner]: AGENT_OWNER,
      [AGENT_ATTR.project]: candidate.projectId,
      [AGENT_ATTR.topic]: candidate.draft.topic,
      [AGENT_ATTR.source]: source.sourceKey,
      [AGENT_ATTR.revision]: source.revision,
      [AGENT_ATTR.candidate]: candidate.id,
      [AGENT_ATTR.operation]: id,
      [AGENT_ATTR.contentKey]: contentKey,
    };
    const markdown = `{{{row\n${noteMarkdown(candidate, source, this.panelOrigin)}\n\n}}}\n{: ${Object.entries(
      attrs,
    )
      .map(([key, value]) => `${key}="${attribute(value)}"`)
      .join(" ")}}`;
    return operationSchema.parse({
      id,
      candidateId: candidate.id,
      projectId: candidate.projectId,
      contentKey,
      kind: appendDocumentId ? "append" : "create",
      notebookId: destination.notebookId,
      path,
      rootPath: destination.rootPath,
      topic: candidate.draft.topic,
      documentId,
      blockId,
      markdown,
      expectedAttributes: Object.fromEntries(
        Object.entries(attrs).filter(([key]) => key.startsWith("custom-agent-")),
      ),
      status: "planned",
      receipt: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  private persist(
    operation: Operation,
    status: Operation["status"],
    error: string | null = null,
  ): Operation {
    operation.status = status;
    operation.error = error;
    operation.updatedAt = new Date().toISOString();
    this.save(operation);
    return operation;
  }

  private conflict(operation: Operation, message: string): never {
    this.persist(operation, "conflict", message);
    throw new AppError("siyuan_conflict", message, false, 409);
  }

  private checkScope(operation: Operation, block: BlockReadback): void {
    if (
      block.rootId !== operation.documentId ||
      block.notebookId !== operation.notebookId ||
      !withinRoot(block.hpath, rootScope(operation.rootPath)) ||
      (!operation.receipt && operation.kind === "create" && block.hpath !== operation.path)
    ) {
      this.conflict(operation, "目標已離開原先的受管位置，已停止寫入或撤回。");
    }
  }

  private checkOwned(operation: Operation, block: BlockReadback): void {
    this.checkScope(operation, block);
    for (const [key, expected] of Object.entries(operation.expectedAttributes)) {
      if (block.attributes[key] !== expected)
        this.conflict(operation, "思源讀回的來源、修訂或應用屬性與計畫不符。");
    }
    if (
      block.attributes[AGENT_ATTR.owner] !== AGENT_OWNER ||
      block.attributes[AGENT_ATTR.project] !== operation.projectId ||
      block.attributes[AGENT_ATTR.operation] !== operation.id ||
      block.attributes[AGENT_ATTR.contentKey] !== operation.contentKey ||
      block.attributes[AGENT_ATTR.candidate] !== operation.candidateId
    ) {
      this.conflict(operation, "區塊擁有權或操作身分不符，已停止操作。");
    }
  }

  private checkReceipt(operation: Operation, block: BlockReadback): void {
    this.checkOwned(operation, block);
    if (
      !operation.receipt ||
      block.kramdown !== operation.receipt.markdown ||
      !sameAttributes(block.attributes, operation.receipt.attributes)
    ) {
      this.conflict(operation, "區塊內容或屬性已被修改；不會覆寫或刪除人工變更。");
    }
  }

  private async verify(operation: Operation, block: BlockReadback): Promise<Operation> {
    this.checkOwned(operation, block);
    if (operation.receipt) this.checkReceipt(operation, block);
    else {
      const actual = canonicalMarkdown(block.kramdown);
      const expected = canonicalMarkdown(operation.markdown);
      if (actual !== expected) {
        const [actualHtml, expectedHtml] = await Promise.all([
          this.client.renderMarkdown(actual),
          this.client.renderMarkdown(expected),
        ]);
        if (actualHtml !== expectedHtml) {
          const nativeMarkdown = await this.client.getTextMarkKramdown(block.id);
          const nativeHtml = await this.client.renderMarkdown(
            canonicalMarkdown(nativeMarkdown),
            true,
          );
          if (nativeHtml !== expectedHtml)
            this.conflict(operation, "思源讀回內容與原先寫入計畫不同，已停止後續處理。");
        }
      }
    }
    if (operation.kind === "create") {
      const document = await this.client.getBlock(operation.documentId);
      if (!document) this.conflict(operation, "原先建立的文件已不存在。");
      if (
        (document.attributes[AGENT_ATTR.owner] &&
          document.attributes[AGENT_ATTR.owner] !== AGENT_OWNER) ||
        (document.attributes[AGENT_ATTR.project] &&
          document.attributes[AGENT_ATTR.project] !== operation.projectId)
      ) {
        this.conflict(operation, "文件已被重新指定擁有權或專案，已停止操作。");
      }
      if (!document.attributes[AGENT_ATTR.owner]) {
        await this.client.setBlockAttributes(operation.documentId, {
          [AGENT_ATTR.owner]: AGENT_OWNER,
          [AGENT_ATTR.project]: operation.projectId,
          [AGENT_ATTR.topic]: operation.topic,
        });
        const confirmed = await this.client.getBlock(operation.documentId);
        if (
          !confirmed ||
          confirmed.attributes[AGENT_ATTR.owner] !== AGENT_OWNER ||
          confirmed.attributes[AGENT_ATTR.project] !== operation.projectId
        ) {
          throw new AppError("siyuan_not_verified", "文件擁有權尚未讀回確認。", true, 502);
        }
      }
    }
    if (!operation.receipt)
      operation.receipt = {
        markdown: block.kramdown,
        contentHash: digest(block.kramdown),
        attributes: { ...block.attributes },
      };
    return this.persist(operation, "verified");
  }

  async execute(input: Operation): Promise<Operation> {
    const operation = operationSchema.parse(input);
    if (["conflict", "undoing", "undone"].includes(operation.status))
      throw new AppError("operation_not_writable", "此操作目前不能再次寫入。", false, 409);
    this.save(operation);
    try {
      const existing = await this.client.getBlock(operation.blockId);
      if (existing) return await this.verify(operation, existing);
      if (operation.status !== "planned") {
        if (operation.status === "verified") this.conflict(operation, "原先已驗證的區塊已不存在。");
        throw new AppError(
          "write_outcome_unknown",
          "尚未找到先前送出的區塊；結果仍待確認，不會盲目重送。",
          true,
          503,
        );
      }
      const document = await this.client.getBlock(operation.documentId);
      if (operation.kind === "create") {
        if (document) this.conflict(operation, "預留的文件識別碼已被占用，未覆寫既有文件。");
      } else {
        if (!document) this.conflict(operation, "追加目標文件已不存在。");
        this.checkScope(operation, document);
        if (
          document.attributes[AGENT_ATTR.owner] !== AGENT_OWNER ||
          document.attributes[AGENT_ATTR.project] !== operation.projectId
        ) {
          this.conflict(operation, "只能追加至本系統擁有、同專案的受管文件。");
        }
      }
      this.persist(operation, "sent");
      if (operation.kind === "create") {
        const created = await this.client.createDocument({
          notebookId: operation.notebookId,
          path: operation.path,
          markdown: operation.markdown,
          id: operation.documentId,
        });
        if (created !== operation.documentId)
          this.conflict(operation, "思源回報的文件識別碼與預留目標不同。");
      } else await this.client.appendOwnedBlock(operation.documentId, operation.markdown);
      const readback = await this.client.getBlock(operation.blockId);
      if (!readback)
        throw new AppError("siyuan_not_verified", "寫入已送出，但尚未讀回預留區塊。", true, 502);
      return await this.verify(operation, readback);
    } catch (error) {
      if (operation.status === "sent" || operation.status === "uncertain") {
        this.persist(
          operation,
          "uncertain",
          error instanceof AppError ? error.message : "寫入結果尚未確認。",
        );
        throw new AppError(
          "write_outcome_unknown",
          "寫入已送出，但未取得可信回應；將只讀回預留目標核對，不會重送。",
          true,
          503,
        );
      }
      throw error;
    }
  }

  async undo(input: Operation): Promise<Operation> {
    const operation = operationSchema.parse(input);
    if (operation.status === "undone") return operation;
    if (operation.status !== "verified" && operation.status !== "undoing")
      throw new AppError(
        "operation_not_undoable",
        "只有已驗證或撤回待確認的操作可撤回。",
        false,
        409,
      );
    const block = await this.client.getBlock(operation.blockId);
    if (!block) {
      if (operation.status === "undoing") return this.persist(operation, "undone");
      this.conflict(operation, "區塊已被外部刪除，無法確認本次撤回。");
    }
    this.checkReceipt(operation, block);
    this.persist(operation, "undoing");
    try {
      await this.client.deleteBlock(operation.blockId);
      if (await this.client.getBlock(operation.blockId))
        throw new AppError(
          "undo_not_verified",
          "刪除已送出但尚未確認，請再次核對撤回結果。",
          true,
          502,
        );
      // Keep the document and all other blocks, including later human additions.
      return this.persist(operation, "undone");
    } catch (error) {
      this.persist(
        operation,
        "undoing",
        error instanceof AppError ? error.message : "撤回結果尚未確認。",
      );
      throw error;
    }
  }
}
