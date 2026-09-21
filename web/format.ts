// 顯示層文字與色調對應。所有未知值都有明確 fallback，避免後端新增枚舉值時前端靜默顯示空白。

import type { JobStatus } from "../src/contracts";
import type { Tone } from "./dom";

export interface Described {
  label: string;
  tone: Tone;
}

const TIME_FORMATTER = new Intl.DateTimeFormat("zh-TW", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export function formatTime(value: string | null): string {
  if (value === null) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return TIME_FORMATTER.format(date);
}

export function formatRelative(value: string | null): string {
  if (value === null) return "—";
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return value;
  const seconds = Math.round((Date.now() - time) / 1000);
  const magnitude = Math.abs(seconds);
  const suffix = seconds >= 0 ? "前" : "後";
  if (magnitude < 60) return `${magnitude} 秒${suffix}`;
  if (magnitude < 3600) return `${Math.round(magnitude / 60)} 分${suffix}`;
  if (magnitude < 86400) return `${Math.round(magnitude / 3600)} 小時${suffix}`;
  return `${Math.round(magnitude / 86400)} 天${suffix}`;
}

function lookup(
  table: Readonly<Record<string, Described>>,
  value: string,
  what: string,
): Described {
  return table[value] ?? { label: `未知${what}：${value}`, tone: "danger" };
}

const JOB_STATUS: Record<JobStatus, Described> = {
  queued: { label: "排隊中", tone: "neutral" },
  extracting: { label: "抽取中", tone: "info" },
  judging: { label: "Jev 判定中", tone: "info" },
  review: { label: "待人工審閱", tone: "warn" },
  "archive-only": { label: "僅封存", tone: "neutral" },
  ready: { label: "待發佈", tone: "ok" },
  writing: { label: "寫入 SiYuan 中", tone: "info" },
  complete: { label: "完成", tone: "ok" },
  "retry-wait": { label: "等待重試", tone: "warn" },
  failed: { label: "失敗", tone: "danger" },
};

export function describeJobStatus(value: string): Described {
  return lookup(JOB_STATUS, value, "工作狀態");
}

const CANDIDATE_STATUS: Record<string, Described> = {
  pending: { label: "待處理", tone: "neutral" },
  review: { label: "待審閱", tone: "warn" },
  "archive-only": { label: "僅封存", tone: "neutral" },
  ready: { label: "可發佈", tone: "ok" },
  published: { label: "已發佈", tone: "ok" },
  duplicate: { label: "重複內容", tone: "info" },
};

export function describeCandidateStatus(value: string): Described {
  return lookup(CANDIDATE_STATUS, value, "候選狀態");
}

const OPERATION_STATUS: Record<string, Described> = {
  planned: { label: "已規劃（尚未送出）", tone: "neutral" },
  sent: { label: "已送出（未讀回）", tone: "info" },
  uncertain: { label: "結果未確定", tone: "warn" },
  verified: { label: "已驗證", tone: "ok" },
  conflict: { label: "內容衝突", tone: "danger" },
  undoing: { label: "撤回待確認", tone: "warn" },
  undone: { label: "已撤回", tone: "neutral" },
};

export function describeOperationStatus(value: string): Described {
  return lookup(OPERATION_STATUS, value, "操作狀態");
}

const DISPOSITION: Record<string, Described> = {
  retain: { label: "保留並發佈", tone: "ok" },
  "archive-only": { label: "僅封存", tone: "neutral" },
  review: { label: "待人工審閱", tone: "warn" },
};

export function describeDisposition(value: string): Described {
  return lookup(DISPOSITION, value, "Jev 處置");
}

const KIND: Record<string, Described> = {
  conclusion: { label: "結論", tone: "info" },
  decision: { label: "決策", tone: "info" },
  method: { label: "方法", tone: "info" },
  project: { label: "專案資訊", tone: "info" },
  question: { label: "問題", tone: "warn" },
  action: { label: "待辦行動", tone: "warn" },
};

export function describeKind(value: string): Described {
  return lookup(KIND, value, "候選類型");
}

const INFORMATION_STATUS: Record<string, Described> = {
  confirmed: { label: "已確認", tone: "ok" },
  uncertain: { label: "未確定", tone: "warn" },
  conflicting: { label: "互相矛盾", tone: "danger" },
};

export function describeInformationStatus(value: string): Described {
  return lookup(INFORMATION_STATUS, value, "資訊狀態");
}

const DOMAIN: Record<string, Described> = {
  engineering: { label: "工程", tone: "neutral" },
  project: { label: "專案", tone: "neutral" },
  general: { label: "一般", tone: "neutral" },
  unknown: { label: "未知", tone: "warn" },
};

export function describeDomain(value: string): Described {
  return lookup(DOMAIN, value, "領域");
}

const JUDGMENT_ACTION: Record<string, Described> = {
  create: { label: "建立新筆記", tone: "ok" },
  append: { label: "附加至既有筆記", tone: "ok" },
  duplicate: { label: "重複，無需寫入", tone: "info" },
  review: { label: "交由人工決定", tone: "warn" },
};

export function describeJudgmentAction(value: string): Described {
  return lookup(JUDGMENT_ACTION, value, "建議動作");
}

const AUTHOR: Record<string, Described> = {
  model: { label: "模型產生", tone: "info" },
  human: { label: "人工修訂", tone: "ok" },
};

export function describeAuthor(value: string): Described {
  return lookup(AUTHOR, value, "作者");
}

const CARD_STATUS: Record<string, Described> = {
  active: { label: "生效中", tone: "ok" },
  proposal: { label: "提案（未生效）", tone: "warn" },
};

export function describeCardStatus(value: string): Described {
  return lookup(CARD_STATUS, value, "心智卡狀態");
}

// 供表格使用的鍵值摘要：任何 unknown 值都以 JSON 文字呈現，不執行任何 HTML。
export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2) ?? "—";
  } catch {
    return "（無法序列化的值）";
  }
}

// 目標路徑顯示：path 可能已含受管根目錄前綴，也可能只是相對路徑；兩種情形都不重複疊接。
export function operationTargetLabel(operation: { rootPath: string; path: string }): string {
  const root = operation.rootPath.replace(/\/+$/, "");
  const path = operation.path;
  if (root === "" || path === root || path.startsWith(`${root}/`)) return path;
  return `${root}${path.startsWith("/") ? "" : "/"}${path}`;
}

export function noteHref(blockId: string, publicUrl = ""): string {
  return publicUrl
    ? `${publicUrl}/stage/build/desktop/?id=${encodeURIComponent(blockId)}`
    : `siyuan://blocks/${blockId}`;
}
