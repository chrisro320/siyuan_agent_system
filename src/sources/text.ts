import type { Conversation } from "../contracts/index.ts";
import { ConversationBuilder, ROLE_ALIASES } from "./conversation-builder.ts";
import { isoOrNull } from "./helpers.ts";

/**
 * 候選的發言標記樣式，順序即優先序：
 * 1. `[時間] 角色：內容`（時間可解析時採用，否則記警告）
 * 2. `[角色] 內容`（方括號單獨標記角色）
 * 3. `角色：內容`
 */
const TURN_PATTERNS: readonly RegExp[] = [
  /^\[([^\]]{1,64})\]\s+([A-Za-z][A-Za-z0-9 _-]{0,40}?)\s*[:：]\s?/,
  /^\[([A-Za-z][A-Za-z0-9 _-]{0,40}?)\]\s*[:：]?\s?/,
  /^([A-Za-z][A-Za-z0-9 _-]{0,40}?)\s*[:：]\s?/,
];

interface TextTurn {
  label: string | null;
  timestamp: string | null;
  lines: string[];
  /** 第一行在原始輸入中的行號（1 起算），用於可回溯的 rawLocator。 */
  startLine: number;
}

/**
 * 解析無結構的 Markdown／純文字。
 *
 * 貼上的內容不是本服務能控制的格式，因此只做保守的結構推斷：
 * - 只有整行就是角色標記時才切換發言者；程式碼圍籬內一律不判讀。
 * - 時間只在能表示成契約要求的含時區 ISO 字串時才採用；否則保留原文並記警告，
 *   不補造時區，也不使用當下時間。
 * - 完全沒有角色標記時整份視為單則 `unknown` 訊息，不假裝它是對話。
 * - 無法對應到契約角色的標記保留成 `unknown` 並在 `missing` 標記。
 */
export function parseText(request: {
  content: string;
  sourceLocator: string | null;
  projectId: string;
  source: string;
  sourceSessionId?: string | undefined;
}): Conversation {
  const lines = request.content.split(/\r?\n/);
  const turns: TextTurn[] = [];
  const unknownLabels = new Set<string>();
  const unusableTime = new Set<string>();
  let fence: string | null = null;
  let current: TextTurn | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1]?.charAt(0) ?? null;
      if (fence === null) fence = marker;
      else if (marker === fence) fence = null;
    }

    let label: string | null = null;
    let rest = line;
    let timestamp: string | null = null;
    let unused: string | null = null;
    if (fence === null && fenceMatch === null) {
      for (const [patternIndex, pattern] of TURN_PATTERNS.entries()) {
        const match = pattern.exec(line);
        if (match === null) continue;
        const candidate = patternIndex === 0 ? match[2] : match[1];
        if (candidate === undefined) continue;
        const lower = candidate.toLowerCase();
        if (ROLE_ALIASES[lower] === undefined) continue;
        label = candidate;
        rest = line.slice(match[0].length);
        if (patternIndex === 0) {
          const bracket = match[1] ?? "";
          timestamp = isoOrNull(bracket);
          if (timestamp === null && /^\d{4}-\d{2}-\d{2}/.test(bracket)) {
            // 時間無法採用時整行保留原樣，字元不得因為解析失敗而消失。
            unused = bracket;
            rest = line;
          }
        }
        break;
      }
    }

    if (label !== null) {
      if (unused !== null) unusableTime.add(unused);
      if (ROLE_ALIASES[label.toLowerCase()] === "unknown") unknownLabels.add(label);
      current = { label, timestamp, lines: [rest], startLine: index + 1 };
      turns.push(current);
      continue;
    }
    if (current === null) {
      // 發言開始前的空行只是排版，不是一則訊息。
      if (line.trim().length === 0) continue;
      current = { label: null, timestamp: null, lines: [line], startLine: index + 1 };
      turns.push(current);
      continue;
    }
    current.lines.push(line);
  }

  const fallback = request.sourceLocator ?? "文字輸入";
  const builder = ConversationBuilder.create(
    {
      format: "text",
      content: request.content,
      projectId: request.projectId,
      source: request.source,
      sourceSessionId: request.sourceSessionId,
      sourceLocator: request.sourceLocator,
    },
    [request.content],
    // 純文字是使用者主動提供、完全沒有來源自稱的身分：以匯入設定為準，
    // 沒有設定時才退回內容雜湊並警告那無法追蹤版本。
    { preferDeclared: false },
  );

  if (turns.length === 1 && turns[0]?.label === null) {
    builder.warn(
      "這段文字沒有任何角色標記，已整份視為一則 unknown 角色的訊息；未推測發言者或時間。",
    );
  }
  for (const [index, turn] of turns.entries()) {
    const lastLine = turn.startLine + turn.lines.length - 1;
    builder.add({
      rawId: null,
      role: turn.label,
      timestamp: turn.timestamp,
      // 純文字沒有分支結構，來源確實沒有上層資訊。
      parentId: undefined,
      text: turn.lines.join("\n"),
      rawLocator: `${fallback} 行 ${turn.startLine}-${lastLine}·段落 ${index + 1}`,
      fallbackId: `${fallback.replace(/\s+/g, "")}#${index + 1}`,
      missing: turn.label === null ? ["role"] : [],
    });
    if (builder.isFull) break;
  }
  if (unknownLabels.size > 0) {
    builder.warn(
      `來源含無法對應到對話角色的標記（${[...unknownLabels].join("、")}），已保留為 unknown，未猜測其角色。`,
    );
  }
  if (unusableTime.size > 0) {
    builder.warn(
      `來源的時間字串缺少時區資訊（${[...unusableTime].join("、")}），未寫入 timestamp 也未補造時區，原字串仍保留在訊息文字中。`,
    );
  }
  builder.finalize();
  return builder.finish(null);
}
