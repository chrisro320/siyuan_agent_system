import { z } from "zod";
import {
  AppError,
  type CandidateDraft,
  type Judgment,
  judgmentSchema,
  type MentalContent,
  type Policy,
  type RelatedNote,
  type SourceMessage,
} from "../contracts/index.ts";
import {
  assertWithinRequestLimit,
  type FetchLike,
  type ProviderClientOptions,
  parseContract,
  postJson,
  readUsage,
  requireApiKey,
} from "./support.ts";

const TYPESAFE_ORIGIN = "https://api.typesafe.ai";
const TYPESAFE_URL = `${TYPESAFE_ORIGIN}/v1/systemone`;
/** TypeSafe's flagship alias. The response reports the concrete model actually used. */
const JEV_MODEL = "jev-latest";

export type JevClientOptions = ProviderClientOptions;
export const JEV_QUESTION_IDS = {
  disposition: "disposition",
  reusableValue: "reusable_value",
  sensitivity: "sensitivity_concern",
  informationStatus: "information_status",
  domain: "domain",
  action: "note_action",
} as const;

const DISPOSITION_KEYS = ["retain", "archive-only", "review"] as const;
const STATUS_KEYS = ["confirmed", "uncertain", "conflicting"] as const;
const DOMAIN_KEYS = ["engineering", "project", "general", "unknown"] as const;
const ACTION_KEYS = ["create", "append", "duplicate", "review"] as const;

/** Level index equals the reported value, so legend keys are the stringified indices. */
const VALUE_LEGEND = [
  "沒有重用價值：只是閒聊、禮貌回應、一次性狀態回報或臨時資訊。",
  "中等價值：有可重用的做法、結構或取捨，但範圍侷限、細節不足或需要補充。",
  "高價值：可直接重用的結論、決策或做法，含明確適用範圍與依據。",
] as const;

/** Probability distributions are provider floats, so exact equality is not required. */
const DISTRIBUTION_TOLERANCE = 1e-6;
const WEIGHTED_AVERAGE_TOLERANCE = 0.03;

/**
 * Answer shapes come from the documented TypeSafe response contract. Every field
 * the mapping relies on is required, so a missing or mistyped field fails closed
 * instead of silently defaulting to a retainable answer.
 */
const answerSchemas = {
  noul: z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
  choice: z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number().min(0).max(1),
  }),
  score: z.object({
    type: z.literal("score"),
    score: z.number(),
    legend: z.record(z.string(), z.string()),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number().min(0).max(1),
  }),
} as const;

const systemOneResponseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), z.unknown()),
  usage: z.record(z.string(), z.unknown()),
});

/**
 * Parses one Choice answer and checks it against the option set this client
 * asked for: every option present exactly once, probabilities summing to one,
 * and the reported choice being the distribution's own argmax.
 */
function parseChoice(
  answers: Record<string, unknown>,
  questionId: string,
  keys: readonly string[],
): { choice: string; probabilities: Record<string, number>; confidence: number } {
  const answer = parseContract(
    answerSchemas.choice,
    answers[questionId],
    `判斷題 ${questionId} 的答案`,
    "malformed_answer",
  );
  if (!keys.includes(answer.choice)) {
    throw new AppError(
      "invalid_choice",
      `TypeSafe Jev 對 ${questionId} 給出不在選項內的答案，已停止後續步驟。`,
      false,
      502,
    );
  }
  if (!sameKeys(Object.keys(answer.probabilities), keys) || !sumsToOne(answer.probabilities)) {
    throw new AppError(
      "invalid_probabilities",
      `TypeSafe Jev 對 ${questionId} 的機率分布不完整或總和不為 1，已停止後續步驟。`,
      false,
      502,
    );
  }
  let best = "";
  let bestValue = -Infinity;
  for (const [key, value] of Object.entries(answer.probabilities)) {
    if (value > bestValue) {
      best = key;
      bestValue = value;
    }
  }
  if (best !== answer.choice) {
    throw new AppError(
      "inconsistent_answer",
      `TypeSafe Jev 對 ${questionId} 的選項與機率分布不一致，已停止後續步驟。`,
      false,
      502,
    );
  }
  return answer;
}

function sumsToOne(probabilities: Record<string, number>): boolean {
  let total = 0;
  for (const value of Object.values(probabilities)) {
    if (!Number.isFinite(value) || value < 0 || value > 1) return false;
    total += value;
  }
  return Math.abs(total - 1) <= DISTRIBUTION_TOLERANCE;
}

function sameKeys(keys: string[], expected: readonly string[]): boolean {
  if (keys.length !== expected.length) return false;
  return expected.every((key) => keys.includes(key));
}

/**
 * TypeSafe System One client. Jev is the retention authority: a candidate is
 * only promotable on a complete, internally consistent answer set, and the
 * configured policy can still downgrade a retain verdict to review.
 */
export class JevClient {
  readonly #apiKey: string | null;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number | undefined;
  readonly #onUsage: ProviderClientOptions["onUsage"];

  constructor(options: JevClientOptions) {
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs;
    this.#onUsage = options.onUsage;
  }

  async judge(
    draft: CandidateDraft,
    messages: SourceMessage[],
    mental: MentalContent,
    related: RelatedNote[],
    policy: Policy,
    policyRevision: number,
  ): Promise<Judgment> {
    const apiKey = requireApiKey(this.#apiKey, "TypeSafe Jev");

    if (messages.length === 0) {
      throw new AppError(
        "missing_evidence",
        "判斷缺少原始訊息，無法驗證引用，已停止後續步驟。",
        false,
        400,
      );
    }
    const knownMessages = new Map(messages.map((message) => [message.sourceMessageId, message]));
    const evidence: Array<{ messageId: string; role: string; quote: string }> = [];
    for (const reference of draft.evidence) {
      const message = knownMessages.get(reference.messageId);
      if (!message || !message.text.includes(reference.quote)) {
        throw new AppError(
          "invalid_evidence",
          "候選引用無法對應提供的原始訊息，已阻止判斷與後續寫入。",
          false,
          400,
        );
      }
      evidence.push({ messageId: reference.messageId, role: message.role, quote: reference.quote });
    }

    const questions = {
      [JEV_QUESTION_IDS.disposition]: {
        type: "choice",
        instructions: [
          "這個候選是否值得長期保留，並可自動發布到知識庫？",
          "`candidate` 僅是候選的摘要；只有 `evidence` 中逐字引用 `cited_messages` 的部分才算證據。",
          "evidence 未涵蓋的內容一律視為沒有依據；`related_notes` 與 `prior_mental` 只用來判斷重複、矛盾與既有決策。",
          "遵守 `policy` 的額外指示。",
        ].join("\n"),
        criteria: {
          retain: "原始證據直接支持候選內容、內容可重用，且不涉及憑據、私密個資或本地絕對路徑。",
          "archive-only":
            "有原始依據但缺乏重用價值，例如閒聊、一次性狀態、已被取代或範圍不明的內容。",
          review: "證據不足、證據互相衝突、疑似敏感、或無法判斷是否可重用；需要人工確認。",
        },
      },
      [JEV_QUESTION_IDS.reusableValue]: {
        type: "score",
        instructions:
          "若往後遇到相同問題，這個候選的內容有多容易被直接重用？依 `criteria` 的三個等級評分。",
        criteria: [...VALUE_LEGEND],
      },
      [JEV_QUESTION_IDS.sensitivity]: {
        type: "noul",
        instructions:
          "`candidate` 或 `evidence` 是否含有憑據、金鑰、私密個資、客戶資料或內部主機路徑等不應長期保存於知識庫的內容？",
        criteria: {
          true: "含有上述任一類敏感內容，或可能因此造成外洩風險。",
          false: "只有一般的技術與專案內容，沒有敏感資訊。",
        },
      },
      [JEV_QUESTION_IDS.informationStatus]: {
        type: "choice",
        instructions:
          "`candidate` 的主張本身是已確認、仍不確定，或與 `related_notes` 或 `prior_mental` 的說法互相衝突？",
        criteria: {
          confirmed:
            "`cited_messages` 明確支持，且在 `related_notes` 或 `prior_mental` 中沒有相反說法。",
          uncertain: "證據不足、屬於推測、或缺少關鍵細節。",
          conflicting: "與 `related_notes`、`prior_mental` 或 evidence 內其他說法互相矛盾。",
        },
      },
      [JEV_QUESTION_IDS.domain]: {
        type: "choice",
        instructions: "`candidate` 的主要領域是什麼？無法判斷時選 unknown。",
        criteria: {
          engineering: "程式、系統、工具或技術實作。",
          project: "特定專案的決策、狀態或流程。",
          general: "不屬於特定專案或技術實作的一般知識。",
          unknown: "無法判斷或不屬於以上任一類。",
        },
      },
      [JEV_QUESTION_IDS.action]: {
        type: "choice",
        instructions: [
          "若這個候選要發布，最適合的動作是什麼？",
          "只有在 `related_notes` 確實含有同一主題、且由本系統擁有的既有筆記時，才可選 append 或 duplicate。",
          "`related_notes` 為空時一律選擇 create 或 review。",
        ].join("\n"),
        criteria: {
          create: "應建立新的筆記。",
          append: "應附加到 `related_notes` 中同一主題且由本系統擁有的既有筆記。",
          duplicate: "內容與 `related_notes` 中的既有筆記重複，不需要新增。",
          review: "現有資訊不足以決定發布動作，需要人工確認。",
        },
      },
    };

    // Jev sees the quoted originals for the evidence the candidate actually
    // cites, plus the decidable context. The whole conversation is not sent: it
    // can be megabytes, and material the candidate does not rest on is noise.
    const citedMessageIds: string[] = [];
    for (const reference of draft.evidence) {
      if (!citedMessageIds.includes(reference.messageId)) citedMessageIds.push(reference.messageId);
    }
    const citedMessages = citedMessageIds.map((messageId) => {
      const message = knownMessages.get(messageId) as SourceMessage;
      const ranges = draft.evidence
        .filter((reference) => reference.messageId === messageId)
        .map((reference) => {
          const start = message.text.indexOf(reference.quote);
          return {
            start: Math.max(0, start - 400),
            end: Math.min(message.text.length, start + reference.quote.length + 400),
          };
        })
        .sort((left, right) => left.start - right.start);
      const merged: Array<{ start: number; end: number }> = [];
      for (const range of ranges) {
        const last = merged.at(-1);
        if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
        else merged.push({ ...range });
      }
      return {
        messageId,
        role: message.role,
        timestamp: message.timestamp,
        originalLength: message.text.length,
        excerpts: merged.map((range) => ({
          ...range,
          text: message.text.slice(range.start, range.end),
        })),
        excerpted:
          merged.reduce((total, range) => total + range.end - range.start, 0) < message.text.length,
        truncated: message.truncated,
      };
    });
    const body = JSON.stringify({
      model: JEV_MODEL,
      state: {
        candidate: draft,
        evidence,
        cited_messages: citedMessages,
        prior_mental: mental,
        related_notes: related,
        policy: policy,
      },
      questions,
    });
    assertWithinRequestLimit(body, "TypeSafe Jev");

    const response = parseContract(
      systemOneResponseSchema,
      await postJson({
        url: TYPESAFE_URL,
        allowedOrigin: TYPESAFE_ORIGIN,
        apiKey,
        body,
        fetchImpl: this.#fetch,
        providerLabel: "TypeSafe Jev",
        timeoutMs: this.#timeoutMs,
      }),
      "TypeSafe Jev 回應",
    );
    this.#onUsage?.({
      model: response.model,
      policyRevision,
      usage: readUsage(response.usage, ["input_tokens", "output_tokens"]),
    });

    const answers = response.answers;
    // Presence and declared type are checked for every expected question before
    // any value is used, so a truncated or partially-typed answer set can never
    // fall through to a default verdict.
    const expectedTypes: ReadonlyArray<readonly [string, "choice" | "score" | "noul"]> = [
      [JEV_QUESTION_IDS.disposition, "choice"],
      [JEV_QUESTION_IDS.reusableValue, "score"],
      [JEV_QUESTION_IDS.sensitivity, "noul"],
      [JEV_QUESTION_IDS.informationStatus, "choice"],
      [JEV_QUESTION_IDS.domain, "choice"],
      [JEV_QUESTION_IDS.action, "choice"],
    ];
    for (const [questionId, expectedType] of expectedTypes) {
      const declared = (answers[questionId] as { type?: unknown } | undefined)?.type;
      if (declared !== expectedType) {
        throw new AppError(
          "missing_answer",
          `TypeSafe Jev 未回覆預期的判斷題 ${questionId}，已停止後續步驟。`,
          false,
          502,
        );
      }
    }

    const dispositionAnswer = parseChoice(answers, JEV_QUESTION_IDS.disposition, DISPOSITION_KEYS);
    const statusAnswer = parseChoice(answers, JEV_QUESTION_IDS.informationStatus, STATUS_KEYS);
    const domainAnswer = parseChoice(answers, JEV_QUESTION_IDS.domain, DOMAIN_KEYS);
    const actionAnswer = parseChoice(answers, JEV_QUESTION_IDS.action, ACTION_KEYS);
    const valueAnswer = parseContract(
      answerSchemas.score,
      answers[JEV_QUESTION_IDS.reusableValue],
      `判斷題 ${JEV_QUESTION_IDS.reusableValue} 的答案`,
      "malformed_answer",
    );
    const sensitivityAnswer = parseContract(
      answerSchemas.noul,
      answers[JEV_QUESTION_IDS.sensitivity],
      `判斷題 ${JEV_QUESTION_IDS.sensitivity} 的答案`,
      "malformed_answer",
    );

    const levelKeys = VALUE_LEGEND.map((_, index) => String(index));
    if (
      !sameKeys(Object.keys(valueAnswer.probabilities), levelKeys) ||
      !sumsToOne(valueAnswer.probabilities)
    ) {
      throw new AppError(
        "invalid_probabilities",
        "TypeSafe Jev 的價值評分分布不完整或總和不為 1，已停止後續步驟。",
        false,
        502,
      );
    }
    if (!levelKeys.every((key) => valueAnswer.legend[key] === VALUE_LEGEND[Number(key)])) {
      throw new AppError(
        "invalid_legend",
        "TypeSafe Jev 回傳的評分等級說明與請求不符，已停止後續步驟。",
        false,
        502,
      );
    }
    let weighted = 0;
    for (const key of levelKeys) weighted += Number(key) * (valueAnswer.probabilities[key] ?? 0);
    if (
      valueAnswer.score < 0 ||
      valueAnswer.score > VALUE_LEGEND.length - 1 ||
      Math.abs(valueAnswer.score - weighted) > WEIGHTED_AVERAGE_TOLERANCE
    ) {
      throw new AppError(
        "inconsistent_score",
        "TypeSafe Jev 的價值評分與其機率分布不一致，已停止後續步驟。",
        false,
        502,
      );
    }

    // Policy is applied by this gate, not by the model: unsafe, unresolved, or
    // low-confidence verdicts can only move toward review, never toward retention.
    let disposition: Judgment["disposition"] = dispositionAnswer.choice as Judgment["disposition"];
    let action: Judgment["action"] = actionAnswer.choice as Judgment["action"];
    const forcedToReview =
      dispositionAnswer.confidence < policy.minConfidence ||
      valueAnswer.score < policy.minValue ||
      sensitivityAnswer.noul > policy.maxSensitivity ||
      statusAnswer.choice !== "confirmed" ||
      domainAnswer.choice === "unknown";
    if (forcedToReview && disposition === "retain") disposition = "review";
    // Appending or de-duplicating needs an existing owned note to target.
    if ((action === "append" || action === "duplicate") && !related.some((note) => note.owned)) {
      action = "review";
    }
    // A candidate that is not retained cannot carry a publication recommendation.
    if (disposition !== "retain") action = "review";
    if (action === "review" && disposition === "retain") disposition = "review";

    // The final object handed to callers is itself contract-checked, so a
    // missing or mistyped field cannot travel further down the pipeline.
    return parseContract(
      judgmentSchema,
      {
        model: response.model,
        disposition,
        confidence: dispositionAnswer.confidence,
        reusableValue: valueAnswer.score,
        sensitivity: sensitivityAnswer.noul,
        informationStatus: statusAnswer.choice,
        domain: domainAnswer.choice,
        action,
        answers,
        policyRevision: policyRevision,
        usage: readUsage(response.usage, ["input_tokens", "output_tokens"]),
      },
      "判斷結果",
    );
  }
}
