import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppError,
  type CandidateDraft,
  type Conversation,
  emptyMental,
  GENERATION_MODEL,
  type Judgment,
  PROMPT_VERSION,
} from "../src/contracts";
import { Worker } from "../src/pipeline/worker";
import { JevClient } from "../src/providers/jev";
import { OllamaClient } from "../src/providers/ollama";
import { createApp } from "../src/server/app";
import type { Config } from "../src/server/config";
import { Store } from "../src/storage/store";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "siyuan-pipeline-"));
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
  };
  const store = new Store(dataDir);
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

const meta = { model: GENERATION_MODEL, promptVersion: PROMPT_VERSION, usage: {} };
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
  worker.ollama.extract = async (segment) => {
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
  worker.ollama.extract = async (segment) => {
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
  worker.ollama.extract = async () => {
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
    { ...config, ollamaKey: "synthetic-secret-value", jevKey: "synthetic-other-secret" },
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

test("manual mental context is not overwritten by a generated update", async () => {
  const { store, worker } = setup();
  const { job } = await ingest(store, conversation("Confirmed rule."));
  const now = new Date().toISOString();
  store.saveMental(
    {
      id: "manual-card",
      projectId: "test",
      revision: 1,
      baseRevision: 0,
      content: {
        ...emptyMental(),
        constraints: [{ text: "Keep my manual constraint.", sources: ["candidate"] }],
      },
      author: "human",
      status: "active",
      candidateId: null,
      generation: null,
      createdAt: now,
    },
    0,
  );
  store.saveCandidate({
    id: "candidate",
    logicalId: "logical",
    jobId: job.id,
    importId: job.importId,
    projectId: "test",
    draft: draft("Confirmed rule."),
    generation: meta,
    judgment: { ...archive, disposition: "retain" },
    status: "published",
    operationId: null,
    relatedIds: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  store.saveJob({ ...job, extractionComplete: true });
  worker.ollama.proposeMental = async () => ({
    content: { ...emptyMental(), decisions: [{ text: "New decision", sources: ["candidate"] }] },
    meta,
  });
  await worker.tick();
  expect(store.activeMental("test")?.content.constraints[0]?.text).toBe(
    "Keep my manual constraint.",
  );
  const proposal = store.mentalCards("test").find((card) => card.status === "proposal");
  expect(proposal?.baseRevision).toBe(1);
  expect(proposal?.content.decisions[0]?.sources).toEqual(["candidate"]);
});

test("generated cards cannot silently change an existing claim's category and evidence", async () => {
  const { store, worker } = setup();
  const { job } = await ingest(store, conversation("Confirmed rule."));
  const now = new Date().toISOString();
  for (const candidateId of ["earlier", "later"]) {
    store.saveCandidate({
      id: candidateId,
      logicalId: candidateId,
      jobId: job.id,
      importId: job.importId,
      projectId: "test",
      draft: draft("Confirmed rule."),
      generation: meta,
      judgment: { ...archive, disposition: "retain" },
      status: "published",
      operationId: null,
      relatedIds: [],
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  }
  store.saveMental(
    {
      id: "prior-model",
      projectId: "test",
      revision: 1,
      baseRevision: 0,
      content: { ...emptyMental(), goals: [{ text: "Stable claim", sources: ["earlier"] }] },
      author: "model",
      status: "active",
      candidateId: "earlier",
      generation: meta,
      createdAt: now,
    },
    0,
  );
  store.saveJob({ ...job, extractionComplete: true });
  worker.ollama.proposeMental = async () => ({
    content: { ...emptyMental(), constraints: [{ text: "Stable claim", sources: ["later"] }] },
    meta,
  });
  await worker.tick();
  expect(store.activeMental("test")?.content.goals[0]?.sources).toEqual(["earlier"]);
  expect(store.mentalCards("test").find((card) => card.candidateId === "later")?.status).toBe(
    "proposal",
  );
});

test("invalid provider output and exhausted transport retries never produce a write plan", async () => {
  for (const scenario of ["generation-json", "missing-judgment", "unavailable"] as const) {
    const { store, worker } = setup();
    const { job } = await ingest(store, conversation("Confirmed rule."));
    worker.ollama.extract = async () => ({ candidates: [draft("Confirmed rule.")], meta });
    if (scenario === "missing-judgment") {
      const client = new JevClient({
        apiKey: "synthetic",
        fetch: async () => Response.json({ model: "jev-test", answers: {} }),
      });
      worker.jev.judge = client.judge.bind(client);
    } else {
      const client = new OllamaClient({
        apiKey: "synthetic",
        fetch: async () =>
          scenario === "unavailable"
            ? new Response("unavailable", { status: 503 })
            : Response.json({
                model: GENERATION_MODEL,
                done: true,
                message: { role: "assistant", content: "not json" },
              }),
      });
      worker.ollama.extract = client.extract.bind(client);
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
  worker.ollama.extract = async (source) => ({
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
  worker.ollama.extract = async () => ({
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
