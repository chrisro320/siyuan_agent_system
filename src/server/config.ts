import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AppError } from "../contracts";

export interface Config {
  dataDir: string;
  port: number;
  hostname: string;
  publicOrigin: string;
  ollamaKey: string | null;
  jevKey: string | null;
  siyuanUrl: string;
  siyuanPublicUrl?: string;
  siyuanToken: string | null;
  allowedOmpRoots: string[];
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
  return {
    dataDir: resolve(env.DATA_DIR ?? "data"),
    port,
    hostname: env.HOST ?? "127.0.0.1",
    publicOrigin,
    ollamaKey: await secret(env, "OLLAMA_API_KEY"),
    jevKey: await secret(env, "TYPESAFE_API_KEY"),
    siyuanUrl,
    siyuanPublicUrl,
    siyuanToken: await secret(env, "SIYUAN_TOKEN"),
    allowedOmpRoots: (env.OMP_ALLOWED_ROOTS ?? "")
      .split(",")
      .map((root) => root.trim())
      .filter(Boolean)
      .map((root) => resolve(root)),
  };
}
