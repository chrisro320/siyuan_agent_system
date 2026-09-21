// 設定編輯草稿：以「讀取當下的 revision + 伺服器原始物件」為底，
// PUT 時用同一 revision 做 CAS，並保留前端不認識的欄位，避免覆寫伺服器端其他設定。

import type { Destination, Policy, Settings } from "../src/contracts";
import { saveSettings } from "./api";
import type { AppContext, AppState } from "./context";

export interface SettingsDraft {
  revision: number;
  policy: Policy;
  destinations: Destination[];
  ompRoots: Settings["ompRoots"];
  raw: unknown;
}

export function draftFrom(state: AppState): SettingsDraft {
  const settings = state.overview.settings;
  return {
    revision: settings.revision,
    policy: structuredClone(settings.policy),
    destinations: structuredClone(settings.destinations),
    ompRoots: structuredClone(settings.ompRoots),
    raw: state.rawSettings,
  };
}

// 草稿指紋：用來判斷使用者是否改動過表單，以及自動重繪時可否安全套用伺服器狀態。
export function settingsFingerprint(draft: SettingsDraft): string {
  return JSON.stringify({
    revision: draft.revision,
    policy: draft.policy,
    destinations: draft.destinations,
    ompRoots: draft.ompRoots,
  });
}

export function settingsDirty(current: SettingsDraft, baseline: string): boolean {
  return settingsFingerprint(current) !== baseline;
}

// 伺服器 revision 已前進時，代表其他分頁或後端流程改過設定；
// 面板會保留使用者草稿並提示，而不是默默蓋掉。
export function staleAgainst(draft: SettingsDraft, state: AppState): boolean {
  return state.overview.settings.revision !== draft.revision;
}

export function asSettings(draft: SettingsDraft): Settings {
  return {
    revision: draft.revision,
    policy: draft.policy,
    destinations: draft.destinations,
    ompRoots: draft.ompRoots,
  };
}

export function putSettings(
  ctx: AppContext,
  draft: SettingsDraft,
  button: HTMLButtonElement,
  successMessage: string,
  onSaved: (saved: Settings) => void,
): void {
  ctx.mutate({
    button,
    work: async () => {
      const submitted = settingsFingerprint(draft);
      const saved = await saveSettings(asSettings(draft), draft.raw);
      if (settingsFingerprint(draft) === submitted) Object.assign(draft, structuredClone(saved));
      draft.revision = saved.revision;
      draft.raw = saved;
      onSaved(saved);
      return successMessage;
    },
  });
}
