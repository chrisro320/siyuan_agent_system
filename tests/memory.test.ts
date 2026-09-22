import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppError,
  type Candidate,
  type Conversation,
  captureResponseSchema,
  GENERATION_MODEL,
  type ImportRequest,
  type Judgment,
  type Operation,
  PROMPT_VERSION,
  searchResponseSchema,
} from "../src/contracts";
import { search } from "../src/memory";
import { Worker } from "../src/pipeline/worker";
import { createApp } from "../src/server/app";
import type { Config } from "../src/server/config";
import { AGENT_ATTR, AGENT_OWNER, type BlockReadback, SiyuanClient } from "../src/siyuan/client";
import { normalizeImport } from "../src/sources";
import { digest } from "../src/storage/identity";
import { Store } from "../src/storage/store";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const TOKEN = "synthetic-adapter-token";
const PROJECT = "alpha";
const OTHER_PROJECT = "beta";
const NOTEBOOK = "20260921211444-o3ikhfa";
const ROOT = "/HandsFree";

const RETAIN: Judgment = {
  model: "synthetic-jev",
  disposition: "retain",
  confidence: 0.99,
  reusableValue: 2,
  sensitivity: 0,
  informationStatus: "confirmed",
  domain: "project",
  action: "create",
  answers: {},
  policyRevision: 0,
  usage: {},
};

function setup(adapter = true) {
  const dataDir = mkdtempSync(join(tmpdir(), "siyuan-memory-"));
  const config: Config = {
    dataDir,
    port: 8787,
    hostname: "127.0.0.1",
    publicOrigin: "http://localhost:8787",
    ollamaKey: null,
    jevKey: null,
    siyuanUrl: "",
    siyuanToken: null,
    allowedOmpRoots: [],
    ...(adapter ? { adapterToken: TOKEN, adapterProjects: [PROJECT] } : {}),
  };
  const store = new Store(dataDir);
  const worker = new Worker(store, config);
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  cleanups.push(() => store.close());
  return { dataDir, config, store, worker };
}

function conversation(
  projectId: string,
  texts: readonly string[],
  sessionId: string,
): Conversation {
  return {
    schemaVersion: 1,
    source: "omp",
    sourceSessionId: sessionId,
    projectId,
    startedAt: null,
    sourceLocator: null,
    warnings: [],
    messages: texts.map((text, index) => ({
      sourceMessageId: `m${index + 1}`,
      parentId: index === 0 ? null : `m${index}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      timestamp: null,
      text,
      attachments: [],
      rawLocator: `messages/${index}`,
      missing: ["timestamp"],
      truncated: false,
    })),
  };
}

function captureBody(
  captureId: string,
  projectId: string,
  texts: readonly string[],
  sessionId = "session-a",
  branchLeafId: string | null = null,
) {
  return {
    schemaVersion: 1,
    captureId,
    branchLeafId,
    conversation: conversation(projectId, texts, sessionId),
  };
}

function post(path: string, body: unknown, token?: string): Request {
  return new Request(`http://localhost:8787${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function configureDestination(store: Store, projectId = PROJECT, notebookId = NOTEBOOK) {
  store.saveSettings({
    ...store.settings(),
    destinations: [{ projectId, notebookId, rootPath: ROOT }],
  });
}

/** 節點識別碼必須符合思源的格式，才能通過搜尋端的 ID 檢查。 */
function nodeId(seed: string): string {
  return `20260922120000-${digest(seed).slice(0, 7)}`;
}

interface NoteFixture {
  candidateId: string;
  operationId: string;
  documentId: string;
  blockId: string;
  path: string;
  markdown: string;
  attributes: Record<string, string>;
  importId: string;
  jobId: string;
  projectId: string;
  topic: string;
  sourceKey: string;
  sourceRevision: string;
}

interface PublishOptions {
  key: string;
  title: string;
  body: string;
  projectId?: string;
  notebookId?: string;
  status?: Candidate["status"];
  operationStatus?: "verified" | "undone" | "conflict";
  /** 追加為同一父文件上的另一個擁有區塊：共用匯入與文件，不建立新的來源版本。 */
  appendTo?: NoteFixture;
}

/**
 * 建立一則「已通過 Jev 並已在思源驗證」的筆記，用於搜尋端的情境。
 * 這是測試夾具，不經過 worker 與雲端：只建立資料庫狀態，思源端由假用戶端提供。
 */
async function publish(store: Store, options: PublishOptions): Promise<NoteFixture> {
  const projectId = options.projectId ?? PROJECT;
  const notebookId = options.notebookId ?? NOTEBOOK;
  const topic = "operations";
  const timestamp = new Date().toISOString();
  let importId: string;
  let jobId: string;
  let sourceKey: string;
  let sourceRevision: string;
  if (options.appendTo) {
    importId = options.appendTo.importId;
    jobId = options.appendTo.jobId;
    sourceKey = options.appendTo.sourceKey;
    sourceRevision = options.appendTo.sourceRevision;
  } else {
    const source = conversation(
      projectId,
      [`${options.title}。${options.body}`],
      `session-${options.key}`,
    );
    const request: ImportRequest = {
      format: "conversation",
      content: JSON.stringify(source),
      projectId,
      source: "omp",
      sourceSessionId: source.sourceSessionId,
      sourceLocator: null,
    };
    const { import: record, job } = await store.ingest(request, source);
    importId = record.id;
    jobId = job.id;
    sourceKey = record.sourceKey;
    sourceRevision = record.revision;
  }
  const candidate: Candidate = {
    id: digest(`candidate:${options.key}`),
    logicalId: digest(`logical:${options.key}`),
    jobId,
    importId,
    projectId,
    draft: {
      kind: "decision",
      title: options.title,
      summary: options.body,
      bodyMarkdown: options.body,
      topic,
      limitations: [],
      actions: [],
      uncertainties: [],
      evidence: [{ messageId: "m1", quote: options.title }],
    },
    generation: { model: GENERATION_MODEL, promptVersion: PROMPT_VERSION, usage: {} },
    judgment: RETAIN,
    status: options.status ?? "published",
    operationId: null,
    relatedIds: [],
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  store.saveCandidate(candidate);
  const operationId = digest(`operation:${options.key}`);
  const contentKey = digest(`content:${options.key}`);
  const documentId = options.appendTo?.documentId ?? nodeId(`document:${options.key}`);
  const blockId = nodeId(`block:${options.key}`);
  const attributes: Record<string, string> = {
    id: blockId,
    [AGENT_ATTR.owner]: AGENT_OWNER,
    [AGENT_ATTR.project]: projectId,
    [AGENT_ATTR.topic]: topic,
    [AGENT_ATTR.source]: sourceKey,
    [AGENT_ATTR.revision]: sourceRevision,
    [AGENT_ATTR.candidate]: candidate.id,
    [AGENT_ATTR.operation]: operationId,
    [AGENT_ATTR.contentKey]: contentKey,
  };
  const markdown = `{{{row\n## ${options.title}\n\n${options.body}\n\n}}}\n{: ${Object.entries(
    attributes,
  )
    .map(([key, value]) => `${key}="${value}"`)
    .join(" ")}}`;
  // 追加操作的計畫路徑是受管根目錄本身；建立操作則直接位於專案／主題底下。
  const path = options.appendTo ? ROOT : `${ROOT}/${projectId}/${topic}/${options.key}`;
  const operation: Operation = {
    id: operationId,
    candidateId: candidate.id,
    projectId,
    contentKey,
    kind: options.appendTo ? "append" : "create",
    notebookId,
    path,
    rootPath: ROOT,
    topic,
    documentId,
    blockId,
    markdown,
    expectedAttributes: Object.fromEntries(
      Object.entries(attributes).filter(([key]) => key.startsWith("custom-agent-")),
    ),
    status: "planned",
    receipt: null,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  store.saveOperation(operation);
  const receipt = { markdown, contentHash: digest(markdown), attributes };
  if (options.operationStatus === "conflict") {
    store.saveOperation({ ...operation, status: "conflict", error: "與既有內容衝突" });
  } else {
    store.saveOperation({ ...operation, status: "verified", receipt });
    if (options.operationStatus === "undone") {
      store.saveOperation({ ...operation, status: "undoing", receipt });
      store.saveOperation({ ...operation, status: "undone", receipt });
    }
  }
  store.saveCandidate({ ...candidate, operationId, version: 2, updatedAt: timestamp });
  return {
    candidateId: candidate.id,
    operationId,
    documentId,
    blockId,
    path,
    markdown,
    attributes,
    importId,
    jobId,
    projectId,
    topic,
    sourceKey,
    sourceRevision,
  };
}

/** 子區塊的讀回結果：擁有屬性與現況正文都由夾具決定。 */
function liveBlock(
  fixture: NoteFixture,
  overrides: { kramdown?: string; attributes?: Record<string, string>; hpath?: string } = {},
): BlockReadback {
  return {
    id: fixture.blockId,
    rootId: fixture.documentId,
    notebookId: NOTEBOOK,
    hpath: overrides.hpath ?? fixture.path,
    kramdown: overrides.kramdown ?? fixture.markdown,
    attributes: overrides.attributes ?? fixture.attributes,
  };
}

/** 父文件的擁有屬性；搜尋要求文件本身也屬於本系統與同一個專案。 */
function documentAttributes(fixture: NoteFixture): Record<string, string> {
  return {
    [AGENT_ATTR.owner]: AGENT_OWNER,
    [AGENT_ATTR.project]: fixture.projectId,
    [AGENT_ATTR.topic]: fixture.topic,
  };
}

/**
 * 父文件的讀回結果。文件本身不帶正文，正文由擁有區塊承載。
 */
function liveDocument(
  fixture: NoteFixture,
  overrides: { kramdown?: string; attributes?: Record<string, string>; hpath?: string } = {},
): BlockReadback {
  return {
    id: fixture.documentId,
    rootId: fixture.documentId,
    notebookId: NOTEBOOK,
    hpath: overrides.hpath ?? fixture.path,
    kramdown: overrides.kramdown ?? "",
    attributes: overrides.attributes ?? documentAttributes(fixture),
  };
}

interface FakeNote {
  fixture: NoteFixture;
  block?: Parameters<typeof liveBlock>[1];
  document?: Parameters<typeof liveDocument>[1];
}

/**
 * 假的思源用戶端：全文檢索依現況正文比對已註冊的區塊與文件（真實檢索也會回傳文件節點），
 * 命中只回傳識別碼；讀回則只回傳註冊過的區塊。用來驗證搜尋是拿現況內容與授權判斷，
 * 而不是檢索結果本身。
 */
function fakeSiyuan(notes: FakeNote[]) {
  const queries: Array<{ notebookId: string; query: string }> = [];
  const reads: string[][] = [];
  const blocks: Record<string, BlockReadback> = {};
  for (const note of notes) {
    blocks[note.fixture.blockId] = liveBlock(note.fixture, note.block);
    blocks[note.fixture.documentId] = liveDocument(note.fixture, note.document);
  }
  const read = (ids: readonly string[]): BlockReadback[] => {
    const found: BlockReadback[] = [];
    for (const id of ids) {
      const block = blocks[id];
      if (block) found.push(block);
    }
    return found;
  };
  const client = new SiyuanClient({ url: "http://synthetic.invalid", token: null });
  client.searchBlocks = async (notebookId, query, pageSize = 20) => {
    queries.push({ notebookId, query });
    const needle = query.toLowerCase();
    return Object.values(blocks)
      .filter(
        (block) => block.notebookId === notebookId && block.kramdown.toLowerCase().includes(needle),
      )
      .slice(0, pageSize)
      .map((block) => ({ id: block.id, rootId: block.rootId, notebookId: block.notebookId }));
  };
  client.readBlocks = async (ids) => {
    reads.push([...ids]);
    return read(ids);
  };
  return { client, queries, reads };
}

interface NativeBlock {
  id: string;
  rootId: string;
  notebookId: string;
  hpath: string;
  kramdown: string;
  attributes: Record<string, string>;
}

/**
 * 真實思源用戶端 + 注入的 fetch：回應原生 envelope（`{ code, data }`）與原生欄位名稱
 * （`rootID`、`box`、`root_id`、`hpath`）。用來驗證檢索結果的解析與子區塊命中的搜尋，
 * 不靠假的 parser，也不需要連上真正的思源。
 */
function nativeSiyuan(nativeBlocks: NativeBlock[]) {
  const endpoints: string[] = [];
  const envelope = (data: unknown) => Response.json({ code: 0, data });
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    endpoints.push(path);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const ids: string[] = Array.isArray(body.ids) ? body.ids : [];
    if (path === "/api/sqlite/flushTransaction") return envelope(null);
    if (path === "/api/search/fullTextSearchBlock") {
      const needle = String(body.query).toLowerCase();
      const size = typeof body.pageSize === "number" ? body.pageSize : 20;
      return envelope({
        blocks: nativeBlocks
          .filter((block) => block.kramdown.toLowerCase().includes(needle))
          .slice(0, size)
          .map((block) => ({ id: block.id, rootID: block.rootId, box: block.notebookId })),
      });
    }
    if (path === "/api/query/sql") {
      const statement = String(body.stmt);
      return envelope(
        nativeBlocks
          .filter((block) => statement.includes(`'${block.id}'`))
          .map((block) => ({
            id: block.id,
            root_id: block.rootId,
            box: block.notebookId,
            hpath: block.hpath,
          })),
      );
    }
    if (path === "/api/attr/batchGetBlockAttrs") {
      const attributes: Record<string, Record<string, string>> = {};
      for (const block of nativeBlocks) {
        if (ids.includes(block.id)) attributes[block.id] = block.attributes;
      }
      return envelope(attributes);
    }
    if (path === "/api/block/getBlockKramdowns") {
      const kramdowns: Record<string, string> = {};
      for (const block of nativeBlocks) {
        if (ids.includes(block.id)) kramdowns[block.id] = block.kramdown;
      }
      return envelope(kramdowns);
    }
    throw new Error(`未預期的思源端點：${path}`);
  };
  const client = new SiyuanClient({
    url: "http://synthetic.invalid",
    token: null,
    fetch: fetchImpl as typeof globalThis.fetch,
  });
  return { client, endpoints };
}

test("自動擷取端點需要轉接器憑據，且只受理允許清單內已設定目的地的專案", async () => {
  const disabled = setup(false);
  const disabledApp = createApp(disabled.config, disabled.store, disabled.worker);
  const body = captureBody("capture-1", PROJECT, ["問題一", "回答一"]);
  expect((await disabledApp(post("/api/capture", body, TOKEN))).status).toBe(503);
  expect(disabled.store.jobs()).toEqual([]);

  const { config, store, worker } = setup();
  configureDestination(store);
  const app = createApp(config, store, worker);
  expect((await app(post("/api/capture", body))).status).toBe(401);
  expect((await app(post("/api/capture", body, "wrong-token"))).status).toBe(401);
  expect((await app(post("/api/search", { projectId: PROJECT, query: "問題" }))).status).toBe(401);
  expect(store.jobs()).toEqual([]);

  const denied = await app(
    post("/api/capture", captureBody("capture-2", OTHER_PROJECT, ["其他"]), TOKEN),
  );
  expect(denied.status).toBe(403);
  expect((await denied.json()).error.code).toBe("project_not_allowed");
  expect(store.jobs()).toEqual([]);

  const unconfigured = setup();
  const unconfiguredApp = createApp(unconfigured.config, unconfigured.store, unconfigured.worker);
  expect((await unconfiguredApp(post("/api/capture", body, TOKEN))).status).toBe(403);
  expect(unconfigured.store.jobs()).toEqual([]);

  const malformed = await app(
    post(
      "/api/capture",
      {
        ...body,
        conversation: {
          ...body.conversation,
          messages: [{ ...body.conversation.messages[0], role: "tool" }],
        },
      },
      TOKEN,
    ),
  );
  expect(malformed.status).toBe(400);
  expect(store.jobs()).toEqual([]);

  const accepted = await app(post("/api/capture", body, TOKEN));
  expect(accepted.status).toBe(201);
  expect(captureResponseSchema.parse(await accepted.json())).toEqual({
    captureId: "capture-1",
    importId: expect.any(String),
    jobId: expect.any(String),
    duplicate: false,
  });
  expect(store.jobs()).toHaveLength(1);
});

test("同一擷取識別碼的內容不可變更，重送相同內容回覆原受理", async () => {
  const { config, store, worker } = setup();
  configureDestination(store);
  const app = createApp(config, store, worker);
  const first = captureBody("capture-fixed", PROJECT, ["第一個問題", "第一個回答"]);
  const accepted = captureResponseSchema.parse(
    await (await app(post("/api/capture", first, TOKEN))).json(),
  );
  expect(accepted.duplicate).toBe(false);

  const replay = await app(post("/api/capture", first, TOKEN));
  expect(replay.status).toBe(200);
  expect(captureResponseSchema.parse(await replay.json())).toEqual({
    ...accepted,
    duplicate: true,
  });

  const changed = await app(
    post(
      "/api/capture",
      captureBody("capture-fixed", PROJECT, ["第一個問題", "被改寫的回答"]),
      TOKEN,
    ),
  );
  expect(changed.status).toBe(409);
  expect((await changed.json()).error.code).toBe("capture_conflict");

  expect(store.jobs()).toHaveLength(1);
  expect(store.getImport(accepted.importId).conversation.messages[1]?.text).toBe("第一個回答");
  expect(store.audits().some((entry) => entry.action === "capture.conflict")).toBe(true);
});

test("重啟與重送都不會重複受理，增量快照保留原始訊息身分", async () => {
  const { dataDir, config, store, worker } = setup();
  configureDestination(store);
  const first = captureBody("capture-session-1", PROJECT, ["問題一", "回答一"], "session-a", "m2");
  const accepted = captureResponseSchema.parse(
    await (await createApp(config, store, worker)(post("/api/capture", first, TOKEN))).json(),
  );
  store.close();

  const reopened = new Store(dataDir);
  cleanups.push(() => reopened.close());
  expect(reopened.jobs()).toHaveLength(1);
  expect(reopened.captureReceipt("capture-session-1")?.importId).toBe(accepted.importId);
  expect(reopened.captureReceipt("capture-session-1")?.branchLeafId).toBe("m2");

  const app = createApp(config, reopened, worker);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await app(post("/api/capture", first, TOKEN));
    expect(response.status).toBe(200);
    expect(captureResponseSchema.parse(await response.json())).toEqual({
      ...accepted,
      duplicate: true,
    });
  }
  expect(reopened.jobs()).toHaveLength(1);

  const extended = captureBody("capture-session-2", PROJECT, ["問題一", "回答一", "問題二"]);
  const second = await app(post("/api/capture", extended, TOKEN));
  expect(second.status).toBe(201);
  const secondAccepted = captureResponseSchema.parse(await second.json());
  expect(secondAccepted.importId).not.toBe(accepted.importId);
  expect(reopened.jobs()).toHaveLength(2);
  const stored = reopened.getImport(secondAccepted.importId).conversation;
  expect(stored.messages.map((message) => message.sourceMessageId)).toEqual(["m1", "m2", "m3"]);
  expect(stored.messages[0]?.text).toBe("問題一");
  expect(stored.messages[1]?.parentId).toBe("m1");
  expect(reopened.getImport(accepted.importId).conversation.messages).toHaveLength(2);
});

test("搜尋以現況正文命中中文與英文查詢詞，且不拿整句原文比對", async () => {
  const { store } = setup();
  configureDestination(store);
  const ports = await publish(store, {
    key: "ports",
    title: "連接埠上限",
    body: "服務可用的連接埠上限是 65535。",
  });
  const lunch = await publish(store, { key: "lunch", title: "午餐提醒", body: "今天中午訂便當。" });
  const retry = await publish(store, {
    key: "retry",
    title: "Retry policy",
    body: "Retry after a timeout with backoff.",
  });
  const { client, queries } = fakeSiyuan([
    { fixture: ports },
    { fixture: lunch },
    { fixture: retry },
  ]);

  const cjk = searchResponseSchema.parse(
    await search(store, client, [PROJECT], {
      projectId: PROJECT,
      query: "連接埠的上限是多少？",
      limit: 5,
      maxChars: 8000,
    }),
  );
  expect(cjk.notes.map((note) => note.candidateId)).toEqual([ports.candidateId]);
  const note = cjk.notes[0];
  expect(note?.text).toContain("65535");
  expect(note?.title).toBe("連接埠上限");
  expect(note?.documentId).toBe(ports.documentId);
  expect(note?.blockId).toBe(ports.blockId);
  expect(note?.edited).toBe(false);
  expect(note?.truncated).toBe(false);
  expect(note?.source).toEqual({
    source: "omp",
    sourceSessionId: "session-ports",
    sourceRevision: ports.sourceRevision,
    messageIds: ["m1"],
  });

  const english = searchResponseSchema.parse(
    await search(store, client, [PROJECT], {
      projectId: PROJECT,
      query: "how should retry timeout behave?",
      limit: 5,
      maxChars: 8000,
    }),
  );
  expect(english.notes.map((item) => item.candidateId)).toEqual([retry.candidateId]);

  expect(queries.length).toBeGreaterThan(0);
  expect(queries.every((entry) => entry.notebookId === NOTEBOOK)).toBe(true);
  expect(queries.every((entry) => entry.query.length <= 8)).toBe(true);
  expect(queries.some((entry) => entry.query.includes("連接埠的上限是多少"))).toBe(false);

  const unrelated = searchResponseSchema.parse(
    await search(store, client, [PROJECT], {
      projectId: PROJECT,
      query: "zzz",
      limit: 5,
      maxChars: 8000,
    }),
  );
  expect(unrelated.notes).toEqual([]);

  const before = queries.length;
  const noTerms = searchResponseSchema.parse(
    await search(store, client, [PROJECT], {
      projectId: PROJECT,
      query: "a",
      limit: 5,
      maxChars: 8000,
    }),
  );
  expect(noTerms.notes).toEqual([]);
  expect(queries.length).toBe(before);
});

test("搜尋不跨專案、不跨筆記本，也不採用失去擁有權的區塊", async () => {
  const { store } = setup();
  store.saveSettings({
    ...store.settings(),
    destinations: [
      { projectId: PROJECT, notebookId: NOTEBOOK, rootPath: ROOT },
      { projectId: OTHER_PROJECT, notebookId: NOTEBOOK, rootPath: ROOT },
    ],
  });
  const mine = await publish(store, {
    key: "mine",
    title: "共用連接埠",
    body: "本專案的連接埠設定。",
  });
  const theirs = await publish(store, {
    key: "theirs",
    projectId: OTHER_PROJECT,
    title: "共用連接埠",
    body: "別的專案的連接埠設定。",
  });
  const tampered = await publish(store, {
    key: "tampered",
    title: "共用連接埠備註",
    body: "本專案的連接埠備註。",
  });
  const { client } = fakeSiyuan([
    { fixture: mine },
    { fixture: theirs },
    {
      fixture: tampered,
      block: { attributes: { ...tampered.attributes, [AGENT_ATTR.owner]: "someone-else" } },
    },
  ]);

  const result = searchResponseSchema.parse(
    await search(store, client, [PROJECT], {
      projectId: PROJECT,
      query: "連接埠設定",
      limit: 5,
      maxChars: 8000,
    }),
  );
  expect(result.notes.map((note) => note.candidateId)).toEqual([mine.candidateId]);

  await expect(
    search(store, client, [PROJECT], {
      projectId: OTHER_PROJECT,
      query: "連接埠設定",
      limit: 5,
      maxChars: 8000,
    }),
  ).rejects.toThrow(AppError);
});

test("人為改寫回傳現況，撤回或未確認的內容不回流", async () => {
  const { store } = setup();
  configureDestination(store);
  const edited = await publish(store, {
    key: "edited",
    title: "部署流程",
    body: "部署步驟：先備份。",
  });
  const withdrawn = await publish(store, {
    key: "withdrawn",
    title: "部署流程注意",
    body: "部署流程需要事先公告。",
    operationStatus: "undone",
  });
  const conflicted = await publish(store, {
    key: "conflicted",
    title: "部署流程細節",
    body: "部署流程細節待確認。",
    operationStatus: "conflict",
  });
  const awaiting = await publish(store, {
    key: "awaiting",
    title: "部署流程草稿",
    body: "部署流程草稿。",
    status: "review",
  });
  const human = edited.markdown.replace(
    "部署步驟：先備份。",
    "部署步驟：先備份。\n\n人工補充：請保留這段。",
  );
  const { client } = fakeSiyuan([
    { fixture: edited, block: { kramdown: human } },
    { fixture: withdrawn },
    { fixture: conflicted },
    { fixture: awaiting },
  ]);

  const result = searchResponseSchema.parse(
    await search(store, client, [PROJECT], {
      projectId: PROJECT,
      query: "部署流程",
      limit: 5,
      maxChars: 8000,
    }),
  );
  expect(result.notes.map((note) => note.candidateId)).toEqual([edited.candidateId]);
  const note = result.notes[0];
  expect(note?.edited).toBe(true);
  expect(note?.text).toContain("人工補充：請保留這段。");
  expect(note?.text).not.toContain("{{{");
  expect(note?.title).toBe("部署流程");
  expect(note?.operationId).toBe(edited.operationId);
  expect(result.truncated).toBe(false);
});

test("搜尋輸出受 limit 與 maxChars 限制，順序可重現", async () => {
  const { store } = setup();
  configureDestination(store);
  const strong = await publish(store, {
    key: "strong",
    title: "快取策略",
    body: "快取策略以內容摘要為鍵，避免重複發布。".repeat(60),
  });
  const weak = await publish(store, {
    key: "weak",
    title: "其他主題",
    body: "這一則提到快取策略一次。",
  });
  const extra = await publish(store, {
    key: "extra",
    title: "快取策略補充",
    body: "快取策略補充說明。",
  });
  const { client } = fakeSiyuan([{ fixture: strong }, { fixture: weak }, { fixture: extra }]);
  const ask = (limit: number, maxChars: number) =>
    search(store, client, [PROJECT], { projectId: PROJECT, query: "快取策略", limit, maxChars });

  const first = searchResponseSchema.parse(await ask(5, 8000));
  const second = searchResponseSchema.parse(await ask(5, 8000));
  const order = first.notes.map((note) => note.candidateId);
  expect(order).toEqual(second.notes.map((note) => note.candidateId));
  expect(order[order.length - 1]).toBe(weak.candidateId);
  expect(first.truncated).toBe(false);

  const limited = searchResponseSchema.parse(await ask(2, 8000));
  expect(limited.notes).toHaveLength(2);
  expect(limited.truncated).toBe(true);

  const bounded = searchResponseSchema.parse(await ask(5, 500));
  expect(bounded.truncated).toBe(true);
  expect(bounded.notes.reduce((total, note) => total + note.text.length, 0)).toBeLessThanOrEqual(
    500,
  );
  const clipped = bounded.notes.find((note) => note.truncated);
  expect(clipped?.text.endsWith("已截斷）")).toBe(true);
});

test("搜尋失敗時安全結束、留下可觀察紀錄，且不寫入發布狀態", async () => {
  const { config, store, worker } = setup();
  configureDestination(store);
  await publish(store, { key: "down", title: "逾時處理", body: "逾時後必須先核對。" });
  worker.siyuan.searchBlocks = async () => {
    throw new AppError("siyuan_timeout", "思源未在時限內回應，狀態未知。", true, 504);
  };
  const app = createApp(config, store, worker);
  const operations = store.operations();
  const jobs = store.jobs();
  const secret = "不可記錄的查詢字串";
  const response = await app(post("/api/search", { projectId: PROJECT, query: secret }, TOKEN));
  expect(response.status).toBe(504);
  expect((await response.json()).error.code).toBe("siyuan_timeout");
  expect(store.operations()).toEqual(operations);
  expect(store.jobs()).toEqual(jobs);
  expect(store.audits()[0]?.action).toBe("search.failed");
  expect(JSON.stringify(store.audits())).not.toContain(secret);
});

test("同一擷取識別碼的異內容競態只受理一次，且不留孤兒工作", async () => {
  const { config, store, worker } = setup();
  configureDestination(store);
  const app = createApp(config, store, worker);
  const first = captureBody("capture-race", PROJECT, ["問題一", "第一個回答"]);
  const second = captureBody("capture-race", PROJECT, ["問題一", "被改寫的回答"]);

  const [firstResponse, secondResponse] = await Promise.all([
    app(post("/api/capture", first, TOKEN)),
    app(post("/api/capture", second, TOKEN)),
  ]);
  const responses = [firstResponse, secondResponse];
  const statuses = responses.map((response) => response.status).sort();
  expect(statuses).toEqual([201, 409]);
  const rejected = firstResponse.status === 409 ? firstResponse : secondResponse;
  expect((await rejected.json()).error.code).toBe("capture_conflict");
  expect(store.audits().some((entry) => entry.action === "capture.conflict")).toBe(true);

  // 回條、匯入與工作一起落盤，因此只會有一件工作，而且它一定被回條引用。
  expect(store.jobs()).toHaveLength(1);
  const receipt = store.captureReceipt("capture-race");
  if (!receipt) throw new Error("受理成功卻沒有耐久回條");
  expect(store.getJob(receipt.jobId).importId).toBe(receipt.importId);

  // 落敗的那份內容沒有被寫入；重送勝出內容仍是原本的受理結果。
  const winner = firstResponse.status === 201 ? first : second;
  const accepted = captureResponseSchema.parse(
    await (firstResponse.status === 201 ? firstResponse : secondResponse).json(),
  );
  expect(store.getImport(accepted.importId).conversation.messages[1]?.text).toBe(
    winner.conversation.messages[1]?.text,
  );
  const replay = await app(post("/api/capture", winner, TOKEN));
  expect(replay.status).toBe(200);
  expect(captureResponseSchema.parse(await replay.json())).toEqual({
    ...accepted,
    duplicate: true,
  });
  expect(store.jobs()).toHaveLength(1);
});

test("受理交易失敗時不會留下可執行的工作，未受引用的原始位元組可以留在磁碟", async () => {
  const { dataDir, store } = setup();
  configureDestination(store);
  const body = captureBody("capture-fault", PROJECT, ["問題一", "回答一"]);
  const request: ImportRequest = {
    format: "conversation",
    content: JSON.stringify(body.conversation),
    projectId: PROJECT,
    source: body.conversation.source,
    sourceSessionId: body.conversation.sourceSessionId,
    sourceLocator: body.conversation.sourceLocator,
    acquisition: "manual",
  };

  // 讓交易必定失敗：資料庫連線已關閉，匯入、工作與回條都無法落盤。
  store.close();
  await expect(
    store.ingestCapture({
      captureId: "capture-fault",
      payloadDigest: digest("capture-fault"),
      branchLeafId: null,
      request,
      conversation: normalizeImport(request),
    }),
  ).rejects.toThrow();

  const reopened = new Store(dataDir);
  cleanups.push(() => reopened.close());
  expect(reopened.captureReceipt("capture-fault")).toBeNull();
  expect(reopened.jobs()).toEqual([]);
  // 原始位元組先耐久落盤，因此可能留下沒有回條引用的快照；它不會變成可執行的工作。
  expect(readdirSync(reopened.rawDir).filter((name) => name.endsWith(".raw"))).toHaveLength(1);
});

test("受管範圍內搬移仍可搜尋，父文件失去歸屬或搬出範圍則排除", async () => {
  const { store } = setup();
  configureDestination(store);
  const intact = await publish(store, {
    key: "doc-intact",
    title: "歸屬檢查",
    body: "歸屬檢查以文件為單位。",
  });
  const reassigned = await publish(store, {
    key: "doc-reassigned",
    title: "歸屬檢查備註",
    body: "歸屬檢查備註以文件為單位。",
  });
  const reprojected = await publish(store, {
    key: "doc-reprojected",
    title: "歸屬檢查細節",
    body: "歸屬檢查細節以文件為單位。",
  });
  const relocated = await publish(store, {
    key: "doc-relocated",
    title: "歸屬檢查補述",
    body: "歸屬檢查補述以文件為單位。",
  });
  const { client } = fakeSiyuan([
    {
      fixture: intact,
      document: { hpath: `${ROOT}/${PROJECT}/整理後/歸屬檢查` },
      block: { hpath: `${ROOT}/${PROJECT}/整理後/歸屬檢查` },
    },
    {
      fixture: reassigned,
      document: {
        attributes: { ...documentAttributes(reassigned), [AGENT_ATTR.owner]: "someone-else" },
      },
    },
    {
      fixture: reprojected,
      document: {
        attributes: { ...documentAttributes(reprojected), [AGENT_ATTR.project]: OTHER_PROJECT },
      },
    },
    { fixture: relocated, document: { hpath: "/Elsewhere/kept-same-block" } },
  ]);

  const result = searchResponseSchema.parse(
    await search(store, client, [PROJECT], {
      projectId: PROJECT,
      query: "歸屬檢查",
      limit: 5,
      maxChars: 8000,
    }),
  );
  expect(result.notes.map((note) => note.candidateId)).toEqual([intact.candidateId]);
});

test("等待期間的撤回不會讓等待前的快照漏回", async () => {
  const { store } = setup();
  configureDestination(store);
  const note = await publish(store, {
    key: "await-withdrawn",
    title: "撤回競態",
    body: "撤回競態必須以讀回後的現況判斷。",
  });
  const { client } = fakeSiyuan([{ fixture: note }]);
  const ask = () =>
    search(store, client, [PROJECT], {
      projectId: PROJECT,
      query: "撤回競態",
      limit: 5,
      maxChars: 8000,
    });

  // 對照組：沒有撤回時，同一則筆記確實會被搜尋。
  const control = searchResponseSchema.parse(await ask());
  expect(control.notes.map((entry) => entry.candidateId)).toEqual([note.candidateId]);

  const original = client.readBlocks.bind(client);
  client.readBlocks = async (ids) => {
    // 在網路等待期間（讀回之前）撤回同一個操作。
    const operation = store.getOperation(note.operationId);
    if (operation.status === "verified") {
      store.saveOperation({ ...operation, status: "undoing" });
    }
    return await original(ids);
  };

  const withdrawn = searchResponseSchema.parse(await ask());
  expect(withdrawn.notes).toEqual([]);
  expect(store.getOperation(note.operationId).status).toBe("undoing");
});

test("等待期間目的地被縮小或移除時，等待前的命中不會漏回", async () => {
  const narrowed = setup();
  configureDestination(narrowed.store);
  const moved = await publish(narrowed.store, {
    key: "await-narrowed",
    title: "搬移競態",
    body: "搬移競態必須以當下的受管路徑判斷。",
  });
  const narrowedFake = fakeSiyuan([{ fixture: moved }]);
  const askNarrowed = () =>
    search(narrowed.store, narrowedFake.client, [PROJECT], {
      projectId: PROJECT,
      query: "搬移競態",
      limit: 5,
      maxChars: 8000,
    });
  expect(
    searchResponseSchema.parse(await askNarrowed()).notes.map((entry) => entry.candidateId),
  ).toEqual([moved.candidateId]);

  const originalSettings = narrowed.store.settings();
  narrowedFake.client.searchBlocks = async () => {
    // 在檢索與讀回之間把目的地換成另一個子樹。
    narrowed.store.saveSettings({
      ...originalSettings,
      destinations: [{ projectId: PROJECT, notebookId: NOTEBOOK, rootPath: "/Elsewhere" }],
    });
    return [{ id: moved.blockId, rootId: moved.documentId, notebookId: NOTEBOOK }];
  };
  const narrowedResult = searchResponseSchema.parse(await askNarrowed());
  expect(narrowedResult.notes).toEqual([]);

  const removed = setup();
  configureDestination(removed.store);
  const gone = await publish(removed.store, {
    key: "await-removed",
    title: "移除競態",
    body: "移除競態不得回傳任何內容。",
  });
  const removedFake = fakeSiyuan([{ fixture: gone }]);
  const askRemoved = () =>
    search(removed.store, removedFake.client, [PROJECT], {
      projectId: PROJECT,
      query: "移除競態",
      limit: 5,
      maxChars: 8000,
    });
  expect(
    searchResponseSchema.parse(await askRemoved()).notes.map((entry) => entry.candidateId),
  ).toEqual([gone.candidateId]);

  const removedSettings = removed.store.settings();
  removedFake.client.searchBlocks = async () => {
    removed.store.saveSettings({ ...removedSettings, destinations: [] });
    return [{ id: gone.blockId, rootId: gone.documentId, notebookId: NOTEBOOK }];
  };
  await expect(askRemoved()).rejects.toThrow(AppError);
});

test("搜尋不隨歷史成長：外部讀取前的識別碼數量受固定上限約束", async () => {
  const { store } = setup();
  configureDestination(store);
  const shared = await publish(store, {
    key: "bounded-shared",
    title: "共用文件快取策略",
    body: "共用文件快取策略以修訂為鍵。",
  });
  const appends: NoteFixture[] = [];
  for (let index = 0; index < 70; index += 1) {
    appends.push(
      await publish(store, {
        key: `bounded-append-${index}`,
        title: `共用文件快取策略補充 ${index}`,
        body: "共用文件快取策略補充說明。",
        appendTo: shared,
      }),
    );
  }
  const sharedDocument = { kramdown: "共用文件快取策略以修訂為鍵。", hpath: shared.path };
  const { client, reads } = fakeSiyuan([
    { fixture: shared, document: sharedDocument },
    ...appends.map((fixture) => ({ fixture, document: sharedDocument })),
  ]);

  const result = searchResponseSchema.parse(
    await search(store, client, [PROJECT], {
      projectId: PROJECT,
      query: "快取策略",
      limit: 5,
      maxChars: 8000,
    }),
  );
  // 命中一份文件會連帶命中它所有的追加操作；讀取清單仍有硬上限，不會等於全部操作數。
  const childIds = new Set([shared, ...appends].map((fixture) => fixture.blockId));
  const considered = new Set(reads.flat().filter((id) => childIds.has(id)));
  expect(considered.size).toBeLessThan(childIds.size);
  expect(considered.size).toBeLessThanOrEqual(100);
  expect(result.notes).toHaveLength(5);
});

test("以原生檢索 envelope 解析 {id, rootID, box}，並用子區塊命中完成授權搜尋", async () => {
  const { store } = setup();
  configureDestination(store);
  const note = await publish(store, {
    key: "native-search",
    title: "原生檢索",
    body: "原生檢索以子區塊命中比對所屬文件。",
  });
  const native = nativeSiyuan([
    {
      id: note.documentId,
      rootId: note.documentId,
      notebookId: NOTEBOOK,
      hpath: note.path,
      kramdown: "",
      attributes: documentAttributes(note),
    },
    {
      id: note.blockId,
      rootId: note.documentId,
      notebookId: NOTEBOOK,
      hpath: note.path,
      kramdown: note.markdown,
      attributes: note.attributes,
    },
  ]);

  // 原生欄位名稱（rootID／box）被解析成搜尋端使用的形狀。
  expect(await native.client.searchBlocks(NOTEBOOK, "原生檢索", 20)).toEqual([
    { id: note.blockId, rootId: note.documentId, notebookId: NOTEBOOK },
  ]);

  const result = searchResponseSchema.parse(
    await search(store, native.client, [PROJECT], {
      projectId: PROJECT,
      query: "原生檢索",
      limit: 5,
      maxChars: 8000,
    }),
  );
  expect(result.notes.map((entry) => entry.blockId)).toEqual([note.blockId]);
  expect(result.notes[0]?.documentId).toBe(note.documentId);
  expect(result.notes[0]?.candidateId).toBe(note.candidateId);
  expect(native.endpoints).toContain("/api/search/fullTextSearchBlock");
});
