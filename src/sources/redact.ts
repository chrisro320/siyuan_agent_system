import type { Conversation, Policy } from "../contracts/index.ts";
import { createRedactor, orderMissing } from "./helpers.ts";

/**
 * 依政策裁決這段來源是否可以送給生成模型。
 *
 * - `source` 列在 `policy.excludedSources` 時回傳 `null`：這是最後一道來源層
 *   權限，與模型輸出無關，不可由模型或內容自行解除。
 * - `policy.redactedTerms` 以字面（literal）取代，不做模糊比對。
 * - 另外針對常見形式做**最小**本地遮蔽：`Bearer` 標頭、`key = value` 形式的
 *   憑證指派、PEM 私鑰區塊。這些是樣式比對，**不是**通用 DLP：無法辨識的
 *   自由文字秘密仍會通過，因此呼叫端不得把它當成完整保證，也不能因為經過遮蔽
 *   就放寬其他邊界。
 * - 被改寫的訊息會加上 `missing: ["redacted"]` 標記並在 `warnings` 說明，
 *   讓下游知道「送出的文字與原件不同」。
 * - 回傳新物件；已保存的原文（`conversation` 及其訊息）不會被修改，
 *   重新讀取仍得到完整原始內容。模型與證據驗證都應使用回傳值的文字：
 *   引文若只存在於被遮蔽的片段中，就不該被當成可引用證據。
 *
 * 已知限制：`source`、`sourceSessionId`、`projectId`、`sourceLocator` 與
 * `rawLocator` 是可回溯的身分欄位，為維持證據與去重識別而不遮蔽；若這些欄位
 * 本身含有秘密，需由來源設定層避免寫入。
 */
export function redactConversation(
  conversation: Conversation,
  policy: Policy,
): Conversation | null {
  if (policy.excludedSources.includes(conversation.source)) return null;

  const redact = createRedactor(policy.redactedTerms);
  const warnings = [...conversation.warnings];
  let alteredText = 0;
  let alteredLocator = 0;

  const messages = conversation.messages.map((message) => {
    const text = redact(message.text);
    const attachments = message.attachments.map((attachment) => ({
      ...attachment,
      locator: redact(attachment.locator),
    }));
    const textChanged = text !== message.text;
    const locatorChanged = attachments.some(
      (attachment, index) => attachment.locator !== message.attachments[index]?.locator,
    );
    if (!textChanged && !locatorChanged) return message;
    if (textChanged) alteredText += 1;
    if (locatorChanged) alteredLocator += 1;
    return {
      ...message,
      text,
      attachments,
      missing: orderMissing([...message.missing, "redacted"]),
    };
  });

  if (alteredText > 0 || alteredLocator > 0) {
    warnings.push(
      `送出雲端前已在本地遮蔽 ${alteredText} 則訊息的文字與 ${alteredLocator} 則訊息的附件位置；政策字詞為字面取代，其餘為 Bearer 標頭、憑證指派與私鑰區塊的樣式比對。`,
    );
    warnings.push(
      "此遮蔽只涵蓋已知樣式，不是通用 DLP：自由文字中無法辨識的秘密仍可能送出，請勿據此放寬來源範圍。",
    );
    warnings.push(
      "被改寫的訊息已標記缺少 redacted 欄位；引用驗證應使用遮蔽後的文字，只存在於被遮蔽片段的引文不得當成證據。",
    );
  }

  return { ...conversation, messages, warnings };
}
