// 面板共用的執行環境介面。main.ts 提供實作，view 只依賴這個介面。

import type { Overview } from "../src/contracts";
import type { NoticeTone } from "./dom";

export interface AppState {
  overview: Overview;
  // 伺服器原始 settings 物件（未經 schema 過濾），送出 PUT 時作為底稿以保留未知欄位。
  rawSettings: unknown;
  fetchedAt: number;
}

export interface MutationOptions {
  work: () => Promise<string | null>;
  button?: HTMLButtonElement | undefined;
}

export interface AppContext {
  state: AppState | null;
  refresh(): Promise<void>;
  mutate(options: MutationOptions): void;
  notice(tone: NoticeTone, message: string, detail?: string): void;
  openCandidate(candidateId: string): void;
  selectedCandidateId: string | null;
}

export interface Surface {
  readonly id: string;
  readonly title: string;
  readonly node: HTMLElement;
  update(state: AppState): void;
  // 使用者正在編輯或有未送出的內容時回傳 true，main.ts 會暫停該面板的自動重繪。
  isDirty(): boolean;
  activated?(): void;
}
