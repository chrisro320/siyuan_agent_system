import {
  AppError,
  type Conversation,
  type ImportRequest,
  importRequestSchema,
  type SourceMessage,
} from "../contracts/index.ts";
import {
  asId,
  asLocator,
  asRawLocator,
  boundedId,
  contentDigest,
  firstString,
  isoOrNull,
  MESSAGE_LIMIT,
  orderMissing,
} from "./helpers.ts";

/** 來源角色字串到契約角色的唯一對照表；解析器判斷「這行是不是角色標記」也用它。 */
export const ROLE_ALIASES: Record<string, SourceMessage["role"]> = {
  user: "user",
  human: "user",
  assistant: "assistant",
  ai: "assistant",
  model: "assistant",
  tool: "tool",
  toolresult: "tool",
  tool_result: "tool",
  tool_call: "tool",
  toolcall: "tool",
  function: "tool",
  system: "unknown",
  developer: "unknown",
  custom: "unknown",
  provider: "unknown",
};

export interface AddMessageInput {
  /** 來源宣稱的訊息識別碼；null 或空白時由 `fallbackId` 取代。 */
  rawId: unknown;
  role: unknown;
  timestamp: unknown;
  /**
   * 來源宣稱的父訊息識別碼原始值。
   * - `undefined`：來源沒有這個欄位，上層確實不可得 → 標記缺少 parent。
   * - `null`：來源明確表示沒有父訊息（根訊息）→ 不標記缺少。
   * - 字串：由 `finalize()` 對照後改寫。
   */
  parentId: unknown;
  text: string;
  rawLocator: string;
  fallbackId: string;
  /** 非文字的附件參照；缺位置時仍保留一筆「存在但未分析」。 */
  attachments?: SourceMessage["attachments"];
  /** 呼叫端已判定缺少的欄位。`parent` 由 `finalize()` 判定。 */
  missing?: readonly string[];
  truncated?: boolean;
}

/** `undefined` 與 `null` 在此有不同意義，因此不能用 `firstString` 折疊。 */
function parseParent(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 段落建構器：唯一負責訊息身分、`missing` 標記與警告彙整的地方。
 *
 * 重複的識別碼會以 `invalid_source` 明確拒絕，不會被改成看似合法的新值。
 * 理由是下游以 `sourceMessageId` 作為證據錨點：來源自己重複使用同一個錨點時，
 * 任何改名都會讓已發布的引用指向別的訊息，這是無法回溯的破壞，必須讓整份來源
 * 停下來被人看見。`parentId` 在 `finalize()` 才對照，因此父訊息較晚出現、
 * 或來源被改寫過，都不會被誤判成壞掉的來源。
 */
export class ConversationBuilder {
  private readonly messages: SourceMessage[] = [];
  private readonly used = new Set<string>();
  private readonly warnings: string[] = [];
  private readonly parentRefs: Array<{
    message: SourceMessage;
    raw: string | null;
    /** 來源是否有提供 parent 欄位；false 代表上層確實不可得。 */
    declared: boolean;
  }> = [];
  private readonly declaredToFinal = new Map<string, string>();
  private readonly source: string;
  private readonly projectId: string;
  private readonly sessionId: string;
  private readonly sourceLocator: string | null;
  private full = false;

  private constructor(request: ImportRequest, sessionId: string) {
    this.source = request.source;
    this.projectId = request.projectId;
    this.sessionId = sessionId;
    this.sourceLocator = request.sourceLocator;
  }

  /**
   * @param request 已套用 schema 預設值的請求。
   * @param identityParts 決定內容雜湊的穩定輸入；呼叫端必須傳入會隨原文改動
   *   而改動的內容，否則改寫過的來源會被誤判成同一版。
   * @param identity 來源自身記載的 session 識別碼（若無則 null）與其權威性。
   *   `declaredSessionId` 是來源檔自己宣稱的值：OMP session 標頭屬此類。
   *   `preferDeclared` 為 true 時以來源宣稱優先，`request.sourceSessionId`
   *   不會覆蓋它（OMP 掃描：標頭就是唯一穩定來源身分）。
   *   為 false 時以匯入設定優先（手動匯入的原文是資料，不是指令）。
   *   只有在兩者皆無時才退回內容雜湊，並明示那無法追蹤版本。
   */
  static create(
    request: ImportRequest,
    identityParts: readonly string[],
    identity: { declaredSessionId?: string | null; preferDeclared?: boolean } = {},
  ): ConversationBuilder {
    const declared = identity.declaredSessionId ?? null;
    const explicit =
      identity.preferDeclared === true
        ? firstString(declared, request.sourceSessionId)
        : firstString(request.sourceSessionId, declared);
    if (explicit !== null) return new ConversationBuilder(request, asId(explicit, "session"));
    const builder = new ConversationBuilder(request, `content-${contentDigest(identityParts)}`);
    builder.warn(
      "來源沒有提供任何 session 識別碼，已用內容雜湊作為識別。這個識別只代表一次獨立的非結構化匯入（例如貼上的文字）：同一份原文重送會得到相同識別，但任何改寫都會變成另一個來源，因此無法追蹤版本。",
    );
    return builder;
  }

  get length(): number {
    return this.messages.length;
  }

  /** 已達訊息量上限時為 true，呼叫端應停止再投入內容。 */
  get isFull(): boolean {
    return this.full;
  }

  warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  add(input: AddMessageInput): SourceMessage | null {
    if (this.full) return null;
    const declaredId = firstString(input.rawId);
    const sourceMessageId = asId(input.rawId, input.fallbackId);
    // 重複的識別碼無法回溯到唯一訊息：靜默改名會讓已發布的證據錨點指向別的訊息，
    // 因此這裡明確拒絕整份來源，而不是自行編造一個看似合法的識別碼。
    if (this.used.has(sourceMessageId)) {
      throw new AppError(
        "invalid_source",
        `來源出現重複的訊息識別碼「${sourceMessageId}」；重複的證據錨點無法回溯，已停止匯入這份來源。`,
      );
    }
    this.used.add(sourceMessageId);
    if (declaredId !== null && !this.declaredToFinal.has(declaredId)) {
      this.declaredToFinal.set(declaredId, sourceMessageId);
    }

    const missing = [...(input.missing ?? [])];
    const rawRole = typeof input.role === "string" ? input.role.trim().toLowerCase() : "";
    const role = rawRole.length > 0 ? (ROLE_ALIASES[rawRole] ?? "unknown") : "unknown";
    // 角色無法對應契約值時，仍然保留訊息，但必須讓下游知道這是未知角色。
    if (role === "unknown") missing.push("role");
    const timestamp = isoOrNull(input.timestamp);
    if (timestamp === null) missing.push("timestamp");
    if (input.text.length === 0) missing.push("text");

    const message: SourceMessage = {
      sourceMessageId,
      parentId: null,
      role,
      timestamp,
      text: input.text,
      attachments: input.attachments ?? [],
      rawLocator: asRawLocator(input.rawLocator, input.fallbackId),
      missing: orderMissing(missing),
      truncated: input.truncated ?? false,
    };
    this.messages.push(message);
    const parent = parseParent(input.parentId);
    if (parent === undefined) message.missing = orderMissing([...message.missing, "parent"]);
    this.parentRefs.push({ message, raw: parent ?? null, declared: parent !== undefined });
    if (this.messages.length >= MESSAGE_LIMIT) {
      this.full = true;
      this.warn(`已達單一對話 ${MESSAGE_LIMIT} 則訊息的上限，其餘內容未納入。`);
    }
    return message;
  }

  /**
   * 必須在所有訊息投入後、產出結果前呼叫：解析 `parentId`、標記不存在的父訊息、
   * 記錄分岔與循環警告。順序上先全部解析再判斷，
   * 才不會因檔案順序而誤判。
   *
   * 來源宣稱的父訊息識別碼一律保留：即使它不存在於這份來源，也代表模型真的
   * 缺少那段上下文，必須看得出來。因此這裡不會為了讓圖看起來合法而把
   * `parentId` 改成 `null`（那等於捏造「這是根訊息」），只會加 `missing: parent`
   * 與警告。即使來源形成循環也保留原始邊，讓下游看見問題而不是偽造根訊息。
   */
  finalize(): void {
    const index = new Map<string, SourceMessage>();
    for (const message of this.messages) index.set(message.sourceMessageId, message);

    const unresolved = new Set<string>();
    for (const { message, raw, declared } of this.parentRefs) {
      if (raw === null) {
        message.parentId = null;
        if (!declared) message.missing = orderMissing([...message.missing, "parent"]);
        else message.missing = message.missing.filter((field) => field !== "parent");
        continue;
      }
      // 父訊息與訊息識別碼使用相同上限；超長值明確拒絕，不壓縮或改名。
      const resolved = this.declaredToFinal.get(raw) ?? null;
      message.parentId = boundedId(raw);
      if (resolved === null) {
        unresolved.add(raw);
        message.missing = orderMissing([...message.missing, "parent"]);
      } else {
        message.missing = message.missing.filter((field) => field !== "parent");
      }
    }

    const inCycle = new Set<string>();
    const status = new Map<string, number>();
    for (const { message } of this.parentRefs) {
      let current: SourceMessage | undefined = message;
      const path: SourceMessage[] = [];
      while (current !== undefined && current.parentId !== null) {
        const state = status.get(current.sourceMessageId);
        if (state === 1) {
          const start = path.findIndex((item) => item.sourceMessageId === current?.sourceMessageId);
          for (const member of path.slice(start)) inCycle.add(member.sourceMessageId);
          break;
        }
        if (state === 2) break;
        status.set(current.sourceMessageId, 1);
        path.push(current);
        current = index.get(current.parentId);
      }
      for (const item of path) status.set(item.sourceMessageId, 2);
    }
    for (const id of inCycle) {
      const message = index.get(id);
      if (message === undefined || message.parentId === null) continue;
      message.missing = orderMissing([...message.missing, "parent"]);
    }
    if (inCycle.size > 0) {
      this.warn(
        `來源有 ${inCycle.size} 則訊息的 parentId 形成循環，已保留原始連結並標記缺少可靠的父層脈絡。`,
      );
    }

    const childrenOf = new Map<string, string[]>();
    for (const { message } of this.parentRefs) {
      if (message.parentId === null) continue;
      const siblings = childrenOf.get(message.parentId);
      if (siblings === undefined) childrenOf.set(message.parentId, [message.sourceMessageId]);
      else siblings.push(message.sourceMessageId);
    }
    for (const raw of unresolved) {
      this.warn(
        `來源宣稱的 parentId「${raw}」不存在於這份來源中，已保留原值並標記缺少 parent；未補造上層訊息，模型會看到這是一段缺少脈絡的歷史。`,
      );
    }
    for (const [parent, children] of childrenOf) {
      if (children.length < 2) continue;
      this.warn(
        `parentId「${parent}」下有 ${children.length} 個分支（${children.join("、")}）；這是多分支歷史，檔案順序不代表對話順序，分支內容可能互相取代。`,
      );
    }
    // 只統計「來源根本沒有提供 parent 欄位」的訊息；已宣告為根訊息者不算缺漏，
    // 指向不存在或循環的父訊息則已在前面的警告說明，不重複計數。
    const absentParent = this.parentRefs.filter(
      (entry) => !entry.declared && entry.message.parentId === null,
    ).length;
    if (absentParent > 0) {
      this.warn(
        `有 ${absentParent} 則訊息的來源缺少 parent 欄位，已標記 missing；未推測其上層關係。`,
      );
    }
  }

  finish(startedAt: unknown): Conversation {
    return {
      schemaVersion: 1,
      source: this.source,
      sourceSessionId: this.sessionId,
      projectId: this.projectId,
      startedAt: isoOrNull(startedAt),
      sourceLocator: this.sourceLocator === null ? null : asLocator(this.sourceLocator, "unknown"),
      messages: this.messages,
      warnings: this.warnings,
    };
  }
}

/**
 * 建立已套用 schema 預設值的請求。所有匯入入口（HTTP、掃描器、測試）共用
 * 這裡，避免各自複製 `source`／`sourceLocator` 的預設行為。
 */
export function normalizeRequest(raw: unknown): ImportRequest {
  return importRequestSchema.parse(raw);
}
