import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AppError, type GenerationProfile, generationProfileSchema } from "../contracts";
import {
  DEFAULT_GENERATION_AUTH_MODE,
  DEFAULT_GENERATION_BASE_URL,
  DEFAULT_GENERATION_MODEL,
  DEFAULT_GENERATION_PROTOCOL,
  resolveGenerationEndpoint,
} from "../providers/generation";

export interface Config {
  dataDir: string;
  port: number;
  hostname: string;
  publicOrigin: string;
  /**
   * 開機凍結的生效生成選擇：協定、端點、模型與認證模式。
   *
   * 四者都不是機密，可以出現在設定畫面與 API；憑據只以環境變數或 `_FILE` 提供，
   * 永遠不回傳給瀏覽器。未設定憑據時生成呼叫直接失敗，不會回退到其他供應商或模型。
   * 執行中的 worker 只用這份快照：面板儲存的草稿要等服務重新啟動才會變成這裡的值。
   */
  activeGeneration: GenerationProfile;
  /** 伺服器端生成憑據；`authMode: 'none'` 或未設定時為 `null`。 */
  generationKey: string | null;
  /**
   * 憑據唯一允許送出的來源：`GENERATION_API_KEY_ORIGIN`，未設定時為環境端點的來源
   * （向後相容：原本的環境端點已經釘住了憑據）。它是一條綁定，不是可調設定，因此
   * 一律存在；換到別的來源必須明示設定，否則啟動會以來源不符停止。`authMode: 'none'`
   * 不會送出任何憑據。
   */
  generationCredentialOrigin: string;
  jevKey: string | null;
  siyuanUrl: string;
  siyuanPublicUrl?: string;
  siyuanToken: string | null;
  allowedOmpRoots: string[];
  /**
   * 自動擷取與顯式搜尋轉接器的伺服器端憑據與專案允許清單。
   *
   * 兩者都是選填：未設定即代表本機的擷取／搜尋端點停用，既有面板與手動匯入
   * 完全不受影響。因此既有設定物件（例如測試夾具）不需要提供這些欄位。
   */
  adapterToken?: string | null;
  adapterProjects?: string[];
}

async function secret(env: NodeJS.ProcessEnv, name: string): Promise<string | null> {
  if (env[name]?.trim()) return env[name]?.trim() ?? null;
  const file = env[`${name}_FILE`];
  if (!file) return null;
  try {
    return (await readFile(file, "utf8")).trim() || null;
  } catch {
    throw new AppError("secret_file_unreadable", `${name}_FILE 無法讀取，請檢查伺服器設定。`);
  }
}

/** 解析必須是完整來源（含通訊協定與主機，不含路徑、查詢或憑據）的設定值。 */
function requireOrigin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(
      "invalid_generation_key_origin",
      `${name} 必須是完整來源，例如 https://generation.example。`,
    );
  }
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== value) {
    throw new AppError(
      "invalid_generation_key_origin",
      `${name} 必須是完整來源（含通訊協定與主機，不含路徑、查詢字串或憑據）。`,
    );
  }
  return url.origin;
}

/**
 * 驗證並正規化一個非機密生成選擇。環境設定、面板草稿與已保存的草稿都走同一條路。
 *
 * 語意驗證集中在 provider 的端點解析：不支援的協定或認證模式、內嵌憑據或查詢字串的
 * 網址、遠端明文的 bearer 端點、非 loopback 的無驗證端點、含空白或控制字元的模型名稱
 * 都會被拒。回傳值已去掉端點尾斜線與欄位空白，因此同一個選擇只有一種寫法，指紋才穩定。
 */
function normalizeGenerationProfile(profile: GenerationProfile): GenerationProfile {
  const parsed = generationProfileSchema.parse(profile);
  const endpoint = resolveGenerationEndpoint(
    parsed.baseUrl,
    parsed.model,
    parsed.protocol,
    parsed.authMode,
  );
  return {
    protocol: endpoint.protocol,
    baseUrl: endpoint.baseUrl,
    model: endpoint.model,
    authMode: endpoint.authMode,
  };
}

/**
 * 面板送來的草稿：不合法屬於使用者輸入問題，對外以 400 回報，而不是伺服器設定錯誤。
 */
export function checkedGenerationProfile(profile: GenerationProfile): GenerationProfile {
  try {
    return normalizeGenerationProfile(profile);
  } catch (error) {
    if (error instanceof AppError && error.code === "provider_misconfigured") {
      throw new AppError("invalid_generation_profile", error.message, false, 400);
    }
    throw error;
  }
}

/**
 * 開機解析出生效的生成設定：有已保存的草稿就以草稿為準，否則沿用環境設定。
 *
 * - 草稿不合法（例如舊版留下的不支援協定，或資料庫被手動改過）時直接讓啟動失敗，
 *   不會退回上一個供應商：靜默換供應商比拒絕啟動更危險。
 * - `authMode: 'bearer'` 要求憑據來源與端點來源一致。環境端點本身就是預設綁定，
 *   要改用其他來源必須明示設定 `GENERATION_API_KEY_ORIGIN`。憑據未設定時只會讓呼叫
 *   失敗（`generationKey` 為 `null`），不會改用其他來源或匿名呼叫。
 * - `authMode: 'none'` 不送出任何憑據，因此 `generationKey` 收斂為 `null`。
 */
export function resolveGeneration(config: Config, staged: GenerationProfile | null): Config {
  let profile = config.activeGeneration;
  if (staged !== null) {
    try {
      profile = normalizeGenerationProfile(staged);
    } catch (error) {
      // 已保存的草稿不合法時拒絕啟動，不會退回上一個供應商：靜默換供應商比拒絕啟動危險。
      // provider 的設定錯誤本身就是可讀的伺服器錯誤，契約驗證失敗則轉成同樣姿態。
      if (error instanceof AppError) throw error;
      throw new AppError(
        "invalid_generation_profile",
        "已保存的生成設定不合法，服務不會改用其他供應商啟動。",
        false,
        500,
      );
    }
  }
  const usesCredential = profile.authMode === "bearer";
  if (usesCredential && config.generationCredentialOrigin !== new URL(profile.baseUrl).origin) {
    throw new AppError(
      "provider_misconfigured",
      "生成服務的憑據來源與端點不符；切換到其他來源請同時設定 GENERATION_API_KEY_ORIGIN。",
      false,
      500,
    );
  }
  return {
    ...config,
    activeGeneration: profile,
    generationKey: usesCredential ? config.generationKey : null,
  };
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError("invalid_port", "PORT 必須是有效連接埠。");
  }
  const publicOrigin = env.PUBLIC_ORIGIN?.trim() || `http://localhost:${port}`;
  const originUrl = new URL(publicOrigin);
  if (!["http:", "https:"].includes(originUrl.protocol) || originUrl.origin !== publicOrigin) {
    throw new AppError("invalid_origin", "PUBLIC_ORIGIN 必須是完整網站來源，不含路徑。");
  }
  const siyuanUrl = env.SIYUAN_URL?.replace(/\/$/, "") ?? "";
  if (siyuanUrl) {
    const url = new URL(siyuanUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new AppError("invalid_siyuan_url", "SIYUAN_URL 必須是 HTTP 網址，不得內嵌憑據。");
    }
  }
  const siyuanPublicUrl = env.SIYUAN_PUBLIC_URL?.replace(/\/$/, "") ?? "";
  if (siyuanPublicUrl) {
    const url = new URL(siyuanPublicUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new AppError(
        "invalid_siyuan_public_url",
        "SIYUAN_PUBLIC_URL 必須是可公開的 HTTP 網址，不得內嵌憑據。",
      );
    }
  }
  // Unsupported protocols or authentication modes, malformed or unsafe endpoints and
  // non-loopback unauthenticated endpoints are rejected here, before any call could
  // send a credential to a misparsed destination. The normalized values are the ones
  // the provider client is constructed with, so the same selection always has one
  // spelling and therefore one identity fingerprint.
  const endpoint = resolveGenerationEndpoint(
    env.GENERATION_BASE_URL?.trim() || DEFAULT_GENERATION_BASE_URL,
    env.GENERATION_MODEL?.trim() || DEFAULT_GENERATION_MODEL,
    env.GENERATION_PROTOCOL?.trim() || DEFAULT_GENERATION_PROTOCOL,
    env.GENERATION_AUTH_MODE?.trim() || DEFAULT_GENERATION_AUTH_MODE,
  );
  const keyOrigin = env.GENERATION_API_KEY_ORIGIN?.trim() ?? "";
  return {
    dataDir: resolve(env.DATA_DIR ?? "data"),
    port,
    hostname: env.HOST ?? "127.0.0.1",
    publicOrigin,
    activeGeneration: {
      protocol: endpoint.protocol,
      baseUrl: endpoint.baseUrl,
      model: endpoint.model,
      authMode: endpoint.authMode,
    },
    generationKey: await secret(env, "GENERATION_API_KEY"),
    generationCredentialOrigin:
      keyOrigin === "" ? endpoint.origin : requireOrigin(keyOrigin, "GENERATION_API_KEY_ORIGIN"),
    jevKey: await secret(env, "TYPESAFE_API_KEY"),
    siyuanUrl,
    siyuanPublicUrl,
    siyuanToken: await secret(env, "SIYUAN_TOKEN"),
    allowedOmpRoots: (env.OMP_ALLOWED_ROOTS ?? "")
      .split(",")
      .map((root) => root.trim())
      .filter(Boolean)
      .map((root) => resolve(root)),
    adapterToken: await secret(env, "ADAPTER_TOKEN"),
    adapterProjects: (env.ADAPTER_PROJECTS ?? "")
      .split(",")
      .map((projectId) => projectId.trim())
      .filter(Boolean),
  };
}
