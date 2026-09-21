import { AppError, type Conversation, type SourceMessage } from "../contracts/index.ts";
import { collectAttachments, extractText } from "./content.ts";
import { ConversationBuilder, ROLE_ALIASES } from "./conversation-builder.ts";
import { asJsonObject, asRawLocator, firstString, isoOrNull } from "./helpers.ts";

export interface ConversationParseOptions {
  content: string;
  source: string;
  projectId: string;
  sourceSessionId?: string | undefined;
  sourceLocator: string | null;
}

/**
 * 解析「對話 JSON」格式。
 *
 * 這是本服務唯一要求結構的來源格式，但仍容忍缺欄位：缺少 `role`／`timestamp`／
 * `parentId`／`rawLocator`／`attachments`／`missing`／`truncated`／`warnings`／
 * `startedAt`／`sourceLocator` 時一律補成 `null` 或 `unknown` 並在 `missing`
 * 標記，**不推測**任何歷史內容。
 *
 * 控制欄位以匯入設定為準：`source`、`projectId`（以及 `sourceSessionId`、
 * `sourceLocator`）取自請求，不採用檔案內容。理由是匯入的原文是資料，不是指令；
 * 原文自稱的來源不得改變實際的來源命名空間與專案歸屬。不一致只會留下警告。
 */
export function parseConversation(options: ConversationParseOptions): Conversation {
  let root: unknown;
  try {
    root = JSON.parse(options.content);
  } catch {
    throw new AppError("invalid_conversation", "對話 JSON 無法解析，請確認檔案是完整的 JSON。");
  }

  const envelope = asJsonObject(root);
  const rawMessages = envelope === null ? (Array.isArray(root) ? root : null) : envelope.messages;
  if (!Array.isArray(rawMessages)) {
    throw new AppError(
      "invalid_conversation",
      "對話 JSON 缺少 messages 陣列，無法判定有哪些訊息。",
    );
  }
  if (rawMessages.length === 0) {
    throw new AppError("invalid_conversation", "對話 JSON 的 messages 是空的，沒有可匯入的內容。");
  }

  const declaredSessionId =
    envelope === null ? null : firstString(envelope.sourceSessionId, envelope.sessionId);
  const builder = ConversationBuilder.create(
    {
      format: "conversation",
      content: options.content,
      projectId: options.projectId,
      source: options.source,
      sourceSessionId: options.sourceSessionId,
      sourceLocator: options.sourceLocator,
    },
    [options.content],
    // 手動匯入的原文是資料，不是指令：檔案自稱的 session 只在匯入設定沒有提供時採用。
    { declaredSessionId, preferDeclared: false },
  );

  const declaredSource = envelope === null ? null : firstString(envelope.source);
  if (declaredSource !== null && declaredSource !== options.source) {
    builder.warn(
      `來源檔自稱 source 為「${declaredSource}」，與匯入設定的「${options.source}」不同；已採用匯入設定，原文內容不作為設定來源。`,
    );
  }
  const declaredProject = envelope === null ? null : firstString(envelope.projectId);
  if (declaredProject !== null && declaredProject !== options.projectId) {
    builder.warn(
      `來源檔自稱 projectId 為「${declaredProject}」，與匯入設定的「${options.projectId}」不同；已採用匯入設定。`,
    );
  }
  if (
    envelope !== null &&
    envelope.startedAt !== undefined &&
    isoOrNull(envelope.startedAt) === null
  ) {
    builder.warn("來源檔的 startedAt 不是含時區的 ISO 時間，已留空並標記；未以當下時間代替。");
  }
  if (envelope !== null && envelope.sourceLocator != null) {
    builder.warn(
      options.sourceLocator === null
        ? "來源檔自帶 sourceLocator；未設定伺服器可見路徑時仍以匯入設定的 null 為準。"
        : "來源檔自帶 sourceLocator，已以匯入設定提供的伺服器可見路徑為準。",
    );
  }

  const declaredWarnings = envelope === null ? null : envelope.warnings;
  if (Array.isArray(declaredWarnings)) {
    for (const warning of declaredWarnings) {
      if (typeof warning === "string" && warning.trim().length > 0) builder.warn(warning.trim());
    }
  }

  const fallbackPrefix = options.sourceLocator ?? "對話 JSON";
  let generatedLocators = 0;
  let unknownRoles = 0;
  let missingTimes = 0;

  for (const [index, rawMessage] of rawMessages.entries()) {
    const entry = asJsonObject(rawMessage);
    if (entry === null) {
      builder.warn(`第 ${index + 1} 則訊息不是物件，已略過；未推測其內容。`);
      continue;
    }
    const declaredId = firstString(entry.sourceMessageId, entry.id, entry.uuid);
    const fallbackId = `${fallbackPrefix}#訊息${index + 1}`;
    const rawText = entry.text ?? entry.content;
    const extracted = typeof rawText === "string" ? null : extractText(rawText);
    const attachments: SourceMessage["attachments"] = [];
    collectAttachments(entry.attachments, attachments);
    if (extracted !== null) {
      for (const attachment of extracted.attachments) attachments.push(attachment);
      for (const kind of extracted.omitted) {
        builder.warn(`第 ${index + 1} 則訊息含${kind}，未轉發該內容，只保留附件位置與狀態。`);
      }
    }

    const roleText = typeof entry.role === "string" ? entry.role.trim().toLowerCase() : "";
    if (roleText.length === 0) unknownRoles += 1;
    else if (ROLE_ALIASES[roleText] === undefined) {
      builder.warn(
        `第 ${index + 1} 則訊息的角色「${entry.role as string}」無法對應契約角色，已保留為 unknown。`,
      );
    }
    if (isoOrNull(entry.timestamp) === null) missingTimes += 1;

    const declaredMissing = Array.isArray(entry.missing)
      ? entry.missing.filter((field): field is string => typeof field === "string")
      : [];
    const rawLocator = firstString(entry.rawLocator);
    if (rawLocator === null) generatedLocators += 1;

    // 缺少欄位與「來源明確表示沒有」在契約上必須可分辨：這裡逐欄記錄來源是否
    // 真的提供了資訊。合法的空附件清單或 `truncated: false` 不算缺漏。
    if (declaredId === null) declaredMissing.push("sourceMessageId");
    if (!Array.isArray(entry.attachments)) declaredMissing.push("attachments");
    const declaredTruncated = typeof entry.truncated === "boolean" ? entry.truncated : null;
    if (declaredTruncated === null) declaredMissing.push("truncated");

    const text = typeof rawText === "string" ? rawText : (extracted?.text ?? "");
    builder.add({
      rawId: declaredId,
      role: roleText,
      timestamp: entry.timestamp,
      parentId: "parentId" in entry ? entry.parentId : undefined,
      text,
      attachments,
      rawLocator: asRawLocator(rawLocator ?? `${fallbackId} 位置`, fallbackId),
      fallbackId,
      missing: declaredMissing,
      truncated: declaredTruncated === true,
    });
    if (builder.isFull) break;
  }

  builder.finalize();

  if (generatedLocators > 0) {
    builder.warn(
      `有 ${generatedLocators} 則訊息沒有 rawLocator，已用位置資訊代替；原始位置無法從這份檔案還原。`,
    );
  }
  if (unknownRoles > 0) {
    builder.warn(`有 ${unknownRoles} 則訊息缺少 role，已保留為 unknown 並標記 missing。`);
  }
  if (missingTimes > 0) {
    builder.warn(
      `有 ${missingTimes} 則訊息缺少可採用的時間戳，已留空並標記 missing；未以當下時間代替。`,
    );
  }

  const startedAt = envelope === null ? null : envelope.startedAt;
  const result = builder.finish(startedAt);
  if (result.messages.length === 0) {
    throw new AppError("invalid_conversation", "對話 JSON 沒有可匯入的訊息物件。");
  }
  return result;
}
