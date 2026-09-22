/**
 * 建置兩個出貨面：控制面板與 OMP 配接器。
 *
 * 兩者都在同一個暫存目錄完成；任何一邊失敗就整批放棄，舊 `dist/` 不會混入半套
 * 新 bundle。全部成功後才整體替換 `dist/`，替換失敗會把舊目錄還原。配接器的
 * 來源與輸出雜湊寫入內容 manifest，供 `scripts/setup-omp.ts` 核對。
 */
import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ADAPTER_ENTRY_RELATIVE,
  ADAPTER_MANIFEST_NAME,
  ADAPTER_MANIFEST_SCHEMA_VERSION,
  type AdapterManifest,
  hashFile,
} from "./adapter-manifest.ts";

const REPO_ROOT = dirname(import.meta.dir);
const DIST = join(REPO_ROOT, "dist");
const ADAPTER_OUTPUT = "omp-memory.js";
const WEB_ENTRY = join(REPO_ROOT, "web", "main.ts");
// 暫存與備份目錄都在 repo 內（與 dist 同檔案系統，rename 才是原子替換），並以 pid 區隔。
const staging = join(REPO_ROOT, `.dist-staging-${process.pid}`);
const previous = join(REPO_ROOT, `.dist-previous-${process.pid}`);

/** 把 Bun.build metafile 的輸入鍵還原成 repo 內的相對路徑；相依套件與 repo 外檔案略過。 */
async function relativeToRepo(metafileKey: string): Promise<string | null> {
  const candidates = isAbsolute(metafileKey)
    ? [metafileKey]
    : [resolve(REPO_ROOT, metafileKey), resolve(process.cwd(), metafileKey)];
  for (const candidate of candidates) {
    if (
      !(await stat(candidate).then(
        () => true,
        () => false,
      ))
    )
      continue;
    const rel = relative(REPO_ROOT, candidate);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    if (rel.split(sep).includes("node_modules")) return null;
    return rel.split(sep).join("/");
  }
  return null;
}

async function buildIntoStaging(): Promise<void> {
  const web = await Bun.build({
    entrypoints: [WEB_ENTRY],
    outdir: staging,
    target: "browser",
    minify: true,
    naming: "main.js",
  });
  if (!web.success) {
    for (const log of web.logs) console.error(log);
    throw new Error("控制面板建置失敗，dist 未變更。");
  }
  await Promise.all([
    copyFile(join(REPO_ROOT, "web", "index.html"), join(staging, "index.html")),
    copyFile(join(REPO_ROOT, "web", "style.css"), join(staging, "style.css")),
  ]);
  console.info("Staged control panel.");

  const adapter = await Bun.build({
    entrypoints: [join(REPO_ROOT, ADAPTER_ENTRY_RELATIVE)],
    outdir: staging,
    target: "bun",
    minify: false,
    naming: ADAPTER_OUTPUT,
    external: ["@oh-my-pi/*"],
    metafile: true,
  });
  if (!adapter.success) {
    for (const log of adapter.logs) console.error(log);
    throw new Error("OMP 配接器建置失敗，dist 未變更。");
  }

  const inputs: Record<string, string> = {};
  for (const key of Object.keys(adapter.metafile?.inputs ?? {})) {
    const rel = await relativeToRepo(key);
    if (rel === null || rel in inputs) continue;
    inputs[rel] = await hashFile(join(REPO_ROOT, rel));
  }
  for (const dependencyFile of ["package.json", "bun.lock"]) {
    inputs[dependencyFile] = await hashFile(join(REPO_ROOT, dependencyFile));
  }
  const manifest: AdapterManifest = {
    schemaVersion: ADAPTER_MANIFEST_SCHEMA_VERSION,
    entry: ADAPTER_ENTRY_RELATIVE,
    root: REPO_ROOT,
    inputs,
    artifact: {
      file: ADAPTER_OUTPUT,
      sha256: await hashFile(join(staging, ADAPTER_OUTPUT)),
    },
  };
  await writeFile(join(staging, ADAPTER_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  console.info(`Staged OMP adapter with ${ADAPTER_MANIFEST_NAME}.`);
}

/** 整體替換 dist；rename 失敗時把舊目錄放回原位。 */
async function replaceDist(): Promise<void> {
  const hadDist = await stat(DIST).then(
    (info) => info.isDirectory(),
    () => false,
  );
  await rm(previous, { recursive: true, force: true });
  if (hadDist) await rename(DIST, previous);
  try {
    await rename(staging, DIST);
  } catch (error) {
    // 還原失敗時保留 previous 目錄，供人工復原，不逕行刪除。
    if (hadDist) await rename(previous, DIST).catch(() => undefined);
    throw error;
  }
  await rm(previous, { recursive: true, force: true });
}

try {
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await buildIntoStaging();
  await replaceDist();
  console.info("Built control panel and OMP adapter: dist/");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await rm(staging, { recursive: true, force: true });
}
