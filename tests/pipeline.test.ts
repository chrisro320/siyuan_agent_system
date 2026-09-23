import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppError,
  type Candidate,
  type CandidateDraft,
  type Conversation,
  type GenerationProfile,
  type Job,
  type Judgment,
  PROMPT_VERSION,
} from "../src/contracts";
import { Worker } from "../src/pipeline/worker";
import {
  DEFAULT_GENERATION_BASE_URL,
  DEFAULT_GENERATION_MODEL,
  GenerationClient,
} from "../src/providers/generation";
import { JevClient } from "../src/providers/jev";
import { type AppHandler, createApp } from "../src/server/app";
import { type Config, resolveGeneration } from "../src/server/config";
import { redactConversation, segmentConversation } from "../src/sources";
import { digest, generationFingerprint } from "../src/storage/identity";
import { Store } from "../src/storage/store";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const generationProfile: GenerationProfile = {
  protocol: "openai-compatible",
  baseUrl: DEFAULT_GENERATION_BASE_URL,
  model: DEFAULT_GENERATION_MODEL,
  authMode: "bearer",
};

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "siyuan-pipeline-"));
  const config: Config = {
    dataDir,
    port: 8787,
    hostname: "127.0.0.1",
    publicOrigin: "http://localhost:8787",
    activeGeneration: { ...generationProfile },
    generationKey: null,
    generationCredentialOrigin: new URL(DEFAULT_GENERATION_BASE_URL).origin,
    jevKey: null,
    siyuanUrl: "",
    siyuanToken: null,
    allowedOmpRoots: [],
  };
  const store = new Store(dataDir);
  // 開機凍結：新工作的生成身分由這裡決定，之後的草稿儲存不會改變它。
  store.activateGeneration(config.activeGeneration);
  const worker = new Worker(store, config);
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  cleanups.push(() => store.close());
  return { dataDir, config, store, worker };
}

function conversation(text: string): Conversation {
  return {
    schemaVersion: 1,
    source: "synthetic",
    sourceSessionId: "example",
    projectId: "test",
    startedAt: null,
    sourceLocator: null,
    warnings: [],
    messages: [
      {
        sourceMessageId: "m1",
        parentId: null,
        role: "user",
        timestamp: null,
        text,
        attachments: [],
        rawLocator: "messages/0",
        missing: ["timestamp"],
        truncated: false,
      },
    ],
  };
}

function draft(quote: string): CandidateDraft {
  return {
    kind: "decision",
    title: "重試規則",
    summary: "先查回再重試",
    bodyMarkdown: "網路逾時後先核對操作識別碼。",
    topic: "可靠寫入",
    limitations: [],
    actions: [],
    uncertainties: [],
    evidence: [{ messageId: "m1", quote }],
  };
}

const meta = { model: DEFAULT_GENERATION_MODEL, promptVersion: PROMPT_VERSION, usage: {} };
const archive: Judgment = {
  model: "synthetic-jev",
  disposition: "archive-only",
  confidence: 0.95,
  reusableValue: 0,
  sensitivity: 0,
  informationStatus: "confirmed",
  domain: "general",
  action: "create",
  answers: {},
  policyRevision: 0,
  usage: {},
};

async function ingest(store: Store, content: Conversation) {
  return store.ingest(
    {
      format: "conversation",
      content: JSON.stringify(content),
      projectId: content.projectId,
      source: content.source,
      sourceSessionId: content.sourceSessionId,
      sourceLocator: null,
    },
    content,
  );
}

test("partial extraction failure never judges or writes; retry resumes remaining source", async () => {
  const { store, worker } = setup();
  const source = conversation(`FIRST ${"a".repeat(13_000)} FINAL DECISION`);
  const { job } = await ingest(store, source);
  let extractions = 0;
  let judgments = 0;
  worker.generation.extract = async (segment) => {
    extractions += 1;
    if (extractions === 2) throw new AppError("provider_unavailable", "模型暫時無法連線。", true);
    return { candidates: [draft(segment.messages[0]?.text.slice(0, 30) ?? "FIRST")], meta };
  };
  worker.jev.judge = async () => {
    judgments += 1;
    return archive;
  };
  await worker.tick();
  expect(store.getJob(job.id).status).toBe("retry-wait");
  expect(store.getJob(job.id).extractionComplete).toBe(false);
  expect(judgments).toBe(0);
  expect(store.operations()).toEqual([]);
  const checkpoint = store.getJob(job.id).nextSegment;
  expect(checkpoint).toBe(1);
  store.saveJob({ ...store.getJob(job.id), nextAttemptAt: new Date(0).toISOString() });
  worker.generation.extract = async (segment) => {
    const text = segment.messages.map((message) => message.text).join("\n");
    expect(text).toContain("FINAL DECISION");
    return { candidates: [draft("FINAL DECISION")], meta };
  };
  await worker.tick();
  expect(store.getJob(job.id).status).toBe("review");
  expect(
    store
      .candidates(job.id)
      .some((candidate) => candidate.draft.evidence[0]?.quote === "FINAL DECISION"),
  ).toBe(true);
  expect(store.operations()).toEqual([]);
});

test("policy changed during generation cannot authorize a stale publication", async () => {
  const { store, worker } = setup();
  const { job } = await ingest(store, conversation("Confirmed rule."));
  worker.generation.extract = async () => {
    store.saveSettings({
      ...store.settings(),
      policy: { ...store.settings().policy, excludedSources: ["synthetic"] },
    });
    return { candidates: [draft("Confirmed rule.")], meta };
  };
  await worker.tick();
  expect(store.getJob(job.id).error?.code).toBe("policy_changed");
  expect(store.operations()).toEqual([]);
  expect(store.candidates(job.id)).toEqual([]);
});

test("missing cloud key preserves imported source and fails without a note", async () => {
  const { store, worker } = setup();
  const { job, import: source } = await ingest(
    store,
    conversation("A durable rule with evidence."),
  );
  await worker.tick();
  expect(store.getJob(job.id).status).toBe("failed");
  expect(store.getJob(job.id).error?.retryable).toBe(false);
  expect(store.getImport(source.id).conversation.messages[0]?.text).toBe(
    "A durable rule with evidence.",
  );
  expect(store.operations()).toEqual([]);
});

test("cross-origin actions are rejected and overview never contains server credentials", async () => {
  const { store, worker, config } = setup();
  const app = createApp(
    { ...config, generationKey: "synthetic-secret-value", jevKey: "synthetic-other-secret" },
    store,
    worker,
  );
  const response = await app(new Request("http://localhost:8787/api/overview"));
  const data = await response.text();
  expect(data).not.toContain("synthetic-secret-value");
  expect(data).not.toContain("synthetic-other-secret");
  const rejected = await app(
    new Request("http://localhost:8787/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://untrusted.example" },
      body: "{}",
    }),
  );
  expect(rejected.status).toBe(403);
  expect(store.jobs()).toEqual([]);
  const unknownSource = await app(
    new Request("http://localhost:8787/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...store.settings(),
        ompRoots: [{ path: "/etc", projectId: "test", enabled: true }],
      }),
    }),
  );
  expect(unknownSource.status).toBe(400);
  expect(store.settings().ompRoots).toEqual([]);
});

test("invalid provider output and exhausted transport retries never produce a write plan", async () => {
  for (const scenario of ["generation-json", "missing-judgment", "unavailable"] as const) {
    const { store, worker } = setup();
    const { job } = await ingest(store, conversation("Confirmed rule."));
    worker.generation.extract = async () => ({ candidates: [draft("Confirmed rule.")], meta });
    if (scenario === "missing-judgment") {
      const client = new JevClient({
        apiKey: "synthetic",
        fetch: async () => Response.json({ model: "jev-test", answers: {} }),
      });
      worker.jev.judge = client.judge.bind(client);
    } else {
      const client = new GenerationClient({
        apiKey: "synthetic",
        baseUrl: DEFAULT_GENERATION_BASE_URL,
        model: DEFAULT_GENERATION_MODEL,
        credentialOrigin: new URL(DEFAULT_GENERATION_BASE_URL).origin,
        fetch: async () =>
          scenario === "unavailable"
            ? new Response("unavailable", { status: 503 })
            : Response.json({
                model: DEFAULT_GENERATION_MODEL,
                choices: [{ message: { role: "assistant", content: "not json" } }],
              }),
      });
      worker.generation.extract = client.extract.bind(client);
    }
    for (let attempt = 0; attempt < (scenario === "unavailable" ? 4 : 1); attempt++) {
      await worker.tick();
      const current = store.getJob(job.id);
      if (current.status === "retry-wait")
        store.saveJob({ ...current, nextAttemptAt: new Date(0).toISOString() });
    }
    expect(store.getJob(job.id).status).toBe("failed");
    expect(store.getJob(job.id).attempts).toBe(scenario === "unavailable" ? 4 : 1);
    expect(store.operations()).toEqual([]);
    expect(store.getImport(job.importId).conversation.messages[0]?.text).toBe("Confirmed rule.");
  }
});

test("retry targets the selected failed run, while policy changes require explicit reprocessing", async () => {
  const { store, worker, config } = setup();
  const { job } = await ingest(store, conversation("Confirmed rule."));
  store.saveJob({ ...job, status: "failed" });
  const other = store.createJob(job.importId, true);
  const app = createApp(config, store, worker);
  const retry = () =>
    app(
      new Request(`http://localhost:8787/api/jobs/${job.id}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
  const response = await retry();
  expect(await response.json()).toEqual({ jobId: job.id });
  expect(store.getJob(other.id).attempts).toBe(0);
  store.saveJob({ ...store.getJob(job.id), status: "failed" });
  store.saveSettings({
    ...store.settings(),
    policy: { ...store.settings().policy, minConfidence: 0.9 },
  });
  expect((await retry()).status).toBe(409);
  expect(store.getJob(job.id).status).toBe("failed");
});

test("source corrections keep logical lineage while distinct drafts never silently collapse", async () => {
  const { store, worker } = setup();
  worker.jev.judge = async () => archive;
  worker.generation.extract = async (source) => ({
    candidates: [draft(source.messages[0]?.text ?? "")],
    meta,
  });
  const first = await ingest(store, conversation("Use version one."));
  await worker.tick();
  const second = await ingest(store, conversation("Use version two."));
  await worker.tick();
  expect(store.candidates(second.job.id)[0]?.logicalId).toBe(
    store.candidates(first.job.id)[0]?.logicalId,
  );
  const run = store.createJob(second.import.id, true);
  worker.generation.extract = async () => ({
    candidates: [
      draft("Use version two."),
      { ...draft("Use version two."), uncertainties: ["Not yet confirmed."] },
    ],
    meta,
  });
  await worker.tick();
  const candidates = store.candidates(run.id);
  expect(candidates.map((item) => item.draft.uncertainties).sort()).toEqual(
    [[], ["Not yet confirmed."]].sort(),
  );
  expect(candidates.every((item) => item.status === "review")).toBe(true);
  expect(store.getJob(run.id).status).toBe("review");
  expect(store.operations()).toEqual([]);
});

test("a changed extraction plan cannot resume using an incompatible segment index", async () => {
  const { store, worker } = setup();
  const { job } = await ingest(store, conversation("First region. Last region."));
  store.saveJob({ ...job, nextSegment: 1, extractionPlan: "an-earlier-segmentation-plan" });
  await worker.tick();
  expect(store.getJob(job.id).error?.code).toBe("extraction_plan_changed");
  expect(store.getJob(job.id).extractionComplete).toBe(false);
  expect(store.operations()).toEqual([]);
});

function destination() {
  return { projectId: "test", notebookId: "20260921211444-o3ikhfa", rootPath: "/Root" };
}

function savePublished(
  store: Store,
  worker: Worker,
  job: Job,
  candidateId: string,
  quote: string,
): void {
  const now = new Date().toISOString();
  const candidate: Candidate = {
    id: candidateId,
    logicalId: candidateId,
    jobId: job.id,
    importId: job.importId,
    projectId: "test",
    draft: { ...draft(quote), title: `重試規則 ${candidateId}` },
    generation: meta,
    judgment: { ...archive, disposition: "retain" },
    status: "published",
    operationId: null,
    relatedIds: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  store.saveCandidate(candidate);
  const operation = worker.writer.plan(candidate, destination(), store.getImport(job.importId));
  store.saveOperation(operation);
  store.saveOperation({
    ...operation,
    status: "verified",
    receipt: {
      markdown: operation.markdown,
      contentHash: digest(operation.markdown),
      attributes: {},
    },
  });
  store.saveCandidate({ ...candidate, operationId: operation.id, version: candidate.version + 1 });
}

function markExtractionComplete(store: Store, config: Config, job: Job): void {
  const source = store.getImport(job.importId).conversation;
  const redacted = redactConversation(source, store.settings(job.policyRevision).policy);
  if (!redacted) throw new Error("synthetic source was excluded");
  const segments = segmentConversation(redacted);
  const plan = digest(
    JSON.stringify([
      PROMPT_VERSION,
      config.activeGeneration.protocol,
      config.activeGeneration.baseUrl,
      config.activeGeneration.model,
      segments.map((segment) => digest(JSON.stringify(segment))),
    ]),
  );
  store.saveJob({
    ...job,
    nextSegment: segments.length,
    extractionComplete: true,
    extractionPlan: plan,
  });
}

test("a restart with a different generator stops a partially extracted job before any call", async () => {
  const { store, worker, config } = setup();
  const { job } = await ingest(store, conversation(`FIRST ${"a".repeat(13_000)} FINAL DECISION`));
  let extractions = 0;
  worker.generation.extract = async (segment) => {
    extractions += 1;
    if (extractions === 2) throw new AppError("provider_unavailable", "模型暫時無法連線。", true);
    return { candidates: [draft(segment.messages[0]?.text.slice(0, 30) ?? "FIRST")], meta };
  };
  await worker.tick();
  expect(store.getJob(job.id).status).toBe("retry-wait");
  expect(store.getJob(job.id).nextSegment).toBe(1);
  expect(store.candidates(job.id)).toHaveLength(1);

  // 重新啟動時生效設定換了模型：開機凍結的指紋與這件舊工作的身分不符。
  const switched: Config = {
    ...config,
    activeGeneration: { ...generationProfile, model: "another-model" },
  };
  const restarted = new Worker(store, switched);
  store.activateGeneration(switched.activeGeneration);
  let called = false;
  restarted.generation.extract = async () => {
    called = true;
    throw new AppError("unexpected_resume", "換供應商後不應續用舊進度。", false);
  };
  restarted.start();
  await restarted.stop();

  const stopped = store.getJob(job.id);
  expect(stopped.status).toBe("failed");
  expect(stopped.error?.code).toBe("generation_config_changed");
  expect(stopped.error?.retryable).toBe(false);
  // 停止不是重做：既有分段進度與已抽取的候選都原樣保留。
  expect(stopped.nextSegment).toBe(1);
  expect(stopped.extractionComplete).toBe(false);
  expect(store.candidates(job.id)).toHaveLength(1);
  expect(called).toBe(false);
  expect(store.operations()).toEqual([]);
});

test("a completed extraction cannot resume judging under a different generator", async () => {
  const { store, worker, config } = setup();
  const { job } = await ingest(store, conversation("Confirmed rule."));
  savePublished(store, worker, job, "candidate", "Confirmed rule.");
  markExtractionComplete(store, config, job);
  const resumed = new Worker(store, {
    ...config,
    activeGeneration: { ...generationProfile, model: "another-model" },
  });
  let called = false;
  resumed.jev.judge = async () => {
    called = true;
    throw new Error("a switched generator must not reach Jev");
  };

  await resumed.tick();
  expect(store.getJob(job.id).error?.code).toBe("generation_config_changed");
  expect(called).toBe(false);
  expect(store.getCandidate("candidate").status).toBe("published");
  const operationId = store.getCandidate("candidate").operationId;
  expect(operationId && store.getOperation(operationId).status).toBe("verified");
});

/**
 * 生成供應商設定的邊界：草稿與生效值分離、指紋釘在工作上、舊工作不因重啟被換供應商。
 * 這些測試都走真正的路由與開機解析，不用假的 DTO。
 */
describe("生成供應商設定：草稿、生效與工作身分", () => {
  const localProfile: GenerationProfile = {
    protocol: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    model: "llama3.2",
    authMode: "none",
  };
  const appRequest = (path: string) =>
    new Request(`http://localhost:8787${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  const putProfile = (app: AppHandler, body: unknown) =>
    app(
      new Request("http://localhost:8787/api/generation-profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  test("儲存草稿不改變生效設定、Jev 政策版本或新工作的生成身分", async () => {
    const { store, worker, config } = setup();
    const app = createApp(config, store, worker);
    const active = store.activeGenerationFingerprint();
    const policyRevision = store.settings().revision;

    const response = await putProfile(app, { revision: 0, profile: localProfile });
    expect(response.status).toBe(200);
    const status = await response.json();
    expect(status).toEqual({
      active: generationProfile,
      staged: localProfile,
      revision: 1,
      pendingRestart: true,
      credentialConfigured: false,
    });
    // 草稿有自己的版本鏈：一般設定（含 Jev 政策）與生效的生成身分都不變。
    expect(store.settings().revision).toBe(policyRevision);
    expect(store.activeGenerationFingerprint()).toBe(active);
    // 概覽同時帶出生效與草稿，面板才有東西可顯示。
    const overview = await (await app(new Request("http://localhost:8787/api/overview"))).json();
    expect(overview.generationProfile).toEqual(status);
    expect(overview.providers.generationModel).toBe(generationProfile.model);
    // 憑據只在伺服器端：設定檔有值時，回應仍然只有存在性。
    const secured = createApp(
      { ...config, generationKey: "synthetic-generation-secret" },
      store,
      worker,
    );
    const text = await (await secured(new Request("http://localhost:8787/api/overview"))).text();
    expect(text).not.toContain("synthetic-generation-secret");
    expect(JSON.parse(text).generationProfile.credentialConfigured).toBe(true);

    // 儲存之後建立的工作仍釘住執行中的生成身分，worker 也照舊處理它。
    const { job } = await ingest(store, conversation("Staged provider change."));
    expect(job.generationFingerprint).toBe(active);
    worker.generation.extract = async () => ({
      candidates: [draft("Staged provider change.")],
      meta,
    });
    worker.jev.judge = async () => archive;
    await worker.tick();
    expect(store.candidates(job.id)).toHaveLength(1);
    expect(store.getJob(job.id).status).toBe("archive-only");
    expect(store.getJob(job.id).error).toBeNull();
  });

  test("工作正在抽取時仍可儲存待生效設定，既有與新工作仍釘住啟動身分", async () => {
    const { store, worker, config } = setup();
    const app = createApp(config, store, worker);
    const initial = store.activeGenerationFingerprint();
    const { job } = await ingest(store, conversation("Active job keeps its generator."));
    let entered!: () => void;
    const extracting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume!: () => void;
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    worker.generation.extract = async () => {
      entered();
      await held;
      return { candidates: [], meta };
    };
    const running = worker.tick();
    await extracting;
    try {
      expect(worker.activeJobId).toBe(job.id);
      const response = await putProfile(app, { revision: 0, profile: localProfile });
      expect(response.status).toBe(200);
      expect((await response.json()).pendingRestart).toBe(true);
      expect(store.activeGenerationFingerprint()).toBe(initial);
      expect(store.getJob(job.id).generationFingerprint).toBe(initial);
      const { job: next } = await ingest(
        store,
        conversation("Next job keeps the startup generator."),
      );
      expect(next.generationFingerprint).toBe(initial);
    } finally {
      resume();
      await running;
    }
    expect(store.getJob(job.id).error).toBeNull();
  });

  test("無驗證模式可運作但不冒稱已設定憑據", async () => {
    const { store, config } = setup();
    const localConfig = { ...config, activeGeneration: localProfile, generationKey: null };
    store.activateGeneration(localProfile);
    const app = createApp(localConfig, store, new Worker(store, localConfig));
    const overview = await (await app(new Request("http://localhost:8787/api/overview"))).json();
    expect(overview.generationProfile.credentialConfigured).toBe(false);
    expect(overview.providers.generationConfigured).toBe(true);
  });

  test("過期 revision 與不合法的選擇都不會寫入草稿", async () => {
    const { store, worker, config } = setup();
    const app = createApp(config, store, worker);
    expect((await putProfile(app, { revision: 0, profile: localProfile })).status).toBe(200);

    const stale = await putProfile(app, {
      revision: 0,
      profile: { ...localProfile, model: "other" },
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("revision_conflict");

    // 非 loopback 的無驗證端點、內嵌憑據的網址與不支援的協定都不會被寫入。
    const remoteNoAuth = await putProfile(app, {
      revision: 1,
      profile: { ...localProfile, baseUrl: "http://10.0.0.5:11434" },
    });
    expect(remoteNoAuth.status).toBe(400);
    const embeddedCredential = await putProfile(app, {
      revision: 1,
      profile: { ...localProfile, baseUrl: "http://user:secret@127.0.0.1:11434" },
    });
    expect(embeddedCredential.status).toBe(400);
    expect(await embeddedCredential.text()).not.toContain("user:secret");
    for (const authMode of ["none", "bearer"] as const) {
      for (const suffix of ["?", "#"]) {
        const emptyDelimiter = await putProfile(app, {
          revision: 1,
          profile: { ...localProfile, authMode, baseUrl: `${localProfile.baseUrl}${suffix}` },
        });
        expect(emptyDelimiter.status).toBe(400);
        expect((await emptyDelimiter.json()).error.code).toBe("invalid_generation_profile");
      }
    }
    const unsupported = await putProfile(app, {
      revision: 1,
      profile: { ...localProfile, protocol: "anthropic" },
    });
    expect(unsupported.status).toBe(400);
    expect(store.stagedGeneration()).toEqual({ profile: localProfile, revision: 1 });
  });

  test("尚未開始的舊工作在重啟後停止，重試被拒，只有重新處理會建立新執行", async () => {
    const { store, config } = setup();
    const { job } = await ingest(store, conversation("Queued under the old generator."));
    expect(job.generationFingerprint).toBe(generationFingerprint(generationProfile));

    // 重啟：草稿成為新的生效設定（native Ollama、無驗證）。
    const switched: Config = { ...config, activeGeneration: localProfile };
    const restarted = new Worker(store, switched);
    store.activateGeneration(switched.activeGeneration);
    restarted.start();
    await restarted.stop();

    const stopped = store.getJob(job.id);
    expect(stopped.status).toBe("failed");
    expect(stopped.error?.code).toBe("generation_config_changed");
    expect(stopped.error?.retryable).toBe(false);
    // 從未開始抽取：沒有候選、沒有發布，也沒有送出任何外部請求。
    expect(stopped.nextSegment).toBe(0);
    expect(stopped.extractionComplete).toBe(false);
    expect(store.candidates(job.id)).toEqual([]);
    expect(store.operations()).toEqual([]);

    const app = createApp(switched, store, restarted);
    const retry = await app(appRequest(`/api/jobs/${job.id}/retry`));
    expect(retry.status).toBe(409);
    expect((await retry.json()).error.code).toBe("generation_config_changed");
    expect(store.getJob(job.id).status).toBe("failed");

    const reprocess = await app(appRequest(`/api/jobs/${job.id}/reprocess`));
    expect(reprocess.status).toBe(200);
    const { jobId } = await reprocess.json();
    const fresh = store.getJob(jobId);
    expect(fresh.id).not.toBe(job.id);
    expect(fresh.run).toBe(1);
    expect(fresh.status).toBe("queued");
    expect(fresh.generationFingerprint).toBe(generationFingerprint(localProfile));
    // 舊執行不被搬去新供應商，只是停在那裡等人工決定。
    expect(store.getJob(job.id).status).toBe("failed");
    expect(store.getJob(job.id).generationFingerprint).toBe(
      generationFingerprint(generationProfile),
    );
  });

  test("開機解析：草稿優先、無驗證模式不帶憑據、來源不符則拒絕啟動", () => {
    const { config } = setup();
    const env: Config = { ...config, generationKey: "synthetic-generation-key" };
    const origin = new URL(DEFAULT_GENERATION_BASE_URL).origin;

    // 沒有草稿：完全沿用環境設定。
    expect(resolveGeneration(env, null)).toMatchObject({
      activeGeneration: generationProfile,
      generationKey: "synthetic-generation-key",
      generationCredentialOrigin: origin,
    });
    // 同一來源的草稿：生效值改成草稿，環境憑據照用。
    const sameOrigin: GenerationProfile = { ...generationProfile, model: "another-model" };
    expect(resolveGeneration(env, sameOrigin).activeGeneration).toEqual(sameOrigin);
    // 切到別的來源卻沒有明示綁定：拒絕啟動，憑據不可能跟到別的來源。
    const otherOrigin: GenerationProfile = {
      protocol: "openai-compatible",
      baseUrl: "https://generation.example/v1",
      model: "another-model",
      authMode: "bearer",
    };
    expect(() => resolveGeneration(env, otherOrigin)).toThrow(AppError);
    // 明示綁定到新來源之後才生效。
    const bound = resolveGeneration(
      { ...env, generationCredentialOrigin: "https://generation.example" },
      otherOrigin,
    );
    expect(bound.activeGeneration).toEqual(otherOrigin);
    expect(bound.generationKey).toBe("synthetic-generation-key");
    // 無驗證模式不帶憑據，也不需要來源綁定。
    const local = resolveGeneration(env, localProfile);
    expect(local.generationKey).toBeNull();
    expect(local.activeGeneration).toEqual(localProfile);
    // 不合法或不在允許清單的草稿：拒絕啟動，不會退回上一個供應商。
    expect(() =>
      resolveGeneration(env, { ...localProfile, baseUrl: "http://10.0.0.5:11434" }),
    ).toThrow(AppError);
  });
});
