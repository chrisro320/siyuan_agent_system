import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppError,
  type Candidate,
  type Conversation,
  type ImportRequest,
  type Operation,
} from "../src/contracts/index.ts";
import {
  digest,
  messageKeyOf,
  messageRevisionOf,
  now,
  revisionOf,
  sourceKeyOf,
} from "../src/storage/identity.ts";
import { Store } from "../src/storage/store.ts";

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "siyuan-store-"));
}

function buildConversation(text = "第一版結論：以內容摘要作為發布識別。"): Conversation {
  return {
    schemaVersion: 1,
    source: "omp",
    sourceSessionId: "session-a",
    projectId: "project-x",
    startedAt: "2026-09-01T00:00:00.000Z",
    sourceLocator: "/sessions/session-a.jsonl",
    messages: [
      {
        sourceMessageId: "m1",
        parentId: null,
        role: "user",
        timestamp: "2026-09-01T00:00:01.000Z",
        text: "我們要如何避免重複發布？",
        attachments: [],
        rawLocator: "/sessions/session-a.jsonl:1",
        missing: [],
        truncated: false,
      },
      {
        sourceMessageId: "m2",
        parentId: "m1",
        role: "assistant",
        timestamp: "2026-09-01T00:00:02.000Z",
        text,
        attachments: [
          { locator: "/attachments/a.png", mediaType: "image/png", status: "not-analyzed" },
        ],
        rawLocator: "/sessions/session-a.jsonl:2",
        missing: ["timestamp"],
        truncated: true,
      },
    ],
    warnings: [],
  };
}

function buildRequest(content = JSON.stringify(buildConversation())): ImportRequest {
  return {
    format: "conversation",
    content,
    projectId: "project-x",
    source: "omp",
    sourceSessionId: "session-a",
    sourceLocator: "/sessions/session-a.jsonl",
  };
}

function buildCandidate(overrides: Partial<Candidate> = {}): Candidate {
  const timestamp = now();
  return {
    id: "candidate-1",
    logicalId: "logical-1",
    jobId: "job-1",
    importId: "import-1",
    projectId: "project-x",
    draft: {
      kind: "conclusion",
      title: "內容摘要作為發布識別",
      summary: "同一來源版本僅發布一次。",
      bodyMarkdown: "以內容摘要作為識別鍵。",
      topic: "idempotency",
      limitations: [],
      actions: [],
      uncertainties: [],
      evidence: [{ messageId: "m2", quote: "內容摘要" }],
    },
    generation: { model: "synthetic-model", promptVersion: "extract-1", usage: {} },
    judgment: null,
    status: "pending",
    operationId: null,
    relatedIds: [],
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function buildOperation(overrides: Partial<Operation> = {}): Operation {
  const timestamp = now();
  return {
    id: "operation-1",
    candidateId: "candidate-1",
    projectId: "project-x",
    contentKey: "content-key-1",
    kind: "create",
    notebookId: "nb-1",
    path: "/專案/識別",
    rootPath: "/專案",
    topic: "idempotency",
    documentId: "20260921212100-doc0001",
    blockId: "20260921212100-blk0001",
    markdown: "## 摘要",
    expectedAttributes: {},
    status: "planned",
    receipt: null,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

describe("Store 匯入識別", () => {
  let dataDir: string;
  let store: Store;

  beforeEach(() => {
    dataDir = tempDataDir();
    store = new Store(dataDir);
  });

  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("相同來源版本匯入三次只產生一筆匯入與一件工作", async () => {
    const request = buildRequest();
    const conversation = buildConversation();

    const first = await store.ingest(request, conversation);
    const second = await store.ingest(request, conversation);
    const third = await store.ingest(request, conversation);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(third.duplicate).toBe(true);
    expect(second.import.id).toBe(first.import.id);
    expect(third.job.id).toBe(first.job.id);
    expect(store.jobs()).toHaveLength(1);
  });

  test("相同位元組重複匯入只保留一列快照，不新增工作", async () => {
    const request = buildRequest();
    const conversation = buildConversation();
    const first = await store.ingest(request, conversation);
    await store.ingest(request, conversation);
    await store.ingest(request, conversation);

    const snapshots = store.snapshots(first.import.id);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.rawDigest).toBe(digest(request.content));
    expect(snapshots[0]?.sourceLocator).toBe(request.sourceLocator);
    expect(store.jobs()).toHaveLength(1);
  });

  test("相同正規化版本但原始位元組不同時各自留下可列舉的快照", async () => {
    const conversation = buildConversation();
    const compact = JSON.stringify(conversation);
    const indented = JSON.stringify(conversation, null, 2);
    expect(indented).not.toBe(compact);
    expect(revisionOf(conversation)).toBe(revisionOf(JSON.parse(indented) as Conversation));

    const first = await store.ingest(buildRequest(compact), conversation);
    const second = await store.ingest(buildRequest(indented), conversation);

    expect(second.duplicate).toBe(true);
    expect(second.import.id).toBe(first.import.id);
    const digests = store
      .snapshots(first.import.id)
      .map((row) => row.rawDigest)
      .sort();
    expect(digests).toEqual([digest(compact), digest(indented)].sort());
    expect(readdirSync(store.rawDir).sort()).toEqual(
      [`${digest(compact)}.raw`, `${digest(indented)}.raw`].sort(),
    );
    expect(store.jobs()).toHaveLength(1);
  });

  test("原始快照以內容摘要命名、保存原文且不重複落盤", async () => {
    const request = buildRequest();
    const conversation = buildConversation();
    await store.ingest(request, conversation);
    await store.ingest(request, conversation);

    const files = readdirSync(store.rawDir);
    expect(files).toEqual([`${digest(request.content)}.raw`]);
    expect(readFileSync(join(store.rawDir, files[0] as string), "utf8")).toBe(request.content);
  });

  test("資料目錄與資料庫檔案權限收斂為 0700 與 0600", async () => {
    await store.ingest(buildRequest(), buildConversation());
    const mode = (path: string) => statSync(path).mode & 0o777;
    expect(mode(dataDir)).toBe(0o700);
    expect(mode(store.rawDir)).toBe(0o700);
    expect(mode(join(store.rawDir, readdirSync(store.rawDir)[0] as string))).toBe(0o600);
    expect(mode(join(dataDir, "store.sqlite"))).toBe(0o600);
    expect(existsSync(join(dataDir, "store.sqlite"))).toBe(true);
  });

  test("來源內容變更視為新版本並保留舊版本與每則訊息版本", async () => {
    const conversation = buildConversation();
    const first = await store.ingest(buildRequest(), conversation);

    const edited = buildConversation("第二版結論：改以操作識別作為發布識別。");
    const editedRequest = buildRequest(JSON.stringify(edited));
    const second = await store.ingest(editedRequest, edited);

    expect(second.duplicate).toBe(false);
    expect(second.import.id).not.toBe(first.import.id);
    expect(second.import.revision).not.toBe(first.import.revision);
    // 訊息的 rawLocator 改變不影響語義版本；只有文字真的變了才換版本。
    const cosmetic = buildConversation();
    const cosmeticMessage = cosmetic.messages[1];
    const originalMessage = conversation.messages[1];
    const editedMessage = edited.messages[1];
    if (!cosmeticMessage || !originalMessage || !editedMessage) throw new Error("缺少測試訊息");
    cosmeticMessage.rawLocator = "/sessions/session-a.jsonl:99";
    expect(revisionOf(cosmetic)).toBe(first.import.revision);
    expect(store.jobs()).toHaveLength(2);

    const revisions = store.messageRevisions(sourceKeyOf("omp", "session-a", "project-x"));
    const m2Revisions = revisions.filter(
      (row) => row.messageKey === messageKeyOf(first.import.sourceKey, "m2"),
    );
    expect(m2Revisions).toHaveLength(2);
    expect(m2Revisions.map((row) => row.revision).sort()).toEqual(
      [messageRevisionOf(originalMessage), messageRevisionOf(editedMessage)].sort(),
    );
    expect(store.getImport(first.import.id).conversation.messages[1]?.text).toContain("第一版結論");
  });

  test("未變更的訊息在後續版本重用相同版本，但 membership 仍完整列出", async () => {
    const conversation = buildConversation();
    const first = await store.ingest(buildRequest(), conversation);

    const edited = buildConversation("第二版結論：改以操作識別作為發布識別。");
    const second = await store.ingest(buildRequest(JSON.stringify(edited)), edited);

    const firstMembership = store.revisionMessages(first.import.id);
    const secondMembership = store.revisionMessages(second.import.id);
    expect(firstMembership.map((row) => row.ordinal)).toEqual([0, 1]);
    expect(secondMembership.map((row) => row.ordinal)).toEqual([0, 1]);

    const m1 = messageKeyOf(first.import.sourceKey, "m1");
    const m2 = messageKeyOf(first.import.sourceKey, "m2");
    const unchangedMessage = conversation.messages[0];
    if (!unchangedMessage) throw new Error("缺少測試訊息");
    expect(secondMembership[0]).toEqual({
      ordinal: 0,
      messageKey: m1,
      messageRevision: messageRevisionOf(unchangedMessage),
    });
    // m1 內容未變，因此第二個 import 的 membership 重用同一個訊息版本。
    expect(secondMembership[0]?.messageRevision).toBe(firstMembership[0]?.messageRevision);
    expect(secondMembership[1]?.messageKey).toBe(m2);
    expect(secondMembership[1]?.messageRevision).not.toBe(firstMembership[1]?.messageRevision);
    // 訊息版本表本身仍然只有兩個版本，沒有因為 membership 而重複膨脹。
    expect(
      store.messageRevisions(first.import.sourceKey).filter((row) => row.messageKey === m1),
    ).toHaveLength(1);
  });

  test("完整性警告納入來源版本：partial 轉 complete 會產生新版本", async () => {
    const partial = buildConversation();
    partial.warnings = ["尾端不完整", "尾端不完整"];
    const complete = buildConversation();
    complete.warnings = [];

    expect(revisionOf(partial)).not.toBe(revisionOf(complete));
    // 同一組警告的順序或重複次數不構成新版本。
    const reordered = buildConversation();
    reordered.warnings = ["尾端不完整"];
    expect(revisionOf(reordered)).toBe(revisionOf(partial));

    const first = await store.ingest(buildRequest(JSON.stringify(partial)), partial);
    const recovered = await store.ingest(buildRequest(JSON.stringify(complete)), complete);

    expect(recovered.duplicate).toBe(false);
    expect(recovered.import.id).not.toBe(first.import.id);
    expect(store.getImport(recovered.import.id).conversation.warnings).toEqual([]);
    expect(store.getImport(first.import.id).conversation.warnings).toContain("尾端不完整");
    // 來源定位仍不進版本：只換 sourceLocator 不該產生新版本。
    const relocatedRequest = {
      ...buildRequest(JSON.stringify(complete)),
      sourceLocator: "/other/path.jsonl",
    };
    const relocated = await store.ingest(relocatedRequest, complete);
    expect(relocated.duplicate).toBe(true);
    expect(relocated.import.id).toBe(recovered.import.id);

    // 反向：完整轉不完整同樣是新版本，不會被當成 duplicate 而沿用舊警告。
    const partialAgain = buildConversation();
    partialAgain.warnings = ["中段缺少時間戳"];
    const reopened = await store.ingest(buildRequest(JSON.stringify(partialAgain)), partialAgain);
    expect(reopened.duplicate).toBe(false);
    expect(reopened.import.id).not.toBe(recovered.import.id);
    expect(store.getImport(reopened.import.id).conversation.warnings).toContain("中段缺少時間戳");

    // 同一組警告（去重排序後相同）仍視為同一來源版本。
    const sameAgain = buildConversation();
    sameAgain.warnings = ["中段缺少時間戳", "中段缺少時間戳"];
    const deduped = await store.ingest(buildRequest(JSON.stringify(sameAgain)), sameAgain);
    expect(deduped.duplicate).toBe(true);
    expect(deduped.import.id).toBe(reopened.import.id);
  });

  test("政策或設定版本變更後重複匯入不會自動建立新工作", async () => {
    const request = buildRequest();
    const conversation = buildConversation();
    const first = await store.ingest(request, conversation);
    expect(store.jobs()).toHaveLength(1);

    store.saveSettings({
      ...store.settings(),
      destinations: [{ projectId: "project-x", notebookId: "nb-1", rootPath: "/專案" }],
    });

    const repeated = await store.ingest(request, conversation);
    expect(repeated.duplicate).toBe(true);
    expect(repeated.job.id).toBe(first.job.id);
    expect(store.jobs()).toHaveLength(1);

    // 只有明示的重新處理才會以目前政策建立新的執行。
    const reprocessed = store.createJob(first.import.id, true);
    expect(reprocessed.id).not.toBe(first.job.id);
    expect(reprocessed.policyRevision).toBe(store.settings().revision);
    expect(store.jobs()).toHaveLength(2);
  });

  test("強制新執行不覆寫既有候選歷史", async () => {
    const { import: record } = await store.ingest(buildRequest(), buildConversation());
    const first = store.createJob(record.id);
    const candidate = buildCandidate({ jobId: first.id, importId: record.id });
    store.saveCandidate(candidate);

    expect(store.createJob(record.id).id).toBe(first.id);

    const second = store.createJob(record.id, true);
    expect(second.run).toBe(1);
    expect(second.id).not.toBe(first.id);
    expect(second.extractionComplete).toBe(false);
    expect(second.nextSegment).toBe(0);
    expect(store.getJob(first.id).status).toBe(first.status);
    expect(store.candidates(first.id).map((row) => row.id)).toEqual([candidate.id]);
    expect(store.jobs()).toHaveLength(2);
  });

  test("並行匯入不同版本不會因交易跨越等待而失敗", async () => {
    const first = buildConversation("並行第一版。");
    const second = buildConversation("並行第二版。");
    const results = await Promise.all([
      store.ingest(buildRequest(JSON.stringify(first)), first),
      store.ingest(buildRequest(JSON.stringify(second)), second),
    ]);

    expect(results.map((row) => row.duplicate)).toEqual([false, false]);
    expect(store.jobs()).toHaveLength(2);
    for (const row of results) {
      expect(store.getImport(row.import.id).revision).toBe(row.import.revision);
    }
  });

  test("一般工作更新不能新增另一個工作識別碼", async () => {
    const { import: record } = await store.ingest(buildRequest(), buildConversation());
    const job = store.createJob(record.id);

    let thrown: unknown;
    try {
      store.saveJob({ ...job, id: "job-copy" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).status).toBe(404);
    expect(store.jobs().map((row) => row.id)).toEqual([job.id]);
  });

  test("讀取不存在的匯入、工作、候選與操作一律 404", async () => {
    const { import: record } = await store.ingest(buildRequest(), buildConversation());
    const job = store.createJob(record.id);
    const cases: (() => unknown)[] = [
      () => store.getImport("missing"),
      () => store.getJob("missing"),
      () => store.getCandidate("missing"),
      () => store.getOperation("missing"),
    ];
    for (const run of cases) {
      try {
        run();
        throw new Error("預期拋出 AppError");
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).status).toBe(404);
      }
    }
    expect(store.getJob(job.id).id).toBe(job.id);
  });
});

describe("Store 候選版本與分段保存", () => {
  let dataDir: string;
  let store: Store;

  beforeEach(() => {
    dataDir = tempDataDir();
    store = new Store(dataDir);
  });

  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function readyJob(): Promise<{ jobId: string; importId: string }> {
    const { import: record } = await store.ingest(buildRequest(), buildConversation());
    const job = store.createJob(record.id);
    return { jobId: job.id, importId: record.id };
  }

  test("候選版本遞增並保留 append-only 歷史", async () => {
    const { jobId, importId } = await readyJob();
    const first = buildCandidate({ jobId, importId });
    store.saveCandidate(first);

    const second = { ...first, status: "ready" as const, version: 2, updatedAt: now() };
    store.saveCandidate(second);
    expect(store.getCandidate(first.id).status).toBe("ready");

    const history = store.candidateRevisions(first.id);
    expect(history.map((row) => row.version)).toEqual([1, 2]);
    expect(history[0]?.candidate.status).toBe("pending");
    expect(history[1]?.candidate.status).toBe("ready");

    // 相同版本逐位元相同視為重送，不新增歷史列。
    store.saveCandidate(second);
    expect(store.candidateRevisions(first.id)).toHaveLength(2);
    expect(store.getCandidate(first.id)).toEqual(second);
  });

  test("同版本的過期內容與跨版本跳號一律被拒", async () => {
    const { jobId, importId } = await readyJob();
    const first = buildCandidate({ jobId, importId });
    store.saveCandidate(first);
    const second = { ...first, status: "ready" as const, version: 2, updatedAt: now() };
    store.saveCandidate(second);

    // 用第 1 版的舊內容宣告第 2 版：同版本、內容不同。
    expect(() => store.saveCandidate({ ...first, version: 2 })).toThrow(AppError);
    // 跳號：目前是第 2 版，只接受第 3 版。
    expect(() =>
      store.saveCandidate({ ...first, status: "review", version: 4, updatedAt: now() }),
    ).toThrow(AppError);
    expect(store.getCandidate(first.id).version).toBe(2);
    expect(store.candidateRevisions(first.id)).toHaveLength(2);
  });

  test("候選的跨執行識別不可變更", async () => {
    const { jobId, importId } = await readyJob();
    const first = buildCandidate({ jobId, importId });
    store.saveCandidate(first);

    expect(() =>
      store.saveCandidate({ ...first, logicalId: "logical-2", version: 2, updatedAt: now() }),
    ).toThrow(AppError);
    expect(() =>
      store.saveCandidate({ ...first, jobId: "job-other", version: 2, updatedAt: now() }),
    ).toThrow(AppError);
    expect(store.getCandidate(first.id).logicalId).toBe("logical-1");
  });

  test("整段候選與 checkpoint 同交易落盤，撤回時不留半批", async () => {
    const { jobId, importId } = await readyJob();
    const job = store.getJob(jobId);
    expect(() => store.commitExtractionSegment({ ...job, nextSegment: 1 }, [])).toThrow(AppError);
    job.extractionPlan = "plan-one";
    store.saveJob(job);
    const batch = [
      buildCandidate({ id: "batch-a", logicalId: "logical-shared", jobId, importId }),
      buildCandidate({ id: "batch-b", logicalId: "logical-shared", jobId, importId }),
      buildCandidate({ id: "batch-c", logicalId: "logical-other", jobId, importId }),
    ];
    const checkpoint = { ...job, nextSegment: 1, status: "extracting" as const, updatedAt: now() };

    const advanced = store.commitExtractionSegment(checkpoint, batch);
    expect(advanced.nextSegment).toBe(1);
    // 同一段允許相同 logicalId 的多個獨立候選。
    expect(
      store
        .candidates(jobId)
        .map((row) => row.id)
        .sort(),
    ).toEqual(["batch-a", "batch-b", "batch-c"]);
    expect(store.getJob(jobId).nextSegment).toBe(1);

    // 已提交的整批、子集與空批次都不可冒充下一段。
    for (const repeated of [batch, batch.slice(0, 1), []]) {
      expect(() => store.commitExtractionSegment(checkpoint, repeated)).toThrow(AppError);
    }

    // 用落後的 checkpoint 送不同的一批：整批拒絕，投影與進度都不動。
    const stale = [
      buildCandidate({ id: "batch-d", logicalId: "logical-shared", jobId, importId }),
      buildCandidate({ id: "batch-e", logicalId: "logical-shared", jobId, importId }),
    ];
    expect(() => store.commitExtractionSegment(checkpoint, stale)).toThrow(AppError);
    expect(
      store
        .candidates(jobId)
        .map((row) => row.id)
        .sort(),
    ).toEqual(["batch-a", "batch-b", "batch-c"]);
    expect(store.getJob(jobId).nextSegment).toBe(1);

    // 跨工作或跨匯入的候選不得混入同一段。
    const other = buildCandidate({
      id: "batch-f",
      logicalId: "logical-other",
      jobId: "job-other",
      importId,
    });
    const nextCheckpoint = { ...store.getJob(jobId), nextSegment: 2, updatedAt: now() };
    expect(() => store.commitExtractionSegment(nextCheckpoint, [other])).toThrow(AppError);
    expect(store.candidates(jobId)).toHaveLength(3);
    expect(store.getJob(jobId).nextSegment).toBe(1);
    expect(() => store.saveJob({ ...store.getJob(jobId), extractionPlan: null })).toThrow(AppError);
    expect(() => store.saveJob({ ...store.getJob(jobId), extractionPlan: "different" })).toThrow(
      AppError,
    );
    expect(() => store.saveJob({ ...store.getJob(jobId), nextSegment: 0 })).toThrow(AppError);
    expect(() => store.saveJob({ ...store.getJob(jobId), importId: "another-import" })).toThrow(
      AppError,
    );
  });

  test("段落中途失敗時整批回滾，不留半批候選或前進的進度", async () => {
    const { jobId, importId } = await readyJob();
    const job = store.getJob(jobId);
    job.extractionPlan = "plan-rollback";
    store.saveJob(job);
    // 先落盤第 1 版；第二批再用同 id、同版本但內容不同，寫入必定被拒。
    const conflicting = buildCandidate({
      id: "batch-conflict",
      logicalId: "logical-x",
      jobId,
      importId,
    });
    store.saveCandidate(conflicting);

    const batch = [
      buildCandidate({ id: "batch-new", logicalId: "logical-y", jobId, importId }),
      { ...conflicting, updatedAt: new Date(0).toISOString() },
    ];
    let thrown: unknown;
    try {
      store.commitExtractionSegment({ ...job, nextSegment: 1, updatedAt: now() }, batch);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).status).toBe(409);

    // 第二筆失敗使整批回滾：第一筆沒有落盤，進度也沒有前進。
    expect(store.candidates(jobId).map((row) => row.id)).toEqual(["batch-conflict"]);
    expect(store.getJob(jobId).nextSegment).toBe(0);
    let missing: unknown;
    try {
      store.getCandidate("batch-new");
    } catch (error) {
      missing = error;
    }
    expect(missing).toBeInstanceOf(AppError);
    expect((missing as AppError).status).toBe(404);
    expect(store.candidateRevisions("batch-conflict")).toHaveLength(1);
  });
});

describe("Store 設定版本", () => {
  let dataDir: string;
  let store: Store;

  beforeEach(() => {
    dataDir = tempDataDir();
    store = new Store(dataDir);
  });

  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("過期設定版本被拒並保留歷史版本", async () => {
    const base = store.settings();
    expect(base.revision).toBe(0);

    const first = store.saveSettings({
      ...base,
      policy: { ...base.policy, minValue: 1.2 },
    });
    expect(first.revision).toBe(1);

    expect(() =>
      store.saveSettings({ ...base, policy: { ...base.policy, minValue: 1.4 } }),
    ).toThrow(AppError);
    expect(store.settings().policy.minValue).toBe(1.2);
    expect(store.settings(0)).toEqual(base);
    expect(store.audits().some((row) => row.action === "settings.saved")).toBe(true);
  });

  test("讀取不存在的設定版本為 404", () => {
    let thrown: unknown;
    try {
      store.settings(7);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).status).toBe(404);
    expect(() => store.settings()).not.toThrow();
  });
});

describe("Store 操作對帳與重啟復原", () => {
  let dataDir: string;
  let store: Store;

  beforeEach(() => {
    dataDir = tempDataDir();
    store = new Store(dataDir);
  });

  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("發布操作的內容識別唯一，跨識別碼碰撞不被吞掉", () => {
    const operation = buildOperation();
    store.saveOperation(operation);
    expect(store.findOperation("content-key-1")?.id).toBe("operation-1");

    // 同一識別碼可更新自身狀態。
    store.saveOperation({ ...operation, status: "sent" });
    expect(store.getOperation("operation-1").status).toBe("sent");

    let thrown: unknown;
    try {
      store.saveOperation(buildOperation({ id: "operation-2" }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).status).toBe(409);
    expect(store.operations()).toHaveLength(1);
    expect(store.getOperation("operation-1").status).toBe("sent");
  });

  test("同一操作識別不可改寫計畫欄位或退回計畫狀態", () => {
    const operation = buildOperation();
    store.saveOperation(operation);

    // 同一個 id 但目標或內容不同：不得改寫已定案的計畫。
    expect(() => store.saveOperation({ ...operation, markdown: "## 竄改" })).toThrow(AppError);
    expect(() =>
      store.saveOperation({ ...operation, documentId: "20260921212100-doc0002" }),
    ).toThrow(AppError);
    expect(() => store.saveOperation({ ...operation, contentKey: "content-key-9" })).toThrow(
      AppError,
    );
    expect(store.getOperation("operation-1").markdown).toBe(operation.markdown);

    // 進入已送出之後，落後的 planned 物件不得把它退回未送出。
    store.saveOperation({ ...operation, status: "sent" });
    store.saveOperation({ ...operation, status: "uncertain" });
    expect(() => store.saveOperation({ ...operation, status: "planned" })).toThrow(AppError);
    expect(store.getOperation("operation-1").status).toBe("uncertain");

    // 只有合法轉移可前進；unknown 組合一律拒絕。
    const verified = {
      ...operation,
      receipt: { markdown: operation.markdown, contentHash: "receipt", attributes: {} },
    };
    store.saveOperation({ ...verified, status: "verified" });
    expect(() => store.saveOperation({ ...verified, status: "sent" })).toThrow(AppError);
    store.saveOperation({ ...verified, status: "undoing" });
    expect(() => store.saveOperation({ ...verified, status: "verified" })).toThrow(AppError);
    store.saveOperation({ ...verified, status: "undone" });
    expect(() => store.saveOperation({ ...verified, status: "planned" })).toThrow(AppError);
    expect(store.getOperation("operation-1").status).toBe("undone");
  });

  test("簽收一旦存在即不可改寫或消失", () => {
    const operation = buildOperation();
    store.saveOperation(operation);
    store.saveOperation({ ...operation, status: "sent" });
    const receipt = { markdown: "## 簽收", contentHash: "hash-1", attributes: { id: "blk-1" } };
    store.saveOperation({ ...operation, status: "verified", receipt });

    expect(() => store.saveOperation({ ...operation, status: "verified", receipt: null })).toThrow(
      AppError,
    );
    expect(() =>
      store.saveOperation({
        ...operation,
        status: "verified",
        receipt: { ...receipt, contentHash: "hash-2" },
      }),
    ).toThrow(AppError);
    expect(store.getOperation("operation-1").receipt?.contentHash).toBe("hash-1");

    // 不帶簽收的同狀態更新（只有 error/updatedAt 變動）仍可寫入。
    store.saveOperation({
      ...operation,
      status: "verified",
      receipt,
      error: "讀回內容與預期不符。",
    });
    expect(store.getOperation("operation-1").error).toBe("讀回內容與預期不符。");
  });

  test("衝突狀態只能維持衝突", () => {
    const operation = buildOperation();
    store.saveOperation(operation);
    store.saveOperation({ ...operation, status: "conflict" });

    expect(() => store.saveOperation({ ...operation, status: "planned" })).toThrow(AppError);
    expect(() => store.saveOperation({ ...operation, status: "verified" })).toThrow(AppError);
    store.saveOperation({ ...operation, status: "conflict", error: "遠端內容與預期不符。" });
    expect(store.getOperation("operation-1").status).toBe("conflict");
  });

  test("寫前必須先保存計畫，且只有驗證階段可首次取得回條", () => {
    const operation = buildOperation();
    for (const status of ["sent", "verified", "undoing", "undone"] as const) {
      expect(() => store.saveOperation({ ...operation, status })).toThrow(AppError);
    }
    store.saveOperation(operation);
    expect(() => store.saveOperation({ ...operation, status: "verified" })).toThrow(AppError);
    for (const status of ["sent", "uncertain", "conflict"] as const) {
      expect(() =>
        store.saveOperation({
          ...operation,
          status,
          receipt: { markdown: "unverified", contentHash: "x", attributes: {} },
        }),
      ).toThrow(AppError);
    }
    expect(store.getOperation(operation.id).status).toBe("planned");
  });

  test("重啟後中斷的工作排入重試、已送出的寫入改記為不確定", async () => {
    const { import: record } = await store.ingest(buildRequest(), buildConversation());
    const job = store.createJob(record.id);
    store.saveJob({ ...job, status: "extracting", attempts: 2 });
    for (const [index, status] of ["sent", "verified", "planned", "undoing"].entries()) {
      const operation = buildOperation({
        id: `operation-${index + 1}`,
        contentKey: `content-key-${index + 1}`,
      });
      store.saveOperation(operation);
      if (status === "sent") store.saveOperation({ ...operation, status: "sent" });
      if (status === "verified" || status === "undoing") {
        const verified = {
          ...operation,
          receipt: { markdown: operation.markdown, contentHash: "receipt", attributes: {} },
        };
        store.saveOperation({ ...verified, status: "verified" });
        if (status === "undoing") store.saveOperation({ ...verified, status: "undoing" });
      }
    }

    store.recoverInterrupted();

    const recovered = store.getJob(job.id);
    expect(recovered.status).toBe("retry-wait");
    expect(recovered.nextAttemptAt).not.toBeNull();
    expect(recovered.error?.retryable).toBe(true);
    expect(recovered.error?.stage).toBe("extracting");
    expect(recovered.attempts).toBe(2);

    expect(store.getOperation("operation-1").status).toBe("uncertain");
    expect(store.getOperation("operation-2").status).toBe("verified");
    expect(store.getOperation("operation-3").status).toBe("planned");
    expect(store.getOperation("operation-4").status).toBe("undoing");
  });

  test("中斷復原保留分段進度與摘錄完成狀態", async () => {
    const { import: record } = await store.ingest(buildRequest(), buildConversation());
    const job = store.createJob(record.id);
    store.saveJob({
      ...job,
      status: "judging",
      nextSegment: 3,
      extractionComplete: true,
      attempts: 1,
    });

    store.recoverInterrupted();

    const recovered = store.getJob(job.id);
    expect(recovered.status).toBe("retry-wait");
    expect(recovered.nextSegment).toBe(3);
    expect(recovered.extractionComplete).toBe(true);
  });

  test("已完成與失敗的工作不因重啟被改變", async () => {
    const { import: record } = await store.ingest(buildRequest(), buildConversation());
    const job = store.createJob(record.id);
    store.saveJob({ ...job, status: "complete" });

    const second = store.createJob(record.id, true);
    store.saveJob({
      ...second,
      status: "failed",
      error: {
        code: "provider",
        message: "生成服務暫時無法使用。",
        stage: "extracting",
        retryable: false,
      },
    });

    store.recoverInterrupted();

    expect(store.getJob(job.id).status).toBe("complete");
    expect(store.getJob(second.id).status).toBe("failed");
  });
});

describe("Store 列表", () => {
  let dataDir: string;
  let store: Store;

  beforeEach(() => {
    dataDir = tempDataDir();
    store = new Store(dataDir);
  });

  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("列表以最新在前且不截斷候選", async () => {
    const { import: record } = await store.ingest(buildRequest(), buildConversation());
    const job = store.createJob(record.id);
    for (let index = 0; index < 40; index += 1) {
      store.saveCandidate(
        buildCandidate({
          id: `candidate-${index}`,
          logicalId: `logical-${index}`,
          jobId: job.id,
          importId: record.id,
        }),
      );
    }
    store.audit("test.first", "target-a", "第一筆");
    store.audit("test.second", "target-b", "第二筆");

    expect(store.candidates()).toHaveLength(40);
    expect(store.candidates(job.id)).toHaveLength(40);
    expect(store.candidates()[0]?.id).toBe("candidate-39");
    expect(store.audits()[0]?.action).toBe("test.second");
    expect(store.jobs()[0]?.id).toBe(job.id);
  });
});
