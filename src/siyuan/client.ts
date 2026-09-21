import { z } from "zod";
import {
  AppError,
  type CandidateDraft,
  type Destination,
  type Notebook,
  notebooksSchema,
  type RelatedNote,
  relatedNoteSchema,
} from "../contracts/index.ts";

/**
 * 本應用在思源內部使用的屬性詞彙。
 *
 * 資料庫端的身分（來源鍵、候選、操作）不會被當成思源的身分重用，思源端只認這組
 * `custom-` 屬性；兩邊刻意不共用同一個鍵，避免「重新匯入」與「重新發布」互相誤判。
 */
export const AGENT_OWNER = "siyuan-agent-system";
export const AGENT_ATTR = {
  owner: "custom-agent-owner",
  project: "custom-agent-project",
  topic: "custom-agent-topic",
  source: "custom-agent-source",
  revision: "custom-agent-revision",
  candidate: "custom-agent-candidate",
  operation: "custom-agent-operation",
  contentKey: "custom-agent-content-key",
} as const;

/** 思源節點 ID 固定為 14 位數字、一個連字號、7 位小寫英數字。 */
const NODE_ID_PATTERN = /^[0-9]{14}-[a-z0-9]{7}$/;

export function isNodeId(value: string): boolean {
  return NODE_ID_PATTERN.test(value);
}

/** 單次思源請求的上限；超過一律當成「未知」，不會被當成「不存在」。 */
export const SIYUAN_TIMEOUT_MS = 30_000;

/** 相關筆記最多回傳幾則。 */
export const RELATED_LIMIT = 5;

/** SQL 先掃描的上限，再由記憶體排序取前幾名。 */
const RELATED_SCAN_LIMIT = 25;

/** 單則相關筆記的內容上限：模型只需要足以判斷「同一主題」的篇幅。 */
const RELATED_CONTENT_MAX = 8_000;

/**
 * 思源的 SQL 索引是排隊寫入的，`createDocWithMd` 之後立刻查詢可能查不到。
 * 因此「查不到」不是「不存在」的證據：先 flushTransaction，再重試有限次，
 * 仍查不到時只有在 blocktree 也說不存在才回報不存在，否則回報未知。
 */
const READBACK_ATTEMPTS = 4;
const READBACK_DELAY_MS = 200;

const TRUNCATED_MARK = "…（內容過長，已截斷）";

const envelopeSchema = z.object({ code: z.number().int(), data: z.unknown().optional() });
const sqlRowsSchema = z.array(z.record(z.string(), z.unknown()));
const kramdownDataSchema = z.object({ id: z.string(), kramdown: z.string() });
const kramdownMapSchema = z.record(z.string(), z.string());
const attributeMapSchema = z.record(z.string(), z.string());
const attributeMapMapSchema = z.record(z.string(), z.record(z.string(), z.string()));
const notebookListSchema = z.object({ notebooks: z.array(z.unknown()) });

export interface SiyuanClientOptions {
  /** 只使用使用者自行設定的位址；空字串代表「尚未設定」，網路操作才失敗。 */
  url: string;
  /** `null` 代表沒有 API token（思源未開權限驗證時可為空）。 */
  token: string | null;
  fetch?: typeof globalThis.fetch;
}

export interface BlockReadback {
  id: string;
  rootId: string;
  notebookId: string;
  hpath: string;
  kramdown: string;
  attributes: Record<string, string>;
}

/**
 * 受管路徑的正規化形式：空字串代表整個筆記本。
 */
export function rootScope(rootPath: string): string {
  const trimmed = rootPath.trim();
  if (trimmed === "" || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

/**
 * 是否位於受管路徑的子樹內。比對以路徑分段為界，`/A` 不會匹配 `/AB`。
 */
export function withinRoot(hpath: string, root: string): boolean {
  if (root === "") return true;
  return hpath === root || hpath.startsWith(`${root}/`);
}

/** SQL 字串常值：單引號加倍，其餘一律照原樣。 */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** LIKE 樣式：`%`、`_` 與跳脫字元本身都要跳脫，否則比對會變成萬用字元。 */
function likeTerm(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** 只保留查詢結果中的字串欄位；其他型別一律視為空值，不轉型、不猜測。 */
function field(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  return typeof value === "string" ? value : "";
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}${TRUNCATED_MARK}` : value;
}

/**
 * 可安全當成連結目標的字串。僅允許 http(s) 與 siyuan://，其餘（含 javascript:、
 * data:）一律降級為純文字。
 */
export function isSafeHref(value: string): boolean {
  if (/[\s<>"']/.test(value)) return false;
  if (!/^(https?:\/\/|siyuan:\/\/)/i.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * 思源用戶端。只透過 HTTP 講話，不讀資料庫、也不決定發布與撤回的狀態機——
 * 那是 `SiyuanWriter` 的責任。
 *
 * 安全界線：
 * - 只使用建構時注入的位址，請求網址的來源必須與它一致，不會被改寫到別的服務。
 * - 不跟隨重導（`redirect: "error"`），每個請求都有逾時。
 * - 任何 HTTP、協定或商務錯誤都轉成安全的 `AppError`，不回傳、不記錄回應內容，
 *   因此回應中的憑據或使用者內容不會外洩到錯誤訊息。
 */
export class SiyuanClient {
  private readonly rawUrl: string;
  private readonly token: string | null;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: SiyuanClientOptions) {
    this.rawUrl = options.url;
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  // ---------------------------------------------------------------- 讀取

  /** 可發佈的筆記本清單。無法解析的項目會被略過，而不是捏造名稱。 */
  async notebooks(): Promise<Notebook[]> {
    const data = await this.post("/api/notebook/lsNotebooks", {});
    const list = notebookListSchema.safeParse(data);
    if (!list.success) {
      throw new AppError(
        "siyuan_invalid_response",
        "思源沒有回傳可用的筆記本清單，無法確認發佈目的地。",
        false,
        502,
      );
    }
    const notebooks: Notebook[] = [];
    for (const entry of list.data.notebooks) {
      const parsed = notebooksSchema.element.safeParse(entry);
      if (parsed.success) notebooks.push(parsed.data);
    }
    return notebooks;
  }

  /**
   * 在指定目的地（筆記本＋受管路徑子樹）內找可能相關的既有筆記。
   *
   * - 查詢一律唯讀，且所有外部字串都經過轉義。
   * - 標題、主題與專案屬性都是比對維度；最多回傳 {@link RELATED_LIMIT} 則。
   * - 是否為本系統所有，只由 `custom-agent-owner` 決定。
   */
  async related(destination: Destination, draft: CandidateDraft): Promise<RelatedNote[]> {
    const root = rootScope(destination.rootPath);
    await this.flushTransaction();
    const rows = await this.sqlRows(this.relatedStatement(destination, draft, root));
    const ranked = rows
      .map((row) => ({
        id: field(row, "id"),
        name: field(row, "name"),
        hpath: field(row, "hpath"),
        content: field(row, "content"),
      }))
      .filter((row) => isNodeId(row.id))
      .map((row) => ({ ...row, score: relevance(row, draft, destination.projectId) }))
      .filter((row) => row.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.hpath.localeCompare(right.hpath) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, RELATED_LIMIT);

    if (ranked.length === 0) return [];
    const ids = ranked.map((row) => row.id);
    const attributes = await this.batchAttributes(ids);
    const kramdowns = await this.batchKramdowns(ids);

    const notes: RelatedNote[] = [];
    for (const row of ranked) {
      const kramdown = kramdowns[row.id];
      // 掃描後才消失的區塊不回報，避免把已刪除的內容當成現況。
      if (kramdown === undefined) continue;
      const attrs = attributes[row.id] ?? {};
      const title = row.name.trim() !== "" ? row.name.trim() : hpathTitle(row.hpath);
      if (title === "") continue;
      const projectId = attrs[AGENT_ATTR.project];
      notes.push(
        relatedNoteSchema.parse({
          id: row.id,
          title,
          content: clip(kramdown, RELATED_CONTENT_MAX),
          projectId: projectId && projectId.trim() !== "" ? projectId : destination.projectId,
          owned: attrs[AGENT_ATTR.owner] === AGENT_OWNER,
        }),
      );
    }
    return notes;
  }

  /**
   * 讀回單一區塊：先用 SQL 取得位置，再取 Kramdown 與屬性。
   *
   * `null` 只代表「已證明不存在」：SQL 沒有資料列時會用 blocktree 的存在性再確認一次，
   * 兩邊都說沒有才回報 `null`。傳輸失敗、逾時、索引落後都不會變成 `null`，而是丟出
   * `AppError`，呼叫端因此不可能把「還不知道」誤當成「不存在」而重複寫入。
   */
  async getBlock(id: string): Promise<BlockReadback | null> {
    if (!isNodeId(id)) {
      throw new AppError("invalid_block_id", "區塊識別碼格式不正確，未送出查詢。");
    }
    await this.flushTransaction();
    let location = await this.locate(id);
    if (location === null) {
      if (!(await this.blockExists(id))) return null;
      for (let attempt = 0; attempt < READBACK_ATTEMPTS && location === null; attempt += 1) {
        await Bun.sleep(READBACK_DELAY_MS);
        await this.flushTransaction();
        location = await this.locate(id);
      }
      if (location === null) {
        throw new AppError(
          "siyuan_index_lag",
          "思源的索引尚未包含這個區塊，無法確認它的位置；將依排程重新核對。",
          true,
          503,
        );
      }
    }
    const kramdown = await this.kramdownOf(id);
    const attributes = await this.attributesOf(id);
    if (kramdown.trim() === "" && Object.keys(attributes).length === 0) {
      // 讀取過程中區塊消失了；再確認一次，避免回報空內容的空殼。
      if (!(await this.blockExists(id))) return null;
    }
    return {
      id,
      rootId: location.rootId,
      notebookId: location.notebookId,
      hpath: location.hpath,
      kramdown,
      attributes,
    };
  }

  /** 用思源自身的解析器比較 Markdown 語義；不渲染、不執行回傳的 HTML。 */
  async renderMarkdown(markdown: string): Promise<string> {
    const parsed = z
      .object({ html: z.string().min(1) })
      .safeParse(await this.post("/api/lute/md2html", { markdown }));
    if (!parsed.success)
      throw new AppError(
        "siyuan_invalid_response",
        "思源未回傳可驗證的 Markdown 渲染結果。",
        true,
        502,
      );
    return await new HTMLRewriter()
      .on("*", {
        element(element) {
          // 解析器每次生成不同的區塊 ID 與時間；正文、段落與程式碼空白保持原樣。
          if (NODE_ID_PATTERN.test(element.getAttribute("id") ?? "")) element.removeAttribute("id");
          if (/^\d{14}$/.test(element.getAttribute("updated") ?? ""))
            element.removeAttribute("updated");
        },
      })
      .transform(new Response(parsed.data.html))
      .text();
  }

  /** 讓思源把待寫的索引寫完；在依賴 SQL 之前當成屏障使用。 */
  async flushTransaction(): Promise<void> {
    await this.post("/api/sqlite/flushTransaction", null);
  }

  // ------------------------------------------------- 寫入原語（僅供 writer）

  /** 以呼叫端指定的文件 ID 一次寫入整份內容，回傳思源回報的文件 ID。 */
  async createDocument(input: {
    notebookId: string;
    path: string;
    markdown: string;
    id: string;
  }): Promise<string> {
    const data = await this.post("/api/filetree/createDocWithMd", {
      notebook: input.notebookId,
      path: input.path,
      markdown: input.markdown,
      id: input.id,
    });
    if (typeof data !== "string" || data === "") {
      throw new AppError(
        "siyuan_invalid_response",
        "思源沒有回報新建文件的身分，無法確認寫入結果。",
        false,
        502,
      );
    }
    return data;
  }

  /** 以 Markdown 形式附加一個擁有區塊到既有文件；不會改動任何既有區塊。 */
  async appendOwnedBlock(documentId: string, markdown: string): Promise<void> {
    await this.post("/api/block/appendBlock", {
      data: markdown,
      dataType: "markdown",
      parentID: documentId,
    });
  }

  /** 設定文件層級屬性；呼叫端必須先確認該文件屬於本系統。 */
  async setBlockAttributes(id: string, attributes: Record<string, string>): Promise<void> {
    await this.post("/api/attr/setBlockAttrs", { id, attrs: attributes });
  }

  /** 刪除單一區塊。呼叫端必須先確認該區塊是本系統所有且內容未被人為修改。 */
  async deleteBlock(id: string): Promise<void> {
    await this.post("/api/block/deleteBlock", { id });
  }

  // ---------------------------------------------------------------- 內部

  private async locate(
    id: string,
  ): Promise<{ rootId: string; notebookId: string; hpath: string } | null> {
    const rows = await this.sqlRows(
      `SELECT root_id, box, hpath FROM blocks WHERE id = ${sqlLiteral(id)} LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      rootId: field(row, "root_id"),
      notebookId: field(row, "box"),
      hpath: field(row, "hpath"),
    };
  }

  private async blockExists(id: string): Promise<boolean> {
    const data = await this.post("/api/block/checkBlockExist", { id });
    if (typeof data !== "boolean") {
      throw new AppError(
        "siyuan_invalid_response",
        "思源沒有回報區塊是否存在，無法確認狀態。",
        false,
        502,
      );
    }
    return data;
  }

  private async kramdownOf(id: string): Promise<string> {
    const data = await this.post("/api/block/getBlockKramdown", { id });
    const parsed = kramdownDataSchema.safeParse(data);
    if (!parsed.success) {
      throw new AppError(
        "siyuan_invalid_response",
        "思源沒有回傳可用的區塊內容，無法核對寫入結果。",
        false,
        502,
      );
    }
    return parsed.data.kramdown;
  }

  private async attributesOf(id: string): Promise<Record<string, string>> {
    const data = await this.post("/api/attr/getBlockAttrs", { id });
    const parsed = attributeMapSchema.safeParse(data);
    if (!parsed.success) {
      throw new AppError(
        "siyuan_invalid_response",
        "思源沒有回傳可用的區塊屬性，無法核對擁有權。",
        false,
        502,
      );
    }
    return parsed.data;
  }

  private async batchAttributes(ids: string[]): Promise<Record<string, Record<string, string>>> {
    const data = await this.post("/api/attr/batchGetBlockAttrs", { ids });
    const parsed = attributeMapMapSchema.safeParse(data);
    if (!parsed.success) {
      throw new AppError(
        "siyuan_invalid_response",
        "思源沒有回傳可用的區塊屬性，無法核對擁有權。",
        false,
        502,
      );
    }
    return parsed.data;
  }

  private async batchKramdowns(ids: string[]): Promise<Record<string, string>> {
    const data = await this.post("/api/block/getBlockKramdowns", { ids });
    const parsed = kramdownMapSchema.safeParse(data);
    if (!parsed.success) {
      throw new AppError(
        "siyuan_invalid_response",
        "思源沒有回傳可用的區塊內容，無法核對既有筆記。",
        false,
        502,
      );
    }
    return parsed.data;
  }

  private async sqlRows(statement: string): Promise<Record<string, unknown>[]> {
    const data = await this.post("/api/query/sql", { stmt: statement, mode: "readonly" });
    const parsed = sqlRowsSchema.safeParse(data);
    if (!parsed.success) {
      throw new AppError(
        "siyuan_invalid_response",
        "思源的查詢結果不是可解析的資料列。",
        false,
        502,
      );
    }
    return parsed.data;
  }

  private relatedStatement(destination: Destination, draft: CandidateDraft, root: string): string {
    const scope =
      root === ""
        ? "1 = 1"
        : `(b.hpath = ${sqlLiteral(root)} OR b.hpath LIKE ${sqlLiteral(`${likeTerm(root)}/%`)} ESCAPE '\\')`;
    const matches: string[] = [
      `(a.name = ${sqlLiteral(AGENT_ATTR.project)} AND a.value = ${sqlLiteral(destination.projectId)})`,
    ];
    for (const term of [draft.title, draft.topic]) {
      const pattern = sqlLiteral(`%${likeTerm(term)}%`);
      matches.push(
        `b.name LIKE ${pattern} ESCAPE '\\'`,
        `b.hpath LIKE ${pattern} ESCAPE '\\'`,
        `b.content LIKE ${pattern} ESCAPE '\\'`,
      );
    }
    return [
      "SELECT DISTINCT b.id AS id, b.name AS name, b.hpath AS hpath, substr(b.content, 1, 4000) AS content",
      "FROM blocks AS b LEFT JOIN attributes AS a ON a.block_id = b.id",
      `WHERE b.box = ${sqlLiteral(destination.notebookId)} AND b.type = 'd' AND ${scope}`,
      `AND (${matches.join(" OR ")})`,
      "ORDER BY b.hpath ASC, b.id ASC",
      `LIMIT ${RELATED_SCAN_LIMIT}`,
    ].join(" ");
  }

  /** 使用者自行設定的位址；未設定或不是 HTTP 伺服器時才失敗，建構子本身不會丟錯。 */
  private requireBase(): string {
    const base = this.rawUrl.trim().replace(/\/+$/, "");
    if (base === "") {
      throw new AppError(
        "siyuan_not_configured",
        "尚未設定思源的伺服器網址，無法讀寫筆記。",
        false,
        503,
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(base);
    } catch {
      throw new AppError("siyuan_misconfigured", "思源的伺服器網址不是有效網址。", false, 500);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new AppError("siyuan_misconfigured", "思源的伺服器網址必須是 HTTP 服務。", false, 500);
    }
    if (parsed.username !== "" || parsed.password !== "") {
      throw new AppError("siyuan_misconfigured", "思源的伺服器網址不得內嵌憑據。", false, 500);
    }
    return base;
  }

  private async post(path: string, payload: unknown | null): Promise<unknown> {
    const url = this.endpoint(path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SIYUAN_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers: this.headers(payload !== null),
          body: payload === null ? undefined : JSON.stringify(payload),
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        const timedOut = controller.signal.aborted;
        throw timedOut
          ? new AppError(
              "siyuan_timeout",
              "思源未在時限內回應，狀態未知，將重新核對後再決定。",
              true,
              504,
            )
          : new AppError(
              "siyuan_unreachable",
              "無法連線到思源，狀態未知，將依排程重試。",
              true,
              502,
            );
      }
      if (!response.ok) {
        throw new AppError(
          "siyuan_unavailable",
          `思源回報 HTTP ${response.status}，未取得可信結果，將重新核對後再決定。`,
          response.status >= 500 || response.status === 429,
          502,
        );
      }
      let envelope: unknown;
      try {
        envelope = await response.json();
      } catch (error) {
        if (controller.signal.aborted || !(error instanceof SyntaxError)) {
          throw new AppError(
            "siyuan_unreachable",
            "思源回應中斷，狀態未知，將重新核對。",
            true,
            502,
          );
        }
        throw new AppError(
          "siyuan_invalid_response",
          "思源的回應不是有效 JSON，已停止後續步驟。",
          false,
          502,
        );
      }
      const parsed = envelopeSchema.safeParse(envelope);
      if (!parsed.success) {
        throw new AppError(
          "siyuan_invalid_response",
          "思源的回應不符合預期格式，已停止後續步驟。",
          false,
          502,
        );
      }
      if (parsed.data.code !== 0) {
        // 只回報商務錯誤碼；思源訊息可能夾帶使用者內容，因此不轉述。
        throw new AppError(
          "siyuan_rejected",
          `思源拒絕了這次請求（代碼 ${parsed.data.code}），已停止後續步驟。`,
          false,
          502,
        );
      }
      return parsed.data.data ?? null;
    } finally {
      clearTimeout(timer);
    }
  }

  private endpoint(path: string): string {
    const base = this.requireBase();
    const url = `${base}${path}`;
    const origin = new URL(base).origin;
    if (new URL(url).origin !== origin) {
      throw new AppError(
        "siyuan_misconfigured",
        "請求網址不是設定的思源來源，已停止呼叫。",
        false,
        500,
      );
    }
    return url;
  }

  private headers(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {};
    if (hasBody) headers["content-type"] = "application/json";
    const token = this.token?.trim() ?? "";
    if (token !== "") headers.authorization = `Token ${token}`;
    return headers;
  }
}

function hpathTitle(hpath: string): string {
  const parts = hpath.split("/").filter((part) => part.trim() !== "");
  return parts.length > 0 ? (parts[parts.length - 1] ?? "").trim() : "";
}

function relevance(
  row: { name: string; hpath: string; content: string },
  draft: CandidateDraft,
  projectId: string,
): number {
  const name = row.name.trim().toLowerCase();
  const hpath = row.hpath.toLowerCase();
  const content = row.content.toLowerCase();
  const title = draft.title.trim().toLowerCase();
  const topic = draft.topic.trim().toLowerCase();
  let score = 0;
  if (title !== "") {
    if (name.includes(title)) score += 8;
    else if (hpath.includes(title)) score += 6;
    else if (content.includes(title)) score += 3;
  }
  if (topic !== "") {
    if (name.includes(topic) || hpath.includes(topic)) score += 4;
    else if (content.includes(topic)) score += 2;
  }
  // 同一個受管路徑本身就是專案歸屬；沒有文字命中時仍可作為最弱的候選。
  if (projectId.trim() !== "") score += 1;
  return score;
}
