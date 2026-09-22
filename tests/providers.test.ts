import { describe, expect, test } from "bun:test";
import {
  AppError,
  type CandidateDraft,
  type Conversation,
  defaultSettings,
  GENERATION_MODEL,
  type SourceMessage,
} from "../src/contracts/index.ts";
import { JEV_QUESTION_IDS, JevClient } from "../src/providers/jev.ts";
import { OllamaClient } from "../src/providers/ollama.ts";

/**
 * Synthetic HTTP fixtures only. These tests prove the clients' verification and
 * failure behavior; they make no claim about the real providers' availability
 * or output quality.
 */

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

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

function ollamaChatResponse(content: string, model = GENERATION_MODEL): Response {
  return jsonResponse({
    model,
    message: { role: "assistant", content },
    done: true,
    prompt_eval_count: 120,
    eval_count: 80,
  });
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

describe("OllamaClient.extract", () => {
  test("ignores message.thinking and only trusts final content", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({
        model: GENERATION_MODEL,
        message: {
          role: "assistant",
          thinking: JSON.stringify({ candidates: [] }),
          content: JSON.stringify(validDraftPayload),
        },
        done: true,
      }),
    );
    const client = new OllamaClient({ apiKey: "test-key", fetch });

    const result = await client.extract(conversation);

    expect(result.candidates).toHaveLength(1);
  });

  test("rejects unfinished or substituted model responses before using valid-looking JSON", async () => {
    for (const override of [{ done: false }, { done_reason: "length" }, { model: "other-model" }]) {
      const { fetch } = recordingFetch(() =>
        jsonResponse({
          model: GENERATION_MODEL,
          done: true,
          message: { role: "assistant", content: JSON.stringify(validDraftPayload) },
          ...override,
        }),
      );
      await expect(
        new OllamaClient({ apiKey: "test-key", fetch }).extract(conversation),
      ).rejects.toBeInstanceOf(AppError);
    }
  });

  test("accepts one surrounding code fence but not a partial JSON document", async () => {
    const fenced = recordingFetch(() =>
      ollamaChatResponse(`\`\`\`json\n${JSON.stringify(validDraftPayload)}\n\`\`\``),
    );
    const fencedClient = new OllamaClient({ apiKey: "test-key", fetch: fenced.fetch });
    expect((await fencedClient.extract(conversation)).candidates).toHaveLength(1);

    const partial = recordingFetch(() => ollamaChatResponse('{"candidates":[{"kind":"decision"'));
    const partialClient = new OllamaClient({ apiKey: "test-key", fetch: partial.fetch });
    await expect(partialClient.extract(conversation)).rejects.toMatchObject({
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
    const { fetch, calls } = recordingFetch(() => ollamaChatResponse(JSON.stringify(fabricated)));
    const client = new OllamaClient({ apiKey: "test-key", fetch });

    await expect(client.extract(conversation)).rejects.toMatchObject({
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
        ? ollamaChatResponse(JSON.stringify(validDraftPayload))
        : ollamaChatResponse(JSON.stringify(fabricated)),
    );
    const client = new OllamaClient({ apiKey: "test-key", fetch });

    const result = await client.extract(conversation);

    expect(result.candidates[0]?.evidence[0]?.quote).toBe(EVIDENCE_TEXT);
    expect(calls).toHaveLength(2);
  });

  test("repairs malformed output once, then fails closed when repair also fails", async () => {
    const repaired = recordingFetch((call) =>
      call.body.messages && JSON.stringify(call.body.messages).includes("修正要求")
        ? ollamaChatResponse(JSON.stringify(validDraftPayload))
        : ollamaChatResponse("這不是 JSON"),
    );
    const repairedClient = new OllamaClient({ apiKey: "test-key", fetch: repaired.fetch });

    const result = await repairedClient.extract(conversation);

    expect(result.candidates).toHaveLength(1);
    expect(repaired.calls).toHaveLength(2);
    expect(result.meta.usage).toEqual({ prompt_eval_count: 240, eval_count: 160 });

    const hopeless = recordingFetch(() => ollamaChatResponse("仍然不是 JSON"));
    const hopelessClient = new OllamaClient({ apiKey: "test-key", fetch: hopeless.fetch });
    await expect(hopelessClient.extract(conversation)).rejects.toMatchObject({
      code: "repair_exhausted",
    });
    expect(hopeless.calls).toHaveLength(2);
  });

  test("fails closed without a credential and never calls the provider", async () => {
    const { fetch, calls } = recordingFetch(() => ollamaChatResponse("{}"));
    const client = new OllamaClient({ apiKey: null, fetch });

    await expect(client.extract(conversation)).rejects.toMatchObject({
      code: "provider_not_configured",
      retryable: false,
    });
    expect(calls).toHaveLength(0);
  });

  test("reports an oversized request instead of silently truncating it", async () => {
    const { fetch, calls } = recordingFetch(() => ollamaChatResponse("{}"));
    const client = new OllamaClient({ apiKey: "test-key", fetch });
    const huge: Conversation = {
      ...conversation,
      messages: [sourceMessage("msg-1", "x".repeat(1_200_000))],
    };

    await expect(client.extract(huge)).rejects.toMatchObject({
      code: "input_too_large",
    });
    expect(calls).toHaveLength(0);
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
    const client = new OllamaClient({ apiKey: "test-key", fetch: hanging, timeoutMs: 20 });

    await expect(client.extract(conversation)).rejects.toMatchObject({
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
    const client = new OllamaClient({ apiKey: "test-key", fetch: streaming, timeoutMs: 20 });
    await expect(client.extract(conversation)).rejects.toMatchObject({
      code: "provider_timeout",
      retryable: true,
    });
  });

  test("available usage survives failed repairs and invalid judgment answers", async () => {
    const usage: Array<Record<string, number>> = [];
    const invalid = recordingFetch(() => ollamaChatResponse("not json"));
    const ollama = new OllamaClient({
      apiKey: "test-key",
      fetch: invalid.fetch,
      onUsage: (meta) => usage.push(meta.usage),
    });
    await expect(ollama.extract(conversation)).rejects.toMatchObject({
      code: "repair_exhausted",
    });
    expect(usage.reduce((sum, item) => sum + (item.eval_count ?? 0), 0)).toBe(160);
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
