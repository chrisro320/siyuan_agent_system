import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppError,
  type CandidateDraft,
  type Conversation,
  defaultSettings,
  type SourceMessage,
} from "../src/contracts/index.ts";
import {
  DEFAULT_GENERATION_BASE_URL,
  DEFAULT_GENERATION_MODEL,
  GenerationClient,
} from "../src/providers/generation.ts";
import { JEV_QUESTION_IDS, JevClient } from "../src/providers/jev.ts";
import { loadConfig } from "../src/server/config.ts";

/**
 * Synthetic HTTP fixtures only. These tests prove the clients' verification and
 * failure behavior; they make no claim about the real providers' availability
 * or output quality.
 */

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

/** Synthetic generation endpoint. Only configuration selects the real one. */
const GENERATION_URL = "https://generation.example/v1";
const GENERATION_MODEL = DEFAULT_GENERATION_MODEL;
/** The one origin the synthetic credential is bound to; it never follows another URL. */
const GENERATION_ORIGIN = new URL(GENERATION_URL).origin;

interface RecordedCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recordingFetch(responder: (call: RecordedCall) => Response | Promise<Response>): {
  fetch: typeof globalThis.fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const call = { url, init: init ?? {}, body };
    calls.push(call);
    return responder(call);
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

function sourceMessage(sourceMessageId: string, text: string): SourceMessage {
  return {
    sourceMessageId,
    parentId: null,
    role: "user",
    timestamp: null,
    text,
    attachments: [],
    rawLocator: `omp://synthetic/${sourceMessageId}`,
    missing: [],
    truncated: false,
  };
}

const EVIDENCE_TEXT = "我們決定正式環境一律使用 PostgreSQL 16，並停用 SQLite 作為正式資料庫。";

const conversation: Conversation = {
  schemaVersion: 1,
  source: "synthetic",
  sourceSessionId: "session-1",
  projectId: "project-1",
  startedAt: null,
  sourceLocator: null,
  messages: [
    sourceMessage("msg-1", "先確認一下正式環境的資料庫要用哪一套？"),
    sourceMessage("msg-2", EVIDENCE_TEXT),
  ],
  warnings: [],
};

const validDraftPayload = {
  candidates: [
    {
      kind: "decision",
      title: "正式環境統一使用 PostgreSQL 16",
      summary: "團隊決定正式環境資料庫一律採用 PostgreSQL 16。",
      bodyMarkdown: "正式環境統一使用 PostgreSQL 16。",
      topic: "資料庫",
      limitations: ["本次未討論版本升級流程。"],
      actions: [],
      uncertainties: [],
      evidence: [{ messageId: "msg-2", quote: EVIDENCE_TEXT }],
    },
  ],
};

/** A complete OpenAI-compatible chat completion, overridable per test. */
function chatPayload(
  content: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    model: GENERATION_MODEL,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
    ...overrides,
  };
}

function chatResponse(
  content: string,
  model = GENERATION_MODEL,
  finishReason: string | null = "stop",
): Response {
  return jsonResponse({
    model,
    choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", content } }],
    usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
  });
}

/** Synthetic native Ollama endpoint. Only configuration selects the real one. */
const OLLAMA_URL = "https://ollama.example";
const OLLAMA_ORIGIN = new URL(OLLAMA_URL).origin;
const OLLAMA_MODEL = "qwen3:8b";

/** A local endpoint: plain HTTP on the loopback interface, where no-auth is allowed. */
const LOCAL_URL = "http://127.0.0.1:11434";

/** A complete native `/api/chat` (`stream:false`) answer, overridable per test. */
function ollamaResponse(content: string, overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    model: OLLAMA_MODEL,
    created_at: "2026-09-23T00:00:00.000000000Z",
    done: true,
    done_reason: "stop",
    message: { role: "assistant", content },
    total_duration: 8_000_000,
    prompt_eval_count: 42,
    eval_count: 17,
    ...overrides,
  });
}

/** What a loopback server actually received on the wire. */
interface RecordedWireRequest {
  path: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

/** A running loopback server the client can be pointed at. */
interface LoopbackServer {
  readonly baseUrl: string;
  readonly received: RecordedWireRequest[];
  /** Releases the port; every test must call this in a `finally`. */
  readonly stop: () => Promise<void>;
}

/**
 * A real loopback HTTP server that records what the client actually puts on the
 * wire. The mocked transport proves the client's decisions; this proves they
 * survive a real request, including the transport's own header handling.
 */
function loopbackServer(payload: Record<string, unknown>): LoopbackServer {
  const received: RecordedWireRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      received.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        body: (await request.json()) as Record<string, unknown>,
      });
      return Response.json(payload);
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    received,
    stop: () => server.stop(true),
  };
}

/** The client under test, pointed at the synthetic endpoint unless overridden. */
function generationClient(
  fetch: typeof globalThis.fetch,
  overrides: Partial<{
    protocol: string;
    authMode: string;
    apiKey: string | null;
    credentialOrigin: string | null;
    baseUrl: string;
    model: string;
    timeoutMs: number;
  }> = {},
): GenerationClient {
  return new GenerationClient({
    apiKey: "test-key",
    credentialOrigin: GENERATION_ORIGIN,
    baseUrl: GENERATION_URL,
    model: GENERATION_MODEL,
    fetch,
    ...overrides,
  });
}

/**
 * A configuration the client must refuse is refused by the constructor, before
 * any request exists; this turns that refusal into a value to assert on.
 */
function configurationError(build: () => unknown): AppError {
  try {
    build();
  } catch (cause) {
    return cause as AppError;
  }
  throw new Error("expected the configured client to be refused");
}

function draft(overrides: Partial<CandidateDraft> = {}): CandidateDraft {
  return {
    kind: "decision",
    title: "正式環境統一使用 PostgreSQL 16",
    summary: "團隊決定正式環境資料庫一律採用 PostgreSQL 16。",
    bodyMarkdown: "正式環境統一使用 PostgreSQL 16。",
    topic: "資料庫",
    limitations: [],
    actions: [],
    uncertainties: [],
    evidence: [{ messageId: "msg-2", quote: EVIDENCE_TEXT }],
    ...overrides,
  };
}

function choice(
  value: string,
  probabilities: Record<string, number>,
  confidence: number,
): Record<string, unknown> {
  return { type: "choice", choice: value, probabilities, confidence };
}

function scoreAnswer(
  score: number,
  confidence: number,
  level = Math.round(score),
): Record<string, unknown> {
  const probabilities: Record<string, number> = { "0": 0, "1": 0, "2": 0 };
  probabilities[String(level)] = 1;
  return {
    type: "score",
    score,
    legend: {
      "0": "沒有重用價值：只是閒聊、禮貌回應、一次性狀態回報或臨時資訊。",
      "1": "中等價值：有可重用的做法、結構或取捨，但範圍侷限、細節不足或需要補充。",
      "2": "高價值：可直接重用的結論、決策或做法，含明確適用範圍與依據。",
    },
    probabilities,
    confidence,
  };
}

function retainAnswers(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [JEV_QUESTION_IDS.disposition]: choice(
      "retain",
      { retain: 0.9, "archive-only": 0.05, review: 0.05 },
      0.9,
    ),
    [JEV_QUESTION_IDS.reusableValue]: scoreAnswer(2, 0.9),
    [JEV_QUESTION_IDS.sensitivity]: { type: "noul", noul: 0.02 },
    [JEV_QUESTION_IDS.informationStatus]: choice(
      "confirmed",
      { confirmed: 0.9, uncertain: 0.1, conflicting: 0 },
      0.9,
    ),
    [JEV_QUESTION_IDS.domain]: choice(
      "engineering",
      { engineering: 0.9, project: 0.05, general: 0.05, unknown: 0 },
      0.9,
    ),
    [JEV_QUESTION_IDS.action]: choice(
      "create",
      { create: 0.9, append: 0.05, duplicate: 0.05, review: 0 },
      0.9,
    ),
    ...overrides,
  };
}

function jevResponse(answers: Record<string, unknown>): Response {
  return jsonResponse({
    model: "jev-1.13.0",
    answers,
    usage: { input_tokens: 900, output_tokens: 40 },
  });
}

type JudgeArgs = Parameters<JevClient["judge"]>;

/** Positional-argument fixture for `judge`, overridable per test. */
function judgeInput(
  overrides: Partial<{
    draft: JudgeArgs[0];
    messages: JudgeArgs[1];
    related: JudgeArgs[2];
    policy: JudgeArgs[3];
    policyRevision: JudgeArgs[4];
  }> = {},
): JudgeArgs {
  return [
    overrides.draft ?? draft(),
    overrides.messages ?? conversation.messages,
    overrides.related ?? [],
    overrides.policy ?? defaultSettings().policy,
    overrides.policyRevision ?? 7,
  ];
}

describe("GenerationClient.extract", () => {
  test("ignores a non-final reasoning field and only trusts the assistant content", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({
        model: GENERATION_MODEL,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              reasoning_content: JSON.stringify({ candidates: [] }),
              content: JSON.stringify(validDraftPayload),
            },
          },
        ],
      }),
    );

    const result = await generationClient(fetch).extract(conversation);

    expect(result.candidates).toHaveLength(1);
  });

  test("sends the credential only to the configured endpoint, with redirects disabled", async () => {
    const { fetch, calls } = recordingFetch(() => chatResponse(JSON.stringify(validDraftPayload)));

    await generationClient(fetch).extract(conversation);

    const call = calls[0];
    expect(call?.url).toBe(`${GENERATION_URL}/chat/completions`);
    expect(call?.init.redirect).toBe("error");
    expect((call?.init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    expect(call?.body.model).toBe(GENERATION_MODEL);
    expect(call?.body.stream).toBe(false);
  });

  test("maps an authentication failure without leaking the credential", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: { message: "sk-live-should-never-appear" } }, 401),
    );

    const error = await generationClient(fetch)
      .extract(conversation)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("provider_unauthorized");
    expect((error as AppError).retryable).toBe(false);
    expect((error as AppError).message).not.toContain("sk-live");
  });

  test("rejects unfinished, incomplete and substituted answers before interpreting any content", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      // Still streaming, ended for another reason, missing, or without final content.
      [
        chatPayload("{}", {
          choices: [
            { index: 0, finish_reason: "length", message: { role: "assistant", content: "{}" } },
          ],
        }),
        "invalid_model_output",
      ],
      [
        chatPayload("{}", {
          choices: [
            { index: 0, finish_reason: null, message: { role: "assistant", content: "{}" } },
          ],
        }),
        "invalid_model_output",
      ],
      [chatPayload("{}", { choices: [] }), "invalid_model_output"],
      [
        chatPayload("{}", {
          choices: [
            { index: 0, finish_reason: "stop", message: { role: "assistant", content: null } },
          ],
        }),
        "invalid_model_output",
      ],
      // A substituted model is reported as itself: no repair and no fallback request.
      [
        chatPayload(JSON.stringify(validDraftPayload), { model: "substituted-model" }),
        "unexpected_model",
      ],
    ];

    for (const [payload, code] of cases) {
      const { fetch, calls } = recordingFetch(() => jsonResponse(payload));
      await expect(generationClient(fetch).extract(conversation)).rejects.toMatchObject({ code });
      // An unusable answer is never salvaged, repaired against another model, or
      // resent to a different endpoint.
      expect(calls, code).toHaveLength(1);
    }
  });

  test("records reported usage even when the final answer is incomplete", async () => {
    const reported: Record<string, number>[] = [];
    const { fetch } = recordingFetch(() => chatResponse("{}", GENERATION_MODEL, "length"));
    const client = new GenerationClient({
      apiKey: "test-key",
      credentialOrigin: GENERATION_ORIGIN,
      baseUrl: GENERATION_URL,
      model: GENERATION_MODEL,
      fetch,
      onUsage: (meta) => reported.push(meta.usage),
    });

    await expect(client.extract(conversation)).rejects.toMatchObject({
      code: "invalid_model_output",
    });
    expect(reported).toEqual([{ prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 }]);
  });

  test("accepts one surrounding code fence but not a partial JSON document", async () => {
    const fenced = recordingFetch(() =>
      chatResponse(`\`\`\`json\n${JSON.stringify(validDraftPayload)}\n\`\`\``),
    );
    expect((await generationClient(fenced.fetch).extract(conversation)).candidates).toHaveLength(1);

    const partial = recordingFetch(() => chatResponse('{"candidates":[{"kind":"decision"'));
    await expect(generationClient(partial.fetch).extract(conversation)).rejects.toMatchObject({
      code: "repair_exhausted",
    });
    // The truncated answer must never be salvaged into publishable content.
    expect(partial.calls).toHaveLength(2);
  });

  test("rejects a candidate whose quote is not present, after one failed repair", async () => {
    const fabricated = {
      candidates: [
        {
          ...validDraftPayload.candidates[0],
          evidence: [{ messageId: "msg-2", quote: "我們決定改用 MongoDB。" }],
        },
      ],
    };
    const { fetch, calls } = recordingFetch(() => chatResponse(JSON.stringify(fabricated)));

    await expect(generationClient(fetch).extract(conversation)).rejects.toMatchObject({
      code: "invalid_evidence",
    });
    // A fabricated anchor is offered one correction, then the job stops.
    expect(calls).toHaveLength(2);
  });

  test("accepts a repaired answer that replaces fabricated evidence with a real quote", async () => {
    const fabricated = {
      candidates: [
        {
          ...validDraftPayload.candidates[0],
          evidence: [{ messageId: "msg-2", quote: "我們決定改用 MongoDB。" }],
        },
      ],
    };
    const { fetch, calls } = recordingFetch((call) =>
      JSON.stringify(call.body.messages).includes("修正要求")
        ? chatResponse(JSON.stringify(validDraftPayload))
        : chatResponse(JSON.stringify(fabricated)),
    );

    const result = await generationClient(fetch).extract(conversation);

    expect(result.candidates[0]?.evidence[0]?.quote).toBe(EVIDENCE_TEXT);
    expect(calls).toHaveLength(2);
  });

  test("repairs malformed output once, then fails closed when repair also fails", async () => {
    const repaired = recordingFetch((call) =>
      call.body.messages && JSON.stringify(call.body.messages).includes("修正要求")
        ? chatResponse(JSON.stringify(validDraftPayload))
        : chatResponse("這不是 JSON"),
    );

    const result = await generationClient(repaired.fetch).extract(conversation);

    expect(result.candidates).toHaveLength(1);
    expect(repaired.calls).toHaveLength(2);
    expect(result.meta.usage).toEqual({
      prompt_tokens: 240,
      completion_tokens: 160,
      total_tokens: 400,
    });

    const hopeless = recordingFetch(() => chatResponse("仍然不是 JSON"));
    await expect(generationClient(hopeless.fetch).extract(conversation)).rejects.toMatchObject({
      code: "repair_exhausted",
    });
    expect(hopeless.calls).toHaveLength(2);
  });

  test("fails closed without a credential and never calls the provider", async () => {
    const { fetch, calls } = recordingFetch(() => chatResponse("{}"));

    await expect(
      generationClient(fetch, { apiKey: null }).extract(conversation),
    ).rejects.toMatchObject({
      code: "provider_not_configured",
      retryable: false,
    });
    expect(calls).toHaveLength(0);
  });

  test("reports an oversized request instead of silently truncating it", async () => {
    const { fetch, calls } = recordingFetch(() => chatResponse("{}"));
    const huge: Conversation = {
      ...conversation,
      messages: [sourceMessage("msg-1", "x".repeat(1_200_000))],
    };

    await expect(generationClient(fetch).extract(huge)).rejects.toMatchObject({
      code: "input_too_large",
    });
    expect(calls).toHaveLength(0);
  });

  test("rejects a malformed or credential-bearing endpoint without echoing it", async () => {
    const attempts = [
      "https://user:sk-live-endpoint-secret@generation.example/v1",
      "ftp://generation.example/v1",
      "https://generation.example/v1?token=sk-live-endpoint-secret",
    ];
    for (const baseUrl of attempts) {
      const error = (() => {
        try {
          generationClient(recordingFetch(() => chatResponse("{}")).fetch, { baseUrl });
          return null;
        } catch (cause) {
          return cause;
        }
      })();
      expect(error, baseUrl).toBeInstanceOf(AppError);
      expect((error as AppError).code, baseUrl).toBe("provider_misconfigured");
      expect((error as AppError).message, baseUrl).not.toContain("sk-live-endpoint-secret");
    }

    const emptyModel = (() => {
      try {
        generationClient(recordingFetch(() => chatResponse("{}")).fetch, { model: "  " });
        return null;
      } catch (cause) {
        return cause;
      }
    })();
    expect((emptyModel as AppError).code).toBe("provider_misconfigured");
  });
});

describe("native Ollama adapter", () => {
  /** The same client, speaking the selected native protocol to the synthetic endpoint. */
  function ollamaClient(fetch: typeof globalThis.fetch): GenerationClient {
    return generationClient(fetch, {
      protocol: "ollama",
      baseUrl: OLLAMA_URL,
      credentialOrigin: OLLAMA_ORIGIN,
      model: OLLAMA_MODEL,
    });
  }

  test("sends the configured URL, model and credential to /api/chat and reads the final answer", async () => {
    const { fetch, calls } = recordingFetch(() =>
      ollamaResponse(JSON.stringify(validDraftPayload)),
    );

    const result = await ollamaClient(fetch).extract(conversation);

    expect(result.candidates).toHaveLength(1);
    expect(result.meta.model).toBe(OLLAMA_MODEL);
    // Native counters, not the OpenAI-compatible field names.
    expect(result.meta.usage).toEqual({ prompt_eval_count: 42, eval_count: 17 });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(`${OLLAMA_URL}/api/chat`);
    expect(call?.init.redirect).toBe("error");
    expect((call?.init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    expect(call?.body.model).toBe(OLLAMA_MODEL);
    expect(call?.body.stream).toBe(false);
  });

  test("sends the same system and extraction prompts as the OpenAI-compatible adapter", async () => {
    const compatible = recordingFetch(() => chatResponse(JSON.stringify(validDraftPayload)));
    const native = recordingFetch(() => ollamaResponse(JSON.stringify(validDraftPayload)));

    await generationClient(compatible.fetch).extract(conversation);
    await ollamaClient(native.fetch).extract(conversation);

    expect(native.calls[0]?.body.messages).toEqual(compatible.calls[0]?.body.messages);
  });

  test("accepts a completed native answer that omits done_reason", async () => {
    const { fetch } = recordingFetch(() =>
      ollamaResponse(JSON.stringify(validDraftPayload), { done_reason: undefined }),
    );

    expect((await ollamaClient(fetch).extract(conversation)).candidates).toHaveLength(1);
  });

  test("rejects an unfinished, truncated or substituted native answer without a second request", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      // Still streaming, stopped for another reason, or carrying no final text.
      [{ done: false }, "invalid_model_output"],
      [{ done_reason: "length" }, "invalid_model_output"],
      [{ message: { role: "assistant", content: null } }, "invalid_model_output"],
      [{ message: undefined }, "invalid_model_output"],
      [{ model: "substituted-model" }, "unexpected_model"],
    ];

    for (const [overrides, code] of cases) {
      const { fetch, calls } = recordingFetch(() =>
        ollamaResponse(JSON.stringify(validDraftPayload), overrides),
      );
      await expect(ollamaClient(fetch).extract(conversation)).rejects.toMatchObject({ code });
      // An unusable answer is never salvaged, repaired against another model, or
      // resent to a different transport.
      expect(calls, code).toHaveLength(1);
    }
  });

  test("records native counters even when the final answer is incomplete", async () => {
    const reported: Record<string, number>[] = [];
    const { fetch } = recordingFetch(() => ollamaResponse("{}", { done: false }));
    const client = new GenerationClient({
      protocol: "ollama",
      apiKey: "test-key",
      credentialOrigin: OLLAMA_ORIGIN,
      baseUrl: OLLAMA_URL,
      model: OLLAMA_MODEL,
      fetch,
      onUsage: (meta) => reported.push(meta.usage),
    });

    await expect(client.extract(conversation)).rejects.toMatchObject({
      code: "invalid_model_output",
    });
    expect(reported).toEqual([{ prompt_eval_count: 42, eval_count: 17 }]);
  });

  test("repairs malformed native output exactly once, on the same endpoint", async () => {
    const { fetch, calls } = recordingFetch((call) =>
      JSON.stringify(call.body.messages).includes("修正要求")
        ? ollamaResponse(JSON.stringify(validDraftPayload))
        : ollamaResponse("這不是 JSON"),
    );

    const result = await ollamaClient(fetch).extract(conversation);

    expect(result.candidates).toHaveLength(1);
    expect(result.meta.usage).toEqual({ prompt_eval_count: 84, eval_count: 34 });
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.url).toBe(`${OLLAMA_URL}/api/chat`);
  });
});

describe("generation selection", () => {
  test("refuses an unsupported protocol instead of guessing a transport", () => {
    const { fetch, calls } = recordingFetch(() => chatResponse("{}"));

    const error = configurationError(() => generationClient(fetch, { protocol: "anthropic" }));

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("provider_misconfigured");
    expect(calls).toHaveLength(0);
  });

  test("refuses configuration that cannot carry the selected authentication mode safely", () => {
    const { fetch, calls } = recordingFetch(() => chatResponse("{}"));
    const cases: Array<Partial<{ authMode: string; baseUrl: string }>> = [
      // An unapproved authentication mode is never treated as authenticated.
      { authMode: "basic" },
      // Unauthenticated calls are loopback-only, and a name is not an address.
      { authMode: "none" },
      { authMode: "none", baseUrl: "http://localhost:11434" },
      { authMode: "none", baseUrl: "http://10.0.0.5:11434" },
      // A remote credential must not travel in clear text, and a name cannot be
      // pinned to a loopback interface.
      { baseUrl: "http://generation.example/v1" },
      { baseUrl: "http://localhost:7861" },
    ];

    for (const overrides of cases) {
      const error = configurationError(() => generationClient(fetch, overrides));
      expect(error.code, JSON.stringify(overrides)).toBe("provider_misconfigured");
    }
    expect(calls).toHaveLength(0);
  });

  test("rejects empty query or fragment delimiters before sending to a different path", () => {
    const { fetch, calls } = recordingFetch(() => chatResponse("{}"));
    for (const baseUrl of [`${GENERATION_URL}?`, `${GENERATION_URL}#`]) {
      const error = configurationError(() => generationClient(fetch, { baseUrl }));
      expect(error.code, baseUrl).toBe("provider_misconfigured");
    }
    for (const baseUrl of [`${LOCAL_URL}?`, `${LOCAL_URL}#`]) {
      const error = configurationError(() =>
        generationClient(fetch, { protocol: "ollama", authMode: "none", baseUrl }),
      );
      expect(error.code, baseUrl).toBe("provider_misconfigured");
    }
    expect(calls).toHaveLength(0);
  });

  test("sends no Authorization header for an explicitly unauthenticated loopback endpoint", async () => {
    // Both accepted literal forms, with an unrelated key present and absent.
    for (const baseUrl of [LOCAL_URL, "http://[::1]:11434"]) {
      for (const apiKey of ["unrelated-key", null]) {
        const { fetch, calls } = recordingFetch(() =>
          ollamaResponse(JSON.stringify(validDraftPayload)),
        );

        const result = await generationClient(fetch, {
          protocol: "ollama",
          authMode: "none",
          baseUrl,
          model: OLLAMA_MODEL,
          apiKey,
        }).extract(conversation);

        expect(result.candidates, baseUrl).toHaveLength(1);
        expect(calls[0]?.url, baseUrl).toBe(`${baseUrl}/api/chat`);
        expect(calls[0]?.init.headers).not.toHaveProperty("authorization");
        expect(JSON.stringify(calls[0]?.init.headers)).not.toContain("unrelated-key");
      }
    }
  });

  test("refuses a credential that is not bound to the configured endpoint origin", async () => {
    const { fetch, calls } = recordingFetch(() => chatResponse(JSON.stringify(validDraftPayload)));
    // No binding at all, and a binding to a different origin: neither call happens.
    for (const credentialOrigin of [null, "https://other.example"]) {
      const error = configurationError(() => generationClient(fetch, { credentialOrigin }));
      expect(error.code, String(credentialOrigin)).toBe("provider_misconfigured");
    }
    expect(calls).toHaveLength(0);

    const bound = recordingFetch(() => chatResponse(JSON.stringify(validDraftPayload)));
    const result = await generationClient(bound.fetch, {
      credentialOrigin: GENERATION_ORIGIN,
    }).extract(conversation);

    expect(result.candidates).toHaveLength(1);
    expect((bound.calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      "Bearer test-key",
    );
  });
});

describe("loopback wire smoke", () => {
  test("a native no-auth endpoint receives the protocol path and no Authorization header", async () => {
    const loopback = loopbackServer({
      model: OLLAMA_MODEL,
      done: true,
      done_reason: "stop",
      message: { role: "assistant", content: JSON.stringify(validDraftPayload) },
      prompt_eval_count: 42,
      eval_count: 17,
    });
    try {
      const result = await new GenerationClient({
        protocol: "ollama",
        authMode: "none",
        apiKey: "unrelated-key",
        baseUrl: loopback.baseUrl,
        model: OLLAMA_MODEL,
      }).extract(conversation);

      expect(result.candidates).toHaveLength(1);
      expect(loopback.received).toHaveLength(1);
      expect(loopback.received[0]?.path).toBe("/api/chat");
      expect(loopback.received[0]?.authorization).toBeNull();
      expect(loopback.received[0]?.body.model).toBe(OLLAMA_MODEL);
      expect(loopback.received[0]?.body.stream).toBe(false);
    } finally {
      await loopback.stop();
    }
  });

  test("an authenticated endpoint receives its bound credential on the configured path", async () => {
    const loopback = loopbackServer(chatPayload(JSON.stringify(validDraftPayload)));
    try {
      const result = await new GenerationClient({
        apiKey: "test-key",
        credentialOrigin: new URL(loopback.baseUrl).origin,
        baseUrl: loopback.baseUrl,
        model: GENERATION_MODEL,
      }).extract(conversation);

      expect(result.candidates).toHaveLength(1);
      expect(loopback.received).toHaveLength(1);
      expect(loopback.received[0]?.path).toBe("/chat/completions");
      expect(loopback.received[0]?.authorization).toBe("Bearer test-key");
      expect(loopback.received[0]?.body.model).toBe(GENERATION_MODEL);
    } finally {
      await loopback.stop();
    }
  });

  test("does not follow a redirect or forward a bound credential to another server", async () => {
    const redirected: Array<string | null> = [];
    const destination = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        redirected.push(request.headers.get("authorization"));
        return Response.json(chatPayload(JSON.stringify(validDraftPayload)));
      },
    });
    const original: Array<{ path: string; authorization: string | null }> = [];
    const source = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        original.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
        });
        return new Response(null, {
          status: 307,
          headers: { Location: `http://127.0.0.1:${destination.port}/stolen` },
        });
      },
    });
    try {
      const baseUrl = `http://127.0.0.1:${source.port}`;
      await expect(
        new GenerationClient({
          apiKey: "redirect-secret",
          credentialOrigin: baseUrl,
          baseUrl,
          model: GENERATION_MODEL,
        }).extract(conversation),
      ).rejects.toMatchObject({ code: "provider_unreachable" });
      expect(original).toEqual([
        { path: "/chat/completions", authorization: "Bearer redirect-secret" },
      ]);
      expect(redirected).toEqual([]);
    } finally {
      await source.stop(true);
      await destination.stop(true);
    }
  });
});

describe("generation configuration", () => {
  test("defaults to the shipped OpenAI-compatible endpoint and model", async () => {
    const config = await loadConfig({});

    expect(config.activeGeneration).toEqual({
      protocol: "openai-compatible",
      baseUrl: DEFAULT_GENERATION_BASE_URL,
      model: DEFAULT_GENERATION_MODEL,
      authMode: "bearer",
    });
    expect(config.generationKey).toBeNull();
    // The shipped endpoint is loopback, so its origin is what the key is bound to.
    expect(config.generationCredentialOrigin).toBe(new URL(DEFAULT_GENERATION_BASE_URL).origin);
  });

  test("takes the configured endpoint, model and credential", async () => {
    const config = await loadConfig({
      GENERATION_BASE_URL: "https://generation.example/v1/",
      GENERATION_MODEL: "another-model",
      GENERATION_API_KEY: "synthetic-generation-key",
    });

    expect(config.activeGeneration.baseUrl).toBe("https://generation.example/v1");
    expect(config.activeGeneration.model).toBe("another-model");
    expect(config.generationKey).toBe("synthetic-generation-key");
    expect(config.generationCredentialOrigin).toBe("https://generation.example");
  });

  test("keeps the credential binding on the endpoint origin for a local no-auth selection", async () => {
    const config = await loadConfig({
      GENERATION_PROTOCOL: "ollama",
      GENERATION_AUTH_MODE: "none",
      GENERATION_BASE_URL: LOCAL_URL,
      GENERATION_MODEL: OLLAMA_MODEL,
      GENERATION_API_KEY: "unrelated-key",
    });

    expect(config.activeGeneration).toEqual({
      protocol: "ollama",
      baseUrl: LOCAL_URL,
      model: OLLAMA_MODEL,
      authMode: "none",
    });
    // The binding always exists; an unauthenticated call simply never uses it.
    expect(config.generationCredentialOrigin).toBe(LOCAL_URL);
  });

  test("reads the credential from the configured file when no direct value is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "generation-key-"));
    const path = join(dir, "key");
    await writeFile(path, "file-secret\n");
    try {
      const config = await loadConfig({ GENERATION_API_KEY_FILE: path });
      expect(config.generationKey).toBe("file-secret");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects an unsupported endpoint without echoing the configuration", async () => {
    const error = await loadConfig({
      GENERATION_BASE_URL: "https://user:sk-live-config-secret@generation.example/v1",
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("provider_misconfigured");
    expect((error as AppError).message).not.toContain("sk-live-config-secret");
  });
});

describe("JevClient.judge", () => {
  test("maps a complete, consistent answer set onto a policy-passing retention", async () => {
    const { fetch, calls } = recordingFetch(() => jevResponse(retainAnswers()));
    const client = new JevClient({ apiKey: "test-key", fetch });

    const judgment = await client.judge(...judgeInput());

    expect(judgment.disposition).toBe("retain");
    expect(judgment.action).toBe("create");
    expect(judgment.informationStatus).toBe("confirmed");
    expect(judgment.domain).toBe("engineering");
    expect(judgment.reusableValue).toBe(2);
    expect(judgment.policyRevision).toBe(7);
    expect(judgment.model).toBe("jev-1.13.0");
    expect(judgment.usage).toEqual({ input_tokens: 900, output_tokens: 40 });
    expect(judgment.answers[JEV_QUESTION_IDS.disposition]).toBeDefined();

    const call = calls[0];
    expect(call?.url).toBe(TYPESAFE_URL);
    expect(call?.body.model).toBe("jev-latest");
    const state = call?.body.state as Record<string, unknown>;
    // Jev must see the original words, not only the generative paraphrase.
    expect(JSON.stringify(state.evidence)).toContain(EVIDENCE_TEXT);
    expect(state.related_notes).toEqual([]);
    expect((call?.init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
  });

  test("fails closed when an expected answer is missing", async () => {
    const answers = retainAnswers();
    delete answers[JEV_QUESTION_IDS.sensitivity];
    const { fetch } = recordingFetch(() => jevResponse(answers));
    const client = new JevClient({ apiKey: "test-key", fetch });

    await expect(client.judge(...judgeInput())).rejects.toMatchObject({ code: "missing_answer" });
  });

  test("fails closed when an answer declares the wrong type", async () => {
    const { fetch } = recordingFetch(() =>
      jevResponse(
        retainAnswers({ [JEV_QUESTION_IDS.sensitivity]: { type: "noul", noul: "0.02" } }),
      ),
    );
    const client = new JevClient({ apiKey: "test-key", fetch });

    await expect(client.judge(...judgeInput())).rejects.toMatchObject({ code: "malformed_answer" });
  });

  test("fails closed when an answer declares an unexpected question type", async () => {
    const answers = retainAnswers();
    answers[JEV_QUESTION_IDS.domain] = {
      type: "score",
      score: 1,
      legend: { "0": "a", "1": "b" },
      probabilities: { "0": 0, "1": 1 },
      confidence: 0.9,
    };
    const { fetch } = recordingFetch(() => jevResponse(answers));

    await expect(
      new JevClient({ apiKey: "test-key", fetch }).judge(...judgeInput()),
    ).rejects.toMatchObject({ code: "missing_answer" });
  });

  test("fails closed on a probability distribution that does not sum to one", async () => {
    const { fetch } = recordingFetch(() =>
      jevResponse(
        retainAnswers({
          [JEV_QUESTION_IDS.disposition]: choice(
            "retain",
            { retain: 0.99, "archive-only": 0.02, review: 0.009 },
            0.9,
          ),
        }),
      ),
    );
    const client = new JevClient({ apiKey: "test-key", fetch });

    await expect(client.judge(...judgeInput())).rejects.toMatchObject({
      code: "invalid_probabilities",
    });
  });

  test("fails closed on an unknown choice key and on a choice that is not the argmax", async () => {
    const unknown = recordingFetch(() =>
      jevResponse(
        retainAnswers({
          [JEV_QUESTION_IDS.domain]: choice(
            "astrology",
            { astrology: 0.9, project: 0.05, general: 0.05, unknown: 0 },
            0.9,
          ),
        }),
      ),
    );
    await expect(
      new JevClient({ apiKey: "test-key", fetch: unknown.fetch }).judge(...judgeInput()),
    ).rejects.toMatchObject({ code: "invalid_choice" });

    const notArgmax = recordingFetch(() =>
      jevResponse(
        retainAnswers({
          [JEV_QUESTION_IDS.disposition]: choice(
            "retain",
            { retain: 0.4, "archive-only": 0.5, review: 0.1 },
            0.9,
          ),
        }),
      ),
    );
    await expect(
      new JevClient({ apiKey: "test-key", fetch: notArgmax.fetch }).judge(...judgeInput()),
    ).rejects.toMatchObject({ code: "inconsistent_answer" });
  });

  test("fails closed when the score disagrees with its own distribution", async () => {
    // Score 0 while the whole distribution sits on level 2.
    const { fetch } = recordingFetch(() =>
      jevResponse(retainAnswers({ [JEV_QUESTION_IDS.reusableValue]: scoreAnswer(0, 0.9, 2) })),
    );
    const client = new JevClient({ apiKey: "test-key", fetch });

    await expect(client.judge(...judgeInput())).rejects.toMatchObject({
      code: "inconsistent_score",
    });
  });

  test("fails closed when the evidence quote cannot be resolved in the given messages", async () => {
    const { fetch, calls } = recordingFetch(() => jevResponse(retainAnswers()));
    const client = new JevClient({ apiKey: "test-key", fetch });
    const fabricated = draft({
      evidence: [{ messageId: "msg-2", quote: "我們決定改用 MongoDB。" }],
    });

    await expect(client.judge(...judgeInput({ draft: fabricated }))).rejects.toMatchObject({
      code: "invalid_evidence",
    });
    expect(calls).toHaveLength(0);
  });

  test("downgrades a retain verdict to review when policy thresholds are not met", async () => {
    const strict = defaultSettings().policy;
    const cases: Array<[string, Record<string, unknown>]> = [
      [
        "low confidence",
        retainAnswers({
          [JEV_QUESTION_IDS.disposition]: choice(
            "retain",
            { retain: 0.72, "archive-only": 0.2, review: 0.08 },
            0.72,
          ),
        }),
      ],
      [
        "value below minValue",
        retainAnswers({ [JEV_QUESTION_IDS.reusableValue]: scoreAnswer(0, 0.9, 0) }),
      ],
      [
        "sensitivity above maxSensitivity",
        retainAnswers({
          [JEV_QUESTION_IDS.sensitivity]: { type: "noul", noul: 0.4 },
        }),
      ],
      [
        "unresolved information",
        retainAnswers({
          [JEV_QUESTION_IDS.informationStatus]: choice(
            "uncertain",
            { confirmed: 0.15, uncertain: 0.75, conflicting: 0.1 },
            0.75,
          ),
        }),
      ],
      [
        "conflicting information",
        retainAnswers({
          [JEV_QUESTION_IDS.informationStatus]: choice(
            "conflicting",
            { confirmed: 0.1, uncertain: 0.2, conflicting: 0.7 },
            0.7,
          ),
        }),
      ],
      [
        "unknown domain",
        retainAnswers({
          [JEV_QUESTION_IDS.domain]: choice(
            "unknown",
            { engineering: 0.1, project: 0.1, general: 0.2, unknown: 0.6 },
            0.6,
          ),
        }),
      ],
    ];

    for (const [label, answers] of cases) {
      const { fetch } = recordingFetch(() => jevResponse(answers));
      const judgment = await new JevClient({ apiKey: "test-key", fetch }).judge(
        ...judgeInput({ policy: strict }),
      );
      expect(judgment.disposition, label).toBe("review");
      expect(judgment.action, label).toBe("review");
    }
  });

  test("never promotes an archive-only verdict that policy thresholds would otherwise allow", async () => {
    const { fetch } = recordingFetch(() =>
      jevResponse(
        retainAnswers({
          [JEV_QUESTION_IDS.disposition]: choice(
            "archive-only",
            { retain: 0.05, "archive-only": 0.9, review: 0.05 },
            0.9,
          ),
        }),
      ),
    );
    const judgment = await new JevClient({ apiKey: "test-key", fetch }).judge(...judgeInput());

    expect(judgment.disposition).toBe("archive-only");
  });

  test("cannot append or de-duplicate without a related note to target", async () => {
    const { fetch } = recordingFetch(() =>
      jevResponse(
        retainAnswers({
          [JEV_QUESTION_IDS.action]: choice(
            "append",
            { create: 0.05, append: 0.9, duplicate: 0.05, review: 0 },
            0.9,
          ),
        }),
      ),
    );
    const judgment = await new JevClient({ apiKey: "test-key", fetch }).judge(
      ...judgeInput({ related: [] }),
    );

    expect(judgment.action).toBe("review");
    expect(judgment.disposition).toBe("review");
  });

  test("a review routing answer vetoes retention even when value thresholds pass", async () => {
    const { fetch } = recordingFetch(() =>
      jevResponse(
        retainAnswers({
          [JEV_QUESTION_IDS.action]: choice(
            "review",
            { create: 0, append: 0, duplicate: 0, review: 1 },
            1,
          ),
        }),
      ),
    );
    const judgment = await new JevClient({ apiKey: "test-key", fetch }).judge(...judgeInput());
    expect(judgment.disposition).toBe("review");
  });

  test("unowned related knowledge cannot authorize an automatic duplicate skip", async () => {
    const { fetch } = recordingFetch(() =>
      jevResponse(
        retainAnswers({
          [JEV_QUESTION_IDS.action]: choice(
            "duplicate",
            { create: 0, append: 0, duplicate: 1, review: 0 },
            1,
          ),
        }),
      ),
    );
    const judgment = await new JevClient({ apiKey: "test-key", fetch }).judge(
      ...judgeInput({
        related: [
          {
            id: "human-note",
            title: "Human note",
            content: EVIDENCE_TEXT,
            projectId: "project-1",
            owned: false,
          },
        ],
      }),
    );
    expect(judgment.disposition).toBe("review");
  });

  test("long originals retain the cited tail and explicit excerpt offsets without exceeding a request", async () => {
    const { fetch, calls } = recordingFetch(() => jevResponse(retainAnswers()));
    const original = `${"prefix".repeat(180_000)}${EVIDENCE_TEXT}`;
    const judgment = await new JevClient({ apiKey: "test-key", fetch }).judge(
      draft(),
      [sourceMessage("msg-2", original)],
      [],
      defaultSettings().policy,
      0,
    );
    expect(judgment.disposition).toBe("retain");
    const body = JSON.stringify(calls[0]?.body);
    expect(body).toContain(EVIDENCE_TEXT);
    expect(body).toContain('"excerpted":true');
    expect(body.length).toBeLessThan(20_000);
  });

  test("maps provider failures onto retryable and non-retryable errors without leaking the body", async () => {
    const cases: Array<[number, string, boolean]> = [
      [401, "provider_unauthorized", false],
      [403, "provider_unauthorized", false],
      [422, "provider_rejected", false],
      [429, "provider_rate_limited", true],
      [500, "provider_unavailable", true],
      [503, "provider_unavailable", true],
    ];

    for (const [status, code, retryable] of cases) {
      const { fetch } = recordingFetch(() =>
        jsonResponse({ error: { message: "sk-live-should-never-appear" } }, status),
      );
      const client = new JevClient({ apiKey: "test-key", fetch });
      const error = await client.judge(...judgeInput()).catch((cause: unknown) => cause);
      expect(error, `status ${status}`).toBeInstanceOf(AppError);
      expect((error as AppError).code, `status ${status}`).toBe(code);
      expect((error as AppError).retryable, `status ${status}`).toBe(retryable);
      expect((error as AppError).message, `status ${status}`).not.toContain("sk-live");
    }
  });

  test("treats a network failure as retryable and an unconfigured key as fatal", async () => {
    const failing = (async () => {
      throw new TypeError("connection refused");
    }) as unknown as typeof globalThis.fetch;
    await expect(
      new JevClient({ apiKey: "test-key", fetch: failing }).judge(...judgeInput()),
    ).rejects.toMatchObject({ code: "provider_unreachable", retryable: true });

    const { fetch, calls } = recordingFetch(() => jevResponse(retainAnswers()));
    await expect(
      new JevClient({ apiKey: null, fetch }).judge(...judgeInput()),
    ).rejects.toMatchObject({ code: "provider_not_configured", retryable: false });
    expect(calls).toHaveLength(0);
  });
});

describe("provider transport", () => {
  test("reports a call that exceeds its timeout as a retryable timeout", async () => {
    // Never settles on its own; the abort signal is the only way out.
    const hanging = ((_url: unknown, init?: RequestInit) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      return promise;
    }) as unknown as typeof globalThis.fetch;

    await expect(
      generationClient(hanging, { timeoutMs: 20 }).extract(conversation),
    ).rejects.toMatchObject({
      code: "provider_timeout",
      retryable: true,
    });
  });
  test("a body timeout after response headers remains retryable", async () => {
    const streaming = ((_url: unknown, init?: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"model":'));
              init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
            },
          }),
        ),
      )) as typeof globalThis.fetch;

    await expect(
      generationClient(streaming, { timeoutMs: 20 }).extract(conversation),
    ).rejects.toMatchObject({
      code: "provider_timeout",
      retryable: true,
    });
  });

  test("available usage survives failed repairs and invalid judgment answers", async () => {
    const usage: Array<Record<string, number>> = [];
    const invalid = recordingFetch(() => chatResponse("not json"));
    const generation = new GenerationClient({
      apiKey: "test-key",
      credentialOrigin: GENERATION_ORIGIN,
      baseUrl: GENERATION_URL,
      model: GENERATION_MODEL,
      fetch: invalid.fetch,
      onUsage: (meta) => usage.push(meta.usage),
    });
    await expect(generation.extract(conversation)).rejects.toMatchObject({
      code: "repair_exhausted",
    });
    expect(usage.reduce((sum, item) => sum + (item.completion_tokens ?? 0), 0)).toBe(160);
    const incomplete = recordingFetch(() => jevResponse({}));
    const jev = new JevClient({
      apiKey: "test-key",
      fetch: incomplete.fetch,
      onUsage: (meta) => usage.push(meta.usage),
    });
    await expect(jev.judge(...judgeInput())).rejects.toMatchObject({ code: "missing_answer" });
    expect(usage.at(-1)?.input_tokens).toBe(900);
  });
});
