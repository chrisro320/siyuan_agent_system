/**
 * OMP 記憶轉接器的專案設定。
 *
 * schema 由轉接器自己擁有（欄位凍結在實作契約：`schemaVersion`/`enabled`/
 * `projectId`/`projectRoot`/`serviceUrl`/`tokenFile`/`stateDir`/`activatedAt`），
 * 伺服器不知道這個檔案的存在。
 *
 * 缺檔或 `enabled:false` 都算「停用」，不是錯誤：一般聊天不因此中斷。
 * 真正壞掉的設定（JSON 不合法、欄位不符、憑證檔不可讀）回報 `unavailable`，
 * 讓狀態指令說得出原因，而不是靜靜假裝一切正常。
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { z } from "zod";
import { id, isoTime } from "../../src/contracts/index.ts";
import { errorCodeOf } from "./state.ts";

/** 設定檔位置（相對於 session 的 cwd）。 */
export const MEMORY_CONFIG_DIR = ".omp";
export const MEMORY_CONFIG_FILENAME = "siyuan-memory.json";
/** 覆寫設定檔路徑的環境變數；未設定時讀 `<cwd>/.omp/siyuan-memory.json`。 */
export const MEMORY_CONFIG_ENV = "SIYUAN_MEMORY_CONFIG";
/** 憑證檔讀取上限：超過即視為設定錯誤，不做部分讀取。 */
export const MAX_TOKEN_BYTES = 8192;
export const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_REASON_CHARS = 300;

const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => isAbsolute(value) && !value.includes("\0"),
    "必須是絕對路徑，且不含 NUL 字元。",
  );

/**
 * 服務來源網址：只允許純 origin（scheme + host + 可選 port）。
 *
 * 這是安裝程式與 runtime 共用的唯一驗證器：伺服器端的 `PUBLIC_ORIGIN` 明確禁止
 * 路徑，因此帶 path／query／hash 的網址必須在安裝時就被拒絕，而不是等到轉接器
 * 送請求時得到 404。`url.origin === value` 同時擋掉路徑、查詢、片段與尾端斜線；
 * 帳密欄位另外明確拒絕，避免把憑證寫進設定檔。
 */
export const serviceOriginSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.username === "" &&
        url.password === "" &&
        url.origin === value
      );
    } catch {
      return false;
    }
  }, "必須是 http(s) 的來源網址（scheme://host[:port]），且不含路徑、查詢、片段或帳密。");

/**
 * 嚴格模式物件：未知欄位一律拒絕。
 *
 * 這裡刻意不寬容未知鍵——設定只由已驗證的安裝程序寫入，多出來的鍵代表
 * 有人以為那個欄位有效，寧可讓它可見也不要默默忽略。
 */
export const memoryConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  enabled: z.boolean(),
  projectId: id,
  projectRoot: absolutePath,
  serviceUrl: serviceOriginSchema,
  tokenFile: absolutePath,
  stateDir: absolutePath,
  activatedAt: isoTime,
});
export type MemoryConfig = z.infer<typeof memoryConfigSchema>;

export type MemorySetup =
  | { status: "ready"; config: MemoryConfig; token: string; warnings: string[] }
  | { status: "disabled" | "unavailable"; reasons: string[] };

/**
 * 路徑運算介面。
 *
 * 邊界判定必須可離線驗證 Windows 語意（磁碟代號、反斜線分隔），但這個模組只在
 * 執行期使用宿主平台的 `node:path`。因此把 `relative`／`isAbsolute`／`sep` 抽成
 * 可注入的 flavor：正式路徑用 posix/平台原生實作，測試可傳 `path.win32`，不必
 * 在整個專案裡假造一套 Windows 支援。
 */
export interface PathFlavor {
  isAbsolute(value: string): boolean;
  relative(from: string, to: string): string;
  readonly sep: string;
}

const nativePath: PathFlavor = { isAbsolute, relative, sep };

/**
 * 目標 cwd 是否落在 `projectRoot` 之內（含本身）。
 *
 * 用 `relative()` 取代字串前綴比對：字串比對會在 Windows 的反斜線路徑、尾端斜線
 * 與同前綴的兄弟目錄（`/a/root` 對 `/a/root2`）上誤判。`relative` 回空字串代表
 * 同一個目錄；回絕對路徑代表不同磁碟（只有 Windows 會發生）；回 `..` 開頭代表
 * 位於父層之外。非絕對路徑一律視為不在範圍內。
 */
export function cwdWithinProject(
  cwd: string,
  projectRoot: string,
  flavor: PathFlavor = nativePath,
): boolean {
  if (!flavor.isAbsolute(cwd) || !flavor.isAbsolute(projectRoot)) return false;
  const rel = flavor.relative(projectRoot, cwd);
  if (rel === "") return true;
  if (flavor.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${flavor.sep}`);
}

export function resolveMemoryConfigPath(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): { path: string; fromEnv: boolean } {
  const override = env[MEMORY_CONFIG_ENV]?.trim() ?? "";
  if (override.length > 0) return { path: normalize(override), fromEnv: true };
  return {
    path: join(normalize(cwd), MEMORY_CONFIG_DIR, MEMORY_CONFIG_FILENAME),
    fromEnv: false,
  };
}

/** 有界讀取：先看大小再看內容，不讀超過上限的檔案。 */
function readBoundedText(
  path: string,
  limit: number,
): { ok: true; text: string } | { ok: false; reason: string } {
  try {
    if (statSync(path).size > limit) {
      return { ok: false, reason: `檔案超過 ${limit} 位元組上限，未讀取。` };
    }
    return { ok: true, text: readFileSync(path, "utf8") };
  } catch (error) {
    const code = errorCodeOf(error);
    return { ok: false, reason: code === "ENOENT" ? "檔案不存在。" : "檔案無法讀取。" };
  }
}

type TokenResult = { ok: true; value: string; warnings: string[] } | { ok: false; reason: string };

/**
 * 讀取轉接器權杖。
 *
 * 內容只存在於回傳值，不會被寫進狀態檔、日誌或錯誤訊息。權限過寬只警告，
 * 因為拒絕讀取會讓已驗證的安裝在寬鬆的 umask 下完全無法運作；但狀態指令會
 * 明示這件事。
 */
export function readAdapterToken(path: string): TokenResult {
  const warnings: string[] = [];
  let mode = 0;
  try {
    mode = statSync(path).mode;
  } catch {
    return { ok: false, reason: `憑證檔不存在或無法讀取（${path}）。` };
  }
  if ((mode & 0o077) !== 0) {
    warnings.push(`憑證檔權限過寬（${(mode & 0o777).toString(8)}），建議 chmod 600。`);
  }
  const raw = readBoundedText(path, MAX_TOKEN_BYTES);
  if (!raw.ok) return { ok: false, reason: `憑證檔不可讀（${path}）：${raw.reason}` };
  const value = raw.text.trim();
  if (value.length === 0) return { ok: false, reason: `憑證檔是空的（${path}）。` };
  return { ok: true, value, warnings };
}

/** 讀取並驗證設定，決定這個 session 是否要啟用自動記憶。 */
export function loadMemorySetup(cwd: string, env: NodeJS.ProcessEnv = process.env): MemorySetup {
  const { path } = resolveMemoryConfigPath(cwd, env);
  const raw = readBoundedText(path, MAX_CONFIG_BYTES);
  if (!raw.ok) return { status: "disabled", reasons: [`未啟用：${raw.reason}（${path}）`] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.text);
  } catch {
    return { status: "unavailable", reasons: [`設定檔不是合法 JSON（${path}）。`] };
  }

  const validated = memoryConfigSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("；");
    return {
      status: "unavailable",
      reasons: [
        `設定檔欄位不符 schemaVersion 1 契約（${path}）：${
          issues.length <= MAX_REASON_CHARS ? issues : `${issues.slice(0, MAX_REASON_CHARS)}…`
        }`,
      ],
    };
  }
  const config = validated.data;
  if (!config.enabled)
    return { status: "disabled", reasons: [`設定檔 enabled 為 false（${path}）。`] };
  if (!cwdWithinProject(cwd, config.projectRoot)) {
    return {
      status: "disabled",
      reasons: [`目前工作目錄不在設定的 projectRoot 內，未啟用自動記憶（${path}）。`],
    };
  }

  const token = readAdapterToken(config.tokenFile);
  if (!token.ok) return { status: "unavailable", reasons: [token.reason] };
  return { status: "ready", config, token: token.value, warnings: token.warnings };
}
