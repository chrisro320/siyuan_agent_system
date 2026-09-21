import type { Conversation, SourceMessage } from "../contracts/index.ts";

/** 送給生成模型的單段文字預算；超過時必須分段，不得靜默丟棄尾端內容。 */
export const DEFAULT_SEGMENT_CHARS = 12_000;

interface Unit {
  message: SourceMessage;
  /** 非 null 表示這是超長訊息被切出的一片。 */
  fragment: { index: number; total: number } | null;
}

/**
 * 把超長訊息切成數片，這是最後手段：只有一則訊息本身就超過整段預算時才用。
 *
 * 每一片保留同一個 `sourceMessageId` 與 `rawLocator`，因此證據錨點不變；片內
 * 標記 `truncated`，因為它確實不是完整訊息。原始對話物件不受影響，呼叫端仍
 * 保有真正的來源截斷狀態。所有片接回來必須等於原字串，任何字元都不得遺失。
 */
function toUnits(messages: readonly SourceMessage[], limit: number): Unit[] {
  const units: Unit[] = [];
  for (const message of messages) {
    if (message.text.length <= limit) {
      units.push({ message, fragment: null });
      continue;
    }
    const total = Math.ceil(message.text.length / limit);
    let index = 1;
    for (let offset = 0; offset < message.text.length; offset += limit) {
      units.push({
        message: { ...message, text: message.text.slice(offset, offset + limit), truncated: true },
        fragment: { index, total },
      });
      index += 1;
    }
  }
  return units;
}

/**
 * 把一份對話切成多個可獨立處理的段落。
 *
 * 規則：
 * - 以「整則訊息」為切點。除非單則訊息本身超過 `maxChars`（見 `toUnits`），
 *   否則絕不切斷訊息文字，決策與引文因此不會被腰斬，每一段的訊息文字接回來
 *   就是原對話內容。
 * - 第一段以外的段落，開頭會重複上一段的最後一則訊息作為相鄰上下文；同一則
 *   訊息因此可能出現在相鄰兩段，這是刻意的 overlap。同一段內不會有重複的
 *   識別碼。
 * - 段內順序與原對話一致，尾端訊息一定落在最後一段，最後的決策不會消失。
 * - 不新增、不改寫任何時間欄位；`startedAt` 與每則訊息的 `timestamp` 原樣保留，
 *   絕不填入當下時間。
 * - 回傳新物件；原始 `conversation` 與其訊息不會被修改。
 */
export function segmentConversation(
  conversation: Conversation,
  maxChars: number = DEFAULT_SEGMENT_CHARS,
): Conversation[] {
  const limit =
    Number.isFinite(maxChars) && maxChars >= 1 ? Math.floor(maxChars) : DEFAULT_SEGMENT_CHARS;
  const units = toUnits(conversation.messages, limit);

  const groups: Unit[][] = [];
  let current: Unit[] = [];
  let used = 0;
  for (const unit of units) {
    if (current.length > 0 && used + unit.message.text.length > limit) {
      groups.push(current);
      current = [];
      used = 0;
    }
    current.push(unit);
    used += unit.message.text.length;
  }
  if (current.length > 0) groups.push(current);

  const total = groups.length;
  return groups.map((group, index) => {
    const warnings = [...conversation.warnings];
    for (const unit of group) {
      if (unit.fragment === null) continue;
      warnings.push(
        `訊息「${unit.message.sourceMessageId}」超過單段上限，已切成 ${unit.fragment.total} 片；各片共用同一個 sourceMessageId 與 rawLocator，本片是第 ${unit.fragment.index} 片。`,
      );
    }
    const previous = index > 0 ? groups[index - 1] : undefined;
    const tail = previous?.[previous.length - 1];
    let messages = group.map((unit) => ({ ...unit.message }));
    if (tail !== undefined) {
      const size = messages.reduce((sum, message) => sum + message.text.length, 0);
      const tailCopy = { ...tail.message };
      const duplicated = messages.some(
        (message) => message.sourceMessageId === tailCopy.sourceMessageId,
      );
      if (!duplicated && size + tailCopy.text.length <= limit) {
        messages = [tailCopy, ...messages];
        warnings.push(
          `本段開頭重複上一段的最後一則訊息「${tailCopy.sourceMessageId}」作為相鄰上下文；同一則訊息出現在相鄰兩段屬於刻意的 overlap。`,
        );
      }
    }
    if (total > 1) {
      warnings.push(
        `本段是「${conversation.sourceSessionId}」的第 ${index + 1}/${total} 段；分段只反映輸入長度限制，不代表原文在此結束。`,
      );
    }
    return { ...conversation, messages, warnings };
  });
}
