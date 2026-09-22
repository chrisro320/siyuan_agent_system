/**
 * 已建置 OMP 配接器的內容 manifest 契約。
 *
 * `scripts/build.ts` 在輸出目錄寫入這份 manifest；`scripts/setup-omp.ts` 用它核對
 * 真正會被 stub 載入的 artifact：輸出檔內容雜湊，加上建置當時所有來源（entry、
 * capture、state、contracts 等）的內容雜湊。它只有這一個用途，不是通用建置清單。
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const ADAPTER_ENTRY_RELATIVE = "integrations/omp/index.ts";
export const ADAPTER_MANIFEST_NAME = "omp-memory.manifest.json";
export const ADAPTER_MANIFEST_SCHEMA_VERSION = 1;

export interface AdapterManifest {
  schemaVersion: typeof ADAPTER_MANIFEST_SCHEMA_VERSION;
  entry: string;
  /** 建置當時的來源專案根目錄；`inputs` 的鍵相對於此。 */
  root: string;
  /** 來源相對路徑 → sha256。 */
  inputs: Record<string, string>;
  artifact: { file: string; sha256: string };
}

export async function hashFile(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** 解析並驗證 manifest；格式不符時丟出一般 Error，由呼叫端決定錯誤碼。 */
export function parseAdapterManifest(text: string): AdapterManifest {
  const fail = (detail: string): never => {
    throw new Error(`manifest 格式無效：${detail}`);
  };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail("不是有效 JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return fail("最上層必須是物件");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== ADAPTER_MANIFEST_SCHEMA_VERSION) return fail("schemaVersion 不支援");
  if (typeof record.entry !== "string" || record.entry === "") return fail("entry 必須是非空字串");
  if (typeof record.root !== "string" || !isAbsolute(record.root))
    return fail("root 必須是絕對路徑");
  const inputs = record.inputs;
  if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs))
    return fail("inputs 必須是對應表");
  const entries = Object.entries(inputs as Record<string, unknown>);
  if (entries.length === 0) return fail("inputs 不得為空");
  for (const [key, digest] of entries) {
    if (key === "" || isAbsolute(key) || key.split(/[\\/]/).includes(".."))
      return fail(`來源鍵 ${key} 不是安全的相對路徑`);
    if (typeof digest !== "string" || !SHA256_PATTERN.test(digest))
      return fail(`來源 ${key} 的雜湊不是 sha256`);
  }
  const artifact = record.artifact;
  if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact))
    return fail("artifact 必須是物件");
  const file = (artifact as Record<string, unknown>).file;
  const sha256 = (artifact as Record<string, unknown>).sha256;
  if (typeof file !== "string" || file === "" || file.includes("/"))
    return fail("artifact.file 必須是檔名");
  if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256))
    return fail("artifact.sha256 不是 sha256");
  return record as unknown as AdapterManifest;
}
