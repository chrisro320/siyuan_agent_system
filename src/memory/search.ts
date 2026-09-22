import {
  type Candidate,
  type Destination,
  type Operation,
  type SearchRequest,
  type SearchResponse,
  searchNoteSchema,
  searchResponseSchema,
} from "../contracts";
import {
  AGENT_ATTR,
  AGENT_OWNER,
  type BlockReadback,
  isNodeId,
  rootScope,
  SEARCH_PAGE_LIMIT,
  type SiyuanClient,
  withinRoot,
} from "../siyuan/client";
import { canonicalMarkdown } from "../siyuan/writer";
import { digest } from "../storage/identity";
import type { PublicationSnapshot, Store } from "../storage/store";
import { requireAdapterProject } from "./scope";

/** 一次搜尋最多使用的查詢詞數；每個詞各發一次有界的全文檢索。 */
const MAX_TERMS = 6;
/** 中文長句切成相鄰二字詞時的取樣長度。 */
const CJK_TERM_LENGTH = 2;
/** 不切分的中文短語長度上限。 */
const CJK_PHRASE_MAX = 8;
/** 查詢詞最短長度：單一字元不構成有意義的查詢，也不會被拿去當字面比對。 */
const MIN_TERM_LENGTH = 2;
/** 剩餘預算低於此值就不再放下一則筆記。 */
const MIN_NOTE_CHARS = 200;
/** 單則筆記內容的契約上限。 */
const NOTE_TEXT_MAX = 16_000;
/**
 * 一次搜尋最多考慮的檢索命中操作數。
 *
 * 命中識別碼本身已受「查詢詞數 × 每頁命中數」限制，這個上限再限制查回的操作筆數：
 * 超過時只取最新的幾筆，較舊的命中不會以更多請求補齊。送進 `readBlocks` 的識別碼
 * 總數因此恆由這個常數決定，不隨歷史成長。
 */
const MAX_SEARCH_OPERATIONS = 60;
const TRUNCATED_MARK = "…（內容過長，已截斷）";

type SearchNote = SearchResponse["notes"][number];

interface LiveNote {
  candidate: Candidate;
  operation: Operation;
  text: string;
  title: string;
  revision: string;
  edited: boolean;
}

/**
 * 依明確的查詢字串，在此專案授權的思源範圍內取回現況筆記。
 *
 * 這是按需的唯讀查詢：一般對話回合、自動續接、重試與工作階段啟動都不會呼叫它，
 * 呼叫端也不能把結果當成自動記憶注入對話。
 *
 * 邊界與不變條件：
 *
 * - 只在此專案設定的筆記本與受管路徑內檢索；別的專案、別的筆記本與未設定目的地一律
 *   不參與，也沒有跨專案的替代查詢。空結果是合法結果。
 * - 檢索只是線索：命中先以 SQL 在專案、筆記本與狀態的範圍內查回已驗證操作，再以
 *   `readBlocks` 讀回現況後比對位置、擁有權與操作身分。檢索回應的高亮內容不採用，
 *   全庫的候選與操作也不會被載入或掃描。
 * - 父文件與擁有區塊都必須讀回並各自通過檢查：文件目前的筆記本、受管路徑與歸屬，
 *   以及子區塊的位置、擁有權與操作身分。只信子區塊自帶的屬性不足以授權。
 * - `candidate.status` 不足以判斷可回傳性，因此資格同時要求候選仍指向這個操作、仍在
 *   published／duplicate 且操作是 `verified`：已撤回、撤回中、未確認與衝突的操作都不算
 *   已確認知識。最後一次網路等待之後會同步重讀目的地、候選與操作，等待期間的
 *   撤回、搬移或改歸屬不會讓等待前的舊快照漏回。
 * - 人為改寫過的筆記回傳**現況**內容並標記 `edited`，不會用舊的生成草稿取代。
 * - 輸出受 `limit` 與 `maxChars` 限制，順序固定（相關度、再依操作識別碼）；
 *   查詢字串不會寫進稽核或紀錄。
 */
export async function search(
  store: Store,
  siyuan: SiyuanClient,
  allowedProjects: readonly string[],
  request: SearchRequest,
): Promise<SearchResponse> {
  const destination = requireAdapterProject(store, allowedProjects, request.projectId);
  const terms = queryTerms(request.query);

  const hitIds = new Set<string>();
  if (terms.length > 0) {
    for (const term of terms) {
      const found = await siyuan.searchBlocks(destination.notebookId, term, SEARCH_PAGE_LIMIT);
      for (const hit of found) {
        if (hit.notebookId !== "" && hit.notebookId !== destination.notebookId) continue;
        hitIds.add(hit.id);
        // 子區塊命中時，所屬文件只是「可能相關」的線索；真正的授權仍要讀回文件與區塊。
        if (isNodeId(hit.rootId)) hitIds.add(hit.rootId);
      }
    }
  }
  const hitOperations = store.publicationsForBlocks(
    request.projectId,
    destination.notebookId,
    [...hitIds],
    MAX_SEARCH_OPERATIONS,
  );

  const readIds = [
    ...new Set(
      hitOperations.flatMap((entry) => [entry.operation.documentId, entry.operation.blockId]),
    ),
  ];
  const blocks: Record<string, BlockReadback> = {};
  if (readIds.length > 0) {
    for (const block of await siyuan.readBlocks(readIds)) blocks[block.id] = block;
  }

  // 最後一次網路等待之後，同步重讀目的地、候選與操作：等待期間可能有人縮小
  // 或移除目的地、撤回操作或改動歸屬，因此資格一律以這裡讀到的現況重新判斷，
  // 上面的快照只用來決定「已經讀了哪些區塊」。
  const currentDestination = requireAdapterProject(store, allowedProjects, request.projectId);
  const currentByOperation = new Map<string, PublicationSnapshot>(
    store
      .publicationsByOperations(hitOperations.map((entry) => entry.operation.id))
      .filter((entry) => eligible(entry, currentDestination, request.projectId))
      .map((entry) => [entry.operation.id, entry]),
  );

  const live = (entry: PublicationSnapshot | undefined): LiveNote | null => {
    if (!entry) return null;
    const block = blocks[entry.operation.blockId];
    const document = blocks[entry.operation.documentId];
    if (!block || !document) return null;
    if (!owned(document, block, entry.operation, currentDestination)) return null;
    const currentMarkdown = canonicalMarkdown(block.kramdown);
    const receiptMarkdown = canonicalMarkdown(
      entry.operation.receipt?.markdown ?? entry.operation.markdown,
    );
    const text = noteText(block.kramdown);
    return {
      candidate: entry.candidate,
      operation: entry.operation,
      text,
      title: noteTitle(text, entry.candidate.draft.title),
      revision: digest(currentMarkdown),
      edited: currentMarkdown !== receiptMarkdown,
    };
  };

  const ranked = hitOperations
    .map((entry) => live(currentByOperation.get(entry.operation.id)))
    .filter((note): note is LiveNote => note !== null)
    .map((note) => ({ note, score: scoreNote(note.title, note.text, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.note.operation.id === right.note.operation.id) return 0;
      return left.note.operation.id < right.note.operation.id ? -1 : 1;
    });

  const notes: SearchNote[] = [];
  let used = 0;
  let truncated = false;
  for (const entry of ranked) {
    if (notes.length >= request.limit) {
      truncated = true;
      break;
    }
    const remaining = request.maxChars - used;
    if (remaining < MIN_NOTE_CHARS) {
      truncated = true;
      break;
    }
    const clipped = clip(entry.note.text, Math.min(remaining, NOTE_TEXT_MAX));
    used += clipped.text.length;
    truncated ||= clipped.truncated;
    const source = store.getImport(entry.note.candidate.importId);
    notes.push(
      searchNoteSchema.parse({
        candidateId: entry.note.candidate.id,
        operationId: entry.note.operation.id,
        documentId: entry.note.operation.documentId,
        blockId: entry.note.operation.blockId,
        title: entry.note.title,
        text: clipped.text,
        revision: entry.note.revision,
        edited: entry.note.edited,
        truncated: clipped.truncated,
        source: {
          source: source.conversation.source,
          sourceSessionId: source.conversation.sourceSessionId,
          sourceRevision: source.revision,
          messageIds: entry.note.candidate.draft.evidence.map((evidence) => evidence.messageId),
        },
      }),
    );
  }

  return searchResponseSchema.parse({
    projectId: request.projectId,
    notes,
    truncated,
  });
}

/**
 * 抽出有界的查詢詞。
 *
 * 中文沒有空白分詞：短語（長度上限內）整段保留，長句則取相鄰二字詞，避免用整句原文
 * 做字面比對；拉丁字母與數字以非字母數字切開，過短的詞不成為查詢詞。查詢詞數量固定
 * 上限，且順序只取決於輸入，因此同一個問題永遠得到同一組查詢詞。
 *
 * 一個有意義的查詢詞都抽不出來時回傳空陣列；呼叫端不會退化成拿整句原文去比對，
 * 也不會回傳與問題無關的隨機內容。
 */
export function queryTerms(query: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    const term = value.toLowerCase();
    if (term.length < MIN_TERM_LENGTH || seen.has(term) || terms.length >= MAX_TERMS) return;
    seen.add(term);
    terms.push(term);
  };
  for (const word of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length >= MIN_TERM_LENGTH) push(word);
  }
  for (const run of query.split(/[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/)) {
    if (run.length < MIN_TERM_LENGTH) continue;
    if (run.length <= CJK_PHRASE_MAX) {
      push(run);
      continue;
    }
    for (let index = 0; index + CJK_TERM_LENGTH <= run.length; index += 1) {
      push(run.slice(index, index + CJK_TERM_LENGTH));
      if (terms.length >= MAX_TERMS) break;
    }
  }
  return terms;
}

/**
 * 現行的可回傳資格：專案、筆記本與狀態都必須是當下的事實。
 *
 * 候選狀態單獨不足以判斷，因此同時要求候選仍指向這個操作、仍在 published／duplicate，
 * 而且操作仍是 `verified`。撤回中、已撤回、未確認與衝突的操作一律不算已確認知識。
 * 等待後的重新讀取會再套用同一組條件。
 */
function eligible(
  entry: PublicationSnapshot,
  destination: Destination,
  projectId: string,
): boolean {
  const { candidate, operation } = entry;
  if (candidate.projectId !== projectId || operation.projectId !== projectId) return false;
  if (candidate.status !== "published" && candidate.status !== "duplicate") return false;
  if (candidate.operationId !== operation.id) return false;
  if (operation.status !== "verified") return false;
  return operation.notebookId === destination.notebookId;
}

/**
 * 讀回的父文件與擁有區塊是否確實是本系統在這個目的地裡的內容。
 *
 * 兩者都要各自通過檢查，不能只信子區塊：
 *
 * - 父文件：筆記本、原始及目前受管路徑與歸屬（擁有者、專案）都必須是現況；
 *   已有收據的文件可在受管範圍內搬移，首次發布仍須符合計畫路徑。搬出範圍或改掉
 *   歸屬之後，底下的子區塊即使屬性原封不動也不再算授權內容。
 * - 子區塊：所屬文件、筆記本、受管路徑、計畫屬性、擁有權與操作身分全部相符。
 *
 * 任一項不符代表這不是我們可以引用的現況，因此不列入結果，也不會改寫任何狀態。
 */
function owned(
  document: BlockReadback,
  block: BlockReadback,
  operation: Operation,
  destination: Destination,
): boolean {
  if (document.id !== operation.documentId || document.rootId !== operation.documentId)
    return false;
  if (document.notebookId !== operation.notebookId) return false;
  if (document.notebookId !== destination.notebookId) return false;
  if (!withinRoot(document.hpath, rootScope(operation.rootPath))) return false;
  if (!withinRoot(document.hpath, rootScope(destination.rootPath))) return false;
  if (!operation.receipt && operation.kind === "create" && document.hpath !== operation.path)
    return false;
  if (document.attributes[AGENT_ATTR.owner] !== AGENT_OWNER) return false;
  if (document.attributes[AGENT_ATTR.project] !== operation.projectId) return false;

  if (block.rootId !== operation.documentId || block.notebookId !== operation.notebookId)
    return false;
  if (!withinRoot(block.hpath, rootScope(operation.rootPath))) return false;
  // 目前設定的受管路徑也必須涵蓋這個區塊：目的地被縮小之後，舊位置不再算在授權範圍內。
  if (!withinRoot(block.hpath, rootScope(destination.rootPath))) return false;
  if (!operation.receipt && operation.kind === "create" && block.hpath !== operation.path)
    return false;
  for (const [key, expected] of Object.entries(operation.expectedAttributes)) {
    if (block.attributes[key] !== expected) return false;
  }
  return (
    block.attributes[AGENT_ATTR.owner] === AGENT_OWNER &&
    block.attributes[AGENT_ATTR.project] === operation.projectId &&
    block.attributes[AGENT_ATTR.operation] === operation.id &&
    block.attributes[AGENT_ATTR.contentKey] === operation.contentKey &&
    block.attributes[AGENT_ATTR.candidate] === operation.candidateId
  );
}

/**
 * 筆記正文：去掉本系統的擁有超區塊外框與思源自動產生的 IAL，只留下內容本身。
 */
function noteText(kramdown: string): string {
  const lines = canonicalMarkdown(kramdown).split("\n");
  if ((lines[0] ?? "").trim() === "{{{row") lines.shift();
  if ((lines[lines.length - 1] ?? "").trim() === "}}}") lines.pop();
  return lines.join("\n").trim();
}

/** 標題取自現況正文的第一個標題行，人為改標後仍反映實況；否則沿用候選標題。 */
function noteTitle(text: string, fallback: string): string {
  for (const line of text.split("\n")) {
    const heading = /^#{1,6}\s+(.+)$/.exec(line.trim());
    if (heading?.[1]) return heading[1].trim().slice(0, 160);
  }
  return fallback.trim().slice(0, 160);
}

/** 相關度：命中標題的查詢詞權重較高；沒有命中任何查詢詞的內容不會被回傳。 */
function scoreNote(title: string, text: string, terms: readonly string[]): number {
  const heading = title.toLowerCase();
  const body = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (heading.includes(term)) score += 2;
    if (body.includes(term)) score += 1;
  }
  return score;
}

/** 依契約上限截斷內容並回報是否真的截斷。 */
function clip(value: string, max: number): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  const keep = Math.max(0, max - TRUNCATED_MARK.length);
  return { text: `${value.slice(0, keep)}${TRUNCATED_MARK}`, truncated: true };
}
