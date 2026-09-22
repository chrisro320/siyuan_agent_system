import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { discoverExtensionPaths } from "@oh-my-pi/pi-coding-agent";
import { discoverExtensionModulePaths } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { hashFile } from "../scripts/adapter-manifest.ts";

/**
 * `scripts/setup-omp.ts` 的行為測試。每個案例都在用完即丟的合成專案中執行真實 CLI；
 * 不會接觸任何真實專案、憑據、服務或 OMP 設定。權杖固定值必須不出現在兩個輸出串流中。
 *
 * stub 相關案例一律用真正的 `import()` 載入產生的 stub，確認它繫結到實際驗證過的
 * 配接器，而不是比對生成字串。gitignore 相關案例另外呼叫 OMP 自己的探索函式：
 * 原生掃描（gitignore 過濾）找不到 gitignored 的 stub，而 `extensions` 顯式註冊
 * 的絕對路徑仍會被載入。
 *
 * 安裝器不主張自動記憶擁有權：Hindsight 的 `hindsight.*`、既有 `disabledExtensions`
 * 項目（含 jev-memory-gate 的停用狀態）與整份全域設定都必須原樣保留，且在 Hindsight
 * 或 gate 仍啟用（含環境變數覆寫）時仍要安裝成功。
 */

const SCRIPT = join(import.meta.dir, "..", "scripts", "setup-omp.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const TOKEN_VALUE = "adapter-token-value-9f3-do-not-print";
const GATE_EXTENSION_ID = "extension-module:jev-memory-gate";
const STUB_RELATIVE = join(".omp", "extensions", "siyuan-memory.ts");
const CONFIG_RELATIVE = join(".omp", "siyuan-memory.json");
const MANIFEST_NAME = "omp-memory.manifest.json";
const BASE_ENV: Record<string, string> = {
  SIYUAN_MEMORY_CONFIG: "",
  PI_CODING_AGENT_DIR: "",
  PI_CONFIG_DIR: "",
  OMP_PROFILE: "",
  PI_PROFILE: "",
};
/**
 * 真實部署裡可能同時存在的 Hindsight／gate 環境覆寫。安裝器已不主張自動記憶擁有
 * 權，這些值既不能讓安裝失敗，也不能被改寫。
 */
const ACTIVE_MEMORY_ENV: Record<string, string> = {
  HINDSIGHT_AUTO_RECALL: "1",
  HINDSIGHT_AUTO_RETAIN: "true",
  JEV_GATE_MODE: "A+B_LIVE",
};

interface Fixture {
  root: string;
  token: string;
  adapter: string;
  configPath: string;
  stubPath: string;
  globalConfig: string;
  stateDir: string;
  cleanup(): Promise<void>;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function runSetup(args: string[], env: Record<string, string> = {}): Promise<Run> {
  const child = Bun.spawn(["bun", SCRIPT, ...args], {
    env: { ...process.env, ...BASE_ENV, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

async function fixture(settings?: string): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "siyuan-setup-"));
  const root = join(base, "project");
  await mkdir(join(root, "secrets"), { recursive: true });
  const token = join(root, "secrets", "adapter.token");
  await writeFile(token, `${TOKEN_VALUE}\n`, { mode: 0o600 });
  const adapter = join(base, "omp-memory.js");
  await writeFile(adapter, "export default function adapter() {}\n");
  const globalConfig = join(base, "global-config.yml");
  if (settings !== undefined) {
    await mkdir(join(root, ".omp"), { recursive: true });
    await writeFile(join(root, ".omp", "config.yml"), settings);
  }
  return {
    root,
    token,
    adapter,
    configPath: join(root, CONFIG_RELATIVE),
    stubPath: join(root, STUB_RELATIVE),
    globalConfig,
    stateDir: join(root, ".omp", "siyuan-memory-state"),
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

function baseArgs(f: Fixture, extra: string[] = []): string[] {
  return [
    "--project",
    f.root,
    "--project-id",
    "siyuan-agent-system",
    "--service-url",
    "http://127.0.0.1:18787/",
    "--token-file",
    f.token,
    "--adapter",
    f.adapter,
    "--global-config",
    f.globalConfig,
    ...extra,
  ];
}

/** 與 `baseArgs` 相同，但省略 `--global-config`，讓安裝器走原生 OMP 的預設規則。 */
function argsUsingNativeGlobalConfig(f: Fixture, extra: string[] = []): string[] {
  const args = baseArgs(f, extra);
  const index = args.indexOf("--global-config");
  return [...args.slice(0, index), ...args.slice(index + 2)];
}

/** 直接手寫一份配接器設定檔：用來模擬舊版安裝留下的內容。 */
function memoryConfig(f: Fixture, serviceUrl: string): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      enabled: true,
      projectId: "siyuan-agent-system",
      projectRoot: f.root,
      serviceUrl,
      tokenFile: f.token,
      stateDir: f.stateDir,
      activatedAt: "2026-09-21T00:00:00.000Z",
    },
    null,
    2,
  )}\n`;
}

async function readText(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

function parseSettings(text: string): Record<string, unknown> {
  const parsed = Bun.YAML.parse(text) as unknown;
  return parsed as Record<string, unknown>;
}

/**
 * stub 與配接器必須是同一份模組：比對 default 匯出的模組身分，而不是檔案字串。
 *
 * 這裡刻意使用動態匯入：stub 是由受測 CLI 在執行期產生到臨時目錄的檔案，作者
 * 時間不可能以靜態匯入表示，而載入結果本身就是被驗證的邊界。
 */
async function importDefault(path: string): Promise<unknown> {
  const module = (await import(path)) as { default?: unknown };
  return module.default;
}

/**
 * OMP 對 `.omp/extensions` 的原生擴充掃描，也就是擴充模組 provider 內部實際跑的
 * 那一段（`globIf` 帶 gitignore:true）。該函式的 `ctx` 參數未被使用，因此這裡傳
 * 入空物件；呼叫真實套件而不是自製掃描，才能如實反映 gitignore 過濾。
 */
async function scanProjectExtensions(root: string): Promise<string[]> {
  return await discoverExtensionModulePaths({} as never, join(root, ".omp", "extensions"));
}

/** 把設定檔裡真正生效的 `extensions` 清單交給 OMP 的解析器，看它會載入什麼。 */
async function resolveConfiguredExtensions(entries: string[], root: string): Promise<string[]> {
  return await discoverExtensionPaths(entries, root, undefined, { ambient: false });
}

async function writeAlternativeAdapter(f: Fixture): Promise<string> {
  const path = join(dirname(f.root), "omp-memory-alt.js");
  await writeFile(path, "export default function alternativeAdapter() {}\n");
  return path;
}

describe("setup-omp dry run", () => {
  test("validates without writing and never prints the token value", async () => {
    const f = await fixture(
      '# keep me\ntask:\n  agentModelOverrides:\n    trellis-check: "@slow"\n',
    );
    try {
      const run = await runSetup(baseArgs(f));
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("dry-run");
      expect(run.stdout).toContain("未寫入任何檔案");
      expect(run.stdout).toContain(f.root);
      expect(`${run.stdout}${run.stderr}`).not.toContain(TOKEN_VALUE);
      expect(await exists(join(f.root, ".omp", "siyuan-memory.json"))).toBe(false);
      expect(await exists(join(f.root, ".omp", "extensions", "siyuan-memory.ts"))).toBe(false);
      expect(await exists(f.stateDir)).toBe(false);
      expect(await readText(join(f.root, ".omp", "config.yml"))).toBe(
        '# keep me\ntask:\n  agentModelOverrides:\n    trellis-check: "@slow"\n',
      );
    } finally {
      await f.cleanup();
    }
  });
});

describe("setup-omp apply", () => {
  test("writes config and stub without touching memory ownership or leaking the secret", async () => {
    const f = await fixture(
      '# Project-scoped dispatch bindings for Trellis task agents.\ntask:\n  agentModelOverrides:\n    trellis-implement: "@task"\nmodelRoles:\n  default: "@slow"\n',
    );
    try {
      await writeFile(f.globalConfig, "disabledExtensions:\n  - skill:globally-disabled\n");
      const run = await runSetup(baseArgs(f, ["--apply"]));
      expect(run.code).toBe(0);
      expect(`${run.stdout}${run.stderr}`).not.toContain(TOKEN_VALUE);

      const config = JSON.parse(
        await readText(join(f.root, ".omp", "siyuan-memory.json")),
      ) as Record<string, unknown>;
      expect(config.schemaVersion).toBe(1);
      expect(config.enabled).toBe(true);
      expect(config.projectId).toBe("siyuan-agent-system");
      expect(config.projectRoot).toBe(f.root);
      expect(config.serviceUrl).toBe("http://127.0.0.1:18787");
      expect(config.tokenFile).toBe(f.token);
      expect(config.stateDir).toBe(f.stateDir);
      expect(Number.isFinite(Date.parse(String(config.activatedAt)))).toBe(true);
      expect((await stat(join(f.root, ".omp", "siyuan-memory.json"))).mode & 0o777).toBe(0o600);

      // stub 必須真正載入本次驗證的配接器：fixture 的配接器位於專案外，先前的相對
      // 路徑會解析到專案內而載入失敗。
      expect(await importDefault(f.stubPath)).toBe(await importDefault(f.adapter));
      expect((await stat(f.stateDir)).isDirectory()).toBe(true);
      expect((await stat(f.stateDir)).mode & 0o777).toBe(0o700);

      const settings = parseSettings(await readText(join(f.root, ".omp", "config.yml")));
      expect(settings.task).toEqual({ agentModelOverrides: { "trellis-implement": "@task" } });
      expect(settings.modelRoles).toEqual({ default: "@slow" });
      // 安裝器不寫任何 Hindsight 設定：原檔沒有這個鍵，安裝後也不該冒出來。
      expect(settings.hindsight).toBeUndefined();
      // 專案層 disabledExtensions 是整份覆蓋語意，繼承來的全域項目必須帶上；安裝器
      // 自己不新增任何停用項目（jev-memory-gate 的停用狀態不是它的事）。
      expect(settings.disabledExtensions).toEqual(["skill:globally-disabled"]);
      expect(settings.extensions).toEqual([f.stubPath]);
      expect(await readText(join(f.root, ".omp", "config.yml"))).toContain(
        "# Project-scoped dispatch bindings for Trellis task agents.",
      );
    } finally {
      await f.cleanup();
    }
  });

  test("binds the stub to the adapter path it actually verified", async () => {
    const f = await fixture();
    try {
      expect((await runSetup(baseArgs(f, ["--apply"]))).code).toBe(0);
      const generated = await readText(f.stubPath);
      const configBefore = await readText(f.configPath);

      // 既有 stub 若解析到同一個配接器（例如相對形式），不算繫結變更，不需 --reconfigure。
      const relativeSpecifier = relative(dirname(f.stubPath), f.adapter).split(sep).join("/");
      await writeFile(
        f.stubPath,
        generated.replace(JSON.stringify(f.adapter), JSON.stringify(relativeSpecifier)),
      );
      const equivalent = await readText(f.stubPath);
      const kept = await runSetup(baseArgs(f));
      expect(kept.code).toBe(0);
      expect(await readText(f.stubPath)).toBe(equivalent);

      // 換一個配接器時不得默默沿用舊繫結：先要求 --reconfigure，且不動任何檔案。
      const alternative = await writeAlternativeAdapter(f);
      const swapped = baseArgs(f, ["--apply"]).map((value) =>
        value === f.adapter ? alternative : value,
      );
      const refused = await runSetup(swapped);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("stub_requires_reconfigure");
      expect(await readText(f.stubPath)).toBe(equivalent);
      expect(await readText(f.configPath)).toBe(configBefore);

      const applied = await runSetup(
        baseArgs(f, ["--apply", "--reconfigure"]).map((value) =>
          value === f.adapter ? alternative : value,
        ),
      );
      expect(applied.code).toBe(0);
      expect(await importDefault(f.stubPath)).toBe(await importDefault(alternative));
      const config = JSON.parse(await readText(f.configPath)) as Record<string, string>;
      expect(config.projectId).toBe("siyuan-agent-system");
      expect(config.tokenFile).toBe(f.token);
    } finally {
      await f.cleanup();
    }
  });

  test("rejects a stale or unverifiable adapter against its content manifest", async () => {
    const f = await fixture();
    try {
      const manifestPath = join(dirname(f.adapter), MANIFEST_NAME);
      const sourceRel = "scripts/build.ts";
      const sourceHash = await hashFile(join(REPO_ROOT, sourceRel));
      const base = {
        schemaVersion: 1,
        entry: "integrations/omp/index.ts",
        root: REPO_ROOT,
        artifact: { file: "omp-memory.js", sha256: await hashFile(f.adapter) },
      };
      await writeFile(
        manifestPath,
        `${JSON.stringify({ ...base, inputs: { [sourceRel]: sourceHash } }, null, 2)}\n`,
      );
      const current = await runSetup(baseArgs(f));
      expect(current.code).toBe(0);

      // 來源內容已改變：舊 bundle 不得再被當成可用。
      await writeFile(
        manifestPath,
        `${JSON.stringify({ ...base, inputs: { [sourceRel]: "0".repeat(64) } }, null, 2)}\n`,
      );
      const stale = await runSetup(baseArgs(f));
      expect(stale.code).toBe(1);
      expect(stale.stderr).toContain("adapter_stale");
      expect(stale.stderr).toContain(sourceRel);

      // 專案內的 artifact 沒有 manifest 就無法證明新鮮度，必須拒絕。
      const unverifiable = baseArgs(f).map((value) =>
        value === f.adapter ? join(REPO_ROOT, "package.json") : value,
      );
      const refused = await runSetup(unverifiable);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("adapter_manifest_missing");
    } finally {
      await f.cleanup();
    }
  });

  test("preserves user keys, comments, active Hindsight values, and existing disabled entries", async () => {
    const f = await fixture(
      [
        "task:",
        "  agentModelOverrides:",
        '    trellis-research: "@smol"',
        "hindsight:",
        "  autoRecall: true # intentionally noted",
        "  autoRetain: true",
        "  mentalModelsEnabled: true",
        "  scoping: per-project",
        "disabledExtensions:",
        "  - skill:existing",
        `  - ${GATE_EXTENSION_ID}`,
        "",
      ].join("\n"),
    );
    try {
      const run = await runSetup(baseArgs(f, ["--apply"]));
      expect(run.code).toBe(0);
      const text = await readText(join(f.root, ".omp", "config.yml"));
      // Hindsight 仍啟用時必須安裝成功，且原值（含行內註解）逐字保留。
      expect(text).toContain("  autoRecall: true # intentionally noted\n");
      const settings = parseSettings(text);
      expect(settings.task).toEqual({ agentModelOverrides: { "trellis-research": "@smol" } });
      expect(settings.hindsight).toEqual({
        autoRecall: true,
        autoRetain: true,
        mentalModelsEnabled: true,
        scoping: "per-project",
      });
      // 既有停用項目（含 gate 的停用狀態）原樣保留，安裝器不新增自己的項目。
      expect(settings.disabledExtensions).toEqual(["skill:existing", GATE_EXTENSION_ID]);
      expect(settings.extensions).toEqual([f.stubPath]);
    } finally {
      await f.cleanup();
    }
  });

  test("installs while Hindsight and the Jev gate stay enabled, leaving global settings untouched", async () => {
    const f = await fixture(
      "hindsight:\n  autoRecall: true\n  autoRetain: true\n  mentalModelsEnabled: true\n",
    );
    try {
      const globalBefore =
        "hindsight:\n  autoRecall: true\n  autoRetain: true\n" +
        "  mentalModelsEnabled: true\ndisabledExtensions:\n  - skill:globally-disabled\n";
      await writeFile(f.globalConfig, globalBefore);

      const run = await runSetup(baseArgs(f, ["--apply"]), ACTIVE_MEMORY_ENV);
      expect(run.code).toBe(0);

      const settings = parseSettings(await readText(join(f.root, ".omp", "config.yml")));
      expect(settings.hindsight).toEqual({
        autoRecall: true,
        autoRetain: true,
        mentalModelsEnabled: true,
      });
      // 繼承的全域停用項目仍要帶進專案層（否則會被覆蓋語意丟掉），但僅止於此。
      expect(settings.disabledExtensions).toEqual(["skill:globally-disabled"]);
      // 全域設定一個位元組都不能被這個安裝器碰。
      expect(await readText(f.globalConfig)).toBe(globalBefore);
      // 安裝本身必須真的完成：stub 可載入、設定檔代表啟用。
      expect(await importDefault(f.stubPath)).toBe(await importDefault(f.adapter));
      expect(JSON.parse(await readText(f.configPath))).toMatchObject({ enabled: true });
    } finally {
      await f.cleanup();
    }
  });

  test("loads the gitignored stub only through its explicit extensions entry", async () => {
    const unignored = await fixture();
    const ignored = await fixture();
    try {
      // 對照組：沒有 .gitignore 時，原生掃描自己就會找到 stub。
      expect((await runSetup(baseArgs(unignored, ["--apply"]))).code).toBe(0);
      expect(await scanProjectExtensions(unignored.root)).toEqual([unignored.stubPath]);

      // 實機的形狀：stub 依設計是 gitignored，原生掃描因此看不到它。安裝若沒有把
      // stub 的絕對路徑寫進 extensions，「已啟用」就只是假就緒。
      await writeFile(join(ignored.root, ".gitignore"), `${STUB_RELATIVE}\n`);
      expect((await runSetup(baseArgs(ignored, ["--apply"]))).code).toBe(0);
      expect(await scanProjectExtensions(ignored.root)).toEqual([]);

      const settings = parseSettings(await readText(join(ignored.root, ".omp", "config.yml")));
      expect(settings.extensions).toEqual([ignored.stubPath]);
      // 顯式 configuredPaths 不受該掃描的 gitignore 限制：條目就是 stub 本身。
      expect(
        await resolveConfiguredExtensions(settings.extensions as string[], ignored.root),
      ).toEqual([ignored.stubPath]);
    } finally {
      await unignored.cleanup();
      await ignored.cleanup();
    }
  });

  test("carries inherited global extensions and never duplicates an equivalent stub entry", async () => {
    const localExtension = "/opt/local/ext.ts";
    const f = await fixture(
      `extensions:\n  - ${localExtension}\n  - ${STUB_RELATIVE}\ndisabledExtensions:\n  - skill:existing\n`,
    );
    try {
      const globalExtension = join(dirname(f.root), "global-ext.ts");
      await writeFile(globalExtension, "export default function globalExtension() {}\n");
      await writeFile(
        f.globalConfig,
        `extensions:\n  - ${globalExtension}\ndisabledExtensions:\n  - skill:globally-disabled\n`,
      );

      expect((await runSetup(baseArgs(f, ["--apply"]))).code).toBe(0);
      const settingsPath = join(f.root, ".omp", "config.yml");
      const first = await readText(settingsPath);
      // 專案層 extensions 是整份覆蓋語意：本機既有的絕對條目與相對 stub 條目
      // （以 cwd 解析後就是 stub）都保留、不被重複添加，繼承的全域項目也不能掉。
      const settings = parseSettings(first);
      expect(settings.extensions).toEqual([localExtension, STUB_RELATIVE, globalExtension]);
      expect(settings.disabledExtensions).toEqual(["skill:existing", "skill:globally-disabled"]);

      // 重跑不得重複註冊：bytes 完全相同即涵蓋順序與重複。
      expect((await runSetup(baseArgs(f, ["--apply"]))).code).toBe(0);
      expect(await readText(settingsPath)).toBe(first);
    } finally {
      await f.cleanup();
    }
  });

  test("handles single-line flow forms for every editable key", async () => {
    const f = await fixture(
      "hindsight: { scoping: per-project, autoRecall: true }\ndisabledExtensions: [skill:existing]\nextensions: [/opt/flow/ext.ts]\n",
    );
    try {
      const run = await runSetup(baseArgs(f, ["--apply"]));
      expect(run.code).toBe(0);
      const settings = parseSettings(await readText(join(f.root, ".omp", "config.yml")));
      // flow 形式的 hindsight 原封不動（連寫法都不必改寫），單行清單同理。
      expect(settings.hindsight).toEqual({ scoping: "per-project", autoRecall: true });
      expect(settings.disabledExtensions).toEqual(["skill:existing"]);
      expect(settings.extensions).toEqual(["/opt/flow/ext.ts", f.stubPath]);
    } finally {
      await f.cleanup();
    }
  });

  test("is idempotent for activation time, settings bytes, and queue content", async () => {
    const f = await fixture('task:\n  agentModelOverrides:\n    trellis-check: "@slow"\n');
    try {
      expect((await runSetup(baseArgs(f, ["--apply"]))).code).toBe(0);
      const firstConfig = await readText(join(f.root, ".omp", "siyuan-memory.json"));
      const firstSettings = await readText(join(f.root, ".omp", "config.yml"));
      const pending = join(f.stateDir, "pending.json");
      await writeFile(pending, '{"pending":true}\n');

      expect((await runSetup(baseArgs(f, ["--apply"]))).code).toBe(0);
      expect(await readText(join(f.root, ".omp", "siyuan-memory.json"))).toBe(firstConfig);
      expect(await readText(join(f.root, ".omp", "config.yml"))).toBe(firstSettings);
      expect(await readText(pending)).toBe('{"pending":true}\n');
    } finally {
      await f.cleanup();
    }
  });

  test("requires --reconfigure to change project scope, then resets the boundary", async () => {
    const f = await fixture();
    try {
      expect((await runSetup(baseArgs(f, ["--apply"]))).code).toBe(0);
      const original = JSON.parse(
        await readText(join(f.root, ".omp", "siyuan-memory.json")),
      ) as Record<string, string>;

      const refused = await runSetup(
        baseArgs(f, ["--apply"]).map((value) =>
          value === "siyuan-agent-system" ? "other-project" : value,
        ),
      );
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("scope_change_requires_reconfigure");
      expect(refused.stderr).toContain("--reconfigure");
      const unchanged = JSON.parse(
        await readText(join(f.root, ".omp", "siyuan-memory.json")),
      ) as Record<string, string>;
      expect(unchanged).toEqual(original);

      const applied = await runSetup(
        baseArgs(f, ["--apply", "--reconfigure"]).map((value) =>
          value === "siyuan-agent-system" ? "other-project" : value,
        ),
      );
      expect(applied.code).toBe(0);
      const next = JSON.parse(await readText(join(f.root, ".omp", "siyuan-memory.json"))) as Record<
        string,
        string
      >;
      expect(next.projectId).toBe("other-project");
      expect(Date.parse(String(next.activatedAt))).toBeGreaterThanOrEqual(
        Date.parse(String(original.activatedAt)),
      );
    } finally {
      await f.cleanup();
    }
  });

  test("refuses to move the activation boundary without --reconfigure", async () => {
    const f = await fixture();
    try {
      expect((await runSetup(baseArgs(f, ["--apply"]))).code).toBe(0);
      const run = await runSetup(
        baseArgs(f, ["--apply", "--activated-at", "2020-01-01T00:00:00.000Z"]),
      );
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("activation_boundary_locked");
    } finally {
      await f.cleanup();
    }
  });
});

describe("setup-omp refusals", () => {
  test("rejects relative paths, linked-out settings dirs, missing token, and missing adapter", async () => {
    const f = await fixture();
    try {
      const relative = await runSetup(
        baseArgs(f).map((value) => (value === f.root ? "relative/project" : value)),
      );
      expect(relative.code).not.toBe(0);
      expect(relative.stderr).toContain("project_not_absolute");

      const escaped = await mkdtemp(join(tmpdir(), "siyuan-outside-"));
      const linked = await fixture();
      try {
        await symlink(escaped, join(linked.root, ".omp"));
        const linkedRun = await runSetup(baseArgs(linked));
        expect(linkedRun.code).toBe(1);
        expect(linkedRun.stderr).toContain("path_escapes_project");
      } finally {
        await linked.cleanup();
        await rm(escaped, { recursive: true, force: true });
      }

      const missingToken = await runSetup(
        baseArgs(f).map((value) =>
          value === f.token ? join(f.root, "secrets", "absent.token") : value,
        ),
      );
      expect(missingToken.code).toBe(1);
      expect(missingToken.stderr).toContain("token_file_missing");

      const missingAdapter = await runSetup(
        baseArgs(f).map((value) => (value === f.adapter ? join(f.root, "absent.js") : value)),
      );
      expect(missingAdapter.code).toBe(1);
      expect(missingAdapter.stderr).toContain("adapter_missing");

      await writeFile(f.token, "", { mode: 0o600 });
      const emptyToken = await runSetup(baseArgs(f));
      expect(emptyToken.code).toBe(1);
      expect(emptyToken.stderr).toContain("token_file_empty");
    } finally {
      await f.cleanup();
    }
  });

  test("refuses an unexpected existing stub and leaves the project untouched", async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.root, ".omp", "extensions"), { recursive: true });
      const stub = join(f.root, ".omp", "extensions", "siyuan-memory.ts");
      await writeFile(stub, "export default function other() {}\n");
      const run = await runSetup(baseArgs(f, ["--apply"]));
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("stub_conflict");
      expect(await readText(stub)).toBe("export default function other() {}\n");
      expect(await exists(join(f.root, ".omp", "siyuan-memory.json"))).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  test("does not refuse or rewrite a project config that still enables Hindsight", async () => {
    const f = await fixture(
      "hindsight:\n  autoRecall: true\n  autoRetain: true\n  mentalModelsEnabled: true\n",
    );
    try {
      // 純 dry-run 與 --apply 都必須在 Hindsight 全開的專案上成功；失敗的唯一理由不
      // 再是「別的記憶擁有者還開著」。
      const dryRun = await runSetup(baseArgs(f), ACTIVE_MEMORY_ENV);
      expect(dryRun.code).toBe(0);
      expect(await exists(f.configPath)).toBe(false);

      const applied = await runSetup(baseArgs(f, ["--apply"]), ACTIVE_MEMORY_ENV);
      expect(applied.code).toBe(0);
      expect(await exists(f.configPath)).toBe(true);
      const settings = parseSettings(await readText(join(f.root, ".omp", "config.yml")));
      expect(settings.hindsight).toEqual({
        autoRecall: true,
        autoRetain: true,
        mentalModelsEnabled: true,
      });
    } finally {
      await f.cleanup();
    }
  });

  test("rejects invalid service urls and unusable settings yaml", async () => {
    const f = await fixture("- not\n- a\n- mapping\n");
    try {
      const badUrl = await runSetup(
        baseArgs(f).map((value) =>
          value === "http://127.0.0.1:18787/" ? "http://user:pass@127.0.0.1:18787" : value,
        ),
      );
      expect(badUrl.code).toBe(1);
      expect(badUrl.stderr).toContain("service_url_has_credentials");

      const badSettings = await runSetup(baseArgs(f));
      expect(badSettings.code).toBe(1);
      expect(badSettings.stderr).toContain("settings_not_mapping");
    } finally {
      await f.cleanup();
    }
  });

  test("refuses malformed extension lists instead of dropping them", async () => {
    const local = await fixture("extensions: not-a-list\n");
    const global = await fixture();
    try {
      const localRun = await runSetup(baseArgs(local));
      expect(localRun.code).toBe(1);
      expect(localRun.stderr).toContain("settings_extensions_invalid");

      await writeFile(global.globalConfig, "extensions: nope\n");
      const globalRun = await runSetup(baseArgs(global));
      expect(globalRun.code).toBe(1);
      expect(globalRun.stderr).toContain("global_extensions_invalid");
    } finally {
      await local.cleanup();
      await global.cleanup();
    }
  });
});

describe("setup-omp status", () => {
  test("reports not-activated, then ready, without disclosing the token", async () => {
    const f = await fixture();
    try {
      const before = await runSetup([
        "--project",
        f.root,
        "--global-config",
        f.globalConfig,
        "--status",
      ]);
      expect(before.code).toBe(1);
      expect(before.stdout).toContain("未設定");
      expect(`${before.stdout}${before.stderr}`).not.toContain(TOKEN_VALUE);

      expect((await runSetup(baseArgs(f, ["--apply"]))).code).toBe(0);
      const after = await runSetup([
        "--project",
        f.root,
        "--global-config",
        f.globalConfig,
        "--adapter",
        f.adapter,
        "--status",
      ]);
      expect(after.code).toBe(0);
      expect(after.stdout).toContain("就緒");
      expect(after.stdout).toContain("siyuan-agent-system");
      expect(after.stdout).toContain("http://127.0.0.1:18787");
      expect(`${after.stdout}${after.stderr}`).not.toContain(TOKEN_VALUE);
    } finally {
      await f.cleanup();
    }
  });

  test("reports degraded when the built adapter is gone", async () => {
    const f = await fixture();
    try {
      expect((await runSetup(baseArgs(f, ["--apply"]))).code).toBe(0);
      await rm(f.adapter);
      const run = await runSetup([
        "--project",
        f.root,
        "--global-config",
        f.globalConfig,
        "--status",
        "--adapter",
        f.adapter,
      ]);
      expect(run.code).toBe(1);
      expect(run.stdout).toContain("降級");
      expect(run.stdout).toContain("adapter_missing");
    } finally {
      await f.cleanup();
    }
  });

  test("reports degraded when the generated stub points at a removed adapter", async () => {
    const f = await fixture();
    try {
      expect((await runSetup(baseArgs(f, ["--apply"]))).code).toBe(0);
      await rm(f.adapter);
      // 不帶 --adapter：只靠 stub 自己宣告的載入路徑就要能發現問題。
      const run = await runSetup([
        "--project",
        f.root,
        "--global-config",
        f.globalConfig,
        "--status",
      ]);
      expect(run.code).toBe(1);
      expect(run.stdout).toContain("降級");
      expect(run.stdout).toContain("adapter_missing");
      // 報告的必須是 stub 繫結的那個已消失檔案，而不是別的預設路徑（fixture 目錄獨一無二）。
      expect(run.stdout).toContain(basename(dirname(f.adapter)));
    } finally {
      await f.cleanup();
    }
  });

  test("reports degraded when the stub exists but is no longer registered", async () => {
    const f = await fixture();
    try {
      expect((await runSetup(baseArgs(f, ["--apply"]))).code).toBe(0);
      const settingsPath = join(f.root, ".omp", "config.yml");
      // 只移除註冊：stub 檔仍在，但 OMP 不會載入它——這正是假就緒。
      await writeFile(
        settingsPath,
        ["task:", "  agentModelOverrides:", '    trellis-check: "@slow"', ""].join("\n"),
      );
      const run = await runSetup([
        "--project",
        f.root,
        "--global-config",
        f.globalConfig,
        "--adapter",
        f.adapter,
        "--status",
      ]);
      expect(run.code).toBe(1);
      expect(run.stdout).toContain("降級");
      expect(run.stdout).toContain("stub_not_registered");
      expect(await exists(f.stubPath)).toBe(true);

      // 重新安裝會補回註冊並讓狀態回到就緒。
      expect((await runSetup(baseArgs(f, ["--apply"]))).code).toBe(0);
      const again = await runSetup([
        "--project",
        f.root,
        "--global-config",
        f.globalConfig,
        "--adapter",
        f.adapter,
        "--status",
      ]);
      expect(again.code).toBe(0);
      expect(again.stdout).toContain("就緒");
      expect(again.stdout).toContain("已顯式註冊 stub");
    } finally {
      await f.cleanup();
    }
  });

  test("stays ready while Hindsight and the Jev gate remain enabled", async () => {
    const f = await fixture();
    try {
      expect((await runSetup(baseArgs(f, ["--apply"]))).code).toBe(0);
      const settingsPath = join(f.root, ".omp", "config.yml");
      // 使用者（或 OMP 本身）保有自動記憶擁有權時，本配接器的狀態不因此降級：它只
      // 負責知識發布，註冊仍在就代表就緒。
      await writeFile(
        settingsPath,
        [
          "hindsight:",
          "  autoRecall: true",
          "  autoRetain: true",
          "  mentalModelsEnabled: true",
          "disabledExtensions:",
          `  - ${GATE_EXTENSION_ID}`,
          "extensions:",
          `  - ${f.stubPath}`,
          "",
        ].join("\n"),
      );
      const run = await runSetup(
        [
          "--project",
          f.root,
          "--global-config",
          f.globalConfig,
          "--adapter",
          f.adapter,
          "--status",
        ],
        ACTIVE_MEMORY_ENV,
      );
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("就緒");
      expect(run.stdout).toContain("不主張");
    } finally {
      await f.cleanup();
    }
  });
});

/**
 * 預設全域設定檔必須跟著原生 OMP 18.2.3 的規則走：agent 目錄下的 config.yml，
 * 不存在時用 config.yaml；agent 目錄由 PI_CODING_AGENT_DIR 或 OMP_PROFILE 決定。
 * 這幾項都用暫時的 HOME／agent 目錄隔離，不會碰到真正的使用者設定。
 */
describe("setup-omp native global config path", () => {
  test("falls back to config.yaml, then prefers config.yml once it exists", async () => {
    const f = await fixture();
    const home = await mkdtemp(join(tmpdir(), "siyuan-home-"));
    try {
      const agentDir = join(home, ".omp", "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "config.yaml"), "disabledExtensions:\n  - skill:from-yaml\n");

      const yamlOnly = await runSetup(argsUsingNativeGlobalConfig(f, ["--apply"]), { HOME: home });
      expect(yamlOnly.code).toBe(0);
      const settingsPath = join(f.root, ".omp", "config.yml");
      expect(parseSettings(await readText(settingsPath)).disabledExtensions).toEqual([
        "skill:from-yaml",
      ]);

      // 兩份都存在時，原生設定載入器讀的是 config.yml（MAIN_CONFIG_FILENAMES 的第一項）。
      await writeFile(join(agentDir, "config.yml"), "disabledExtensions:\n  - skill:from-yml\n");
      await rm(settingsPath);
      const bothPresent = await runSetup(argsUsingNativeGlobalConfig(f, ["--apply"]), {
        HOME: home,
      });
      expect(bothPresent.code).toBe(0);
      expect(parseSettings(await readText(settingsPath)).disabledExtensions).toEqual([
        "skill:from-yml",
      ]);
    } finally {
      await f.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  });

  test("honors PI_CODING_AGENT_DIR as the global agent directory", async () => {
    const f = await fixture();
    const agentDir = await mkdtemp(join(tmpdir(), "siyuan-agent-"));
    try {
      await writeFile(
        join(agentDir, "config.yaml"),
        "disabledExtensions:\n  - skill:agent-dir-only\n",
      );
      const run = await runSetup(argsUsingNativeGlobalConfig(f, ["--apply"]), {
        PI_CODING_AGENT_DIR: agentDir,
      });
      expect(run.code).toBe(0);
      const settings = parseSettings(await readText(join(f.root, ".omp", "config.yml")));
      expect(settings.disabledExtensions).toEqual(["skill:agent-dir-only"]);
    } finally {
      await f.cleanup();
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  test("reads the named profile's agent directory and not the default profile's", async () => {
    const f = await fixture();
    const home = await mkdtemp(join(tmpdir(), "siyuan-home-"));
    try {
      const profile = "siyuan-native-check";
      const profileAgent = join(home, ".omp", "profiles", profile, "agent");
      const defaultAgent = join(home, ".omp", "agent");
      await mkdir(profileAgent, { recursive: true });
      await mkdir(defaultAgent, { recursive: true });
      await writeFile(
        join(profileAgent, "config.yaml"),
        "disabledExtensions:\n  - skill:profile-only\n",
      );
      await writeFile(
        join(defaultAgent, "config.yml"),
        "disabledExtensions:\n  - skill:default-only\n",
      );

      const run = await runSetup(argsUsingNativeGlobalConfig(f, ["--apply"]), {
        HOME: home,
        OMP_PROFILE: profile,
      });
      expect(run.code).toBe(0);
      const settings = parseSettings(await readText(join(f.root, ".omp", "config.yml")));
      expect(settings.disabledExtensions).toEqual(["skill:profile-only"]);
    } finally {
      await f.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  });

  test("refuses without --global-config when the profile value cannot be trusted", async () => {
    const f = await fixture();
    const home = await mkdtemp(join(tmpdir(), "siyuan-home-"));
    try {
      const agentDir = join(home, ".omp", "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "config.yml"), "disabledExtensions:\n  - skill:untouchable\n");

      const run = await runSetup(argsUsingNativeGlobalConfig(f, ["--apply"]), {
        HOME: home,
        OMP_PROFILE: "Not a Profile",
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("global_config_profile_invalid");
      expect(run.stderr).toContain("--global-config");
      // fail-closed：沒有可靠的 profile 就不得讀預設 agent 目錄後照樣覆蓋專案層陣列。
      expect(await exists(join(f.root, ".omp", "config.yml"))).toBe(false);
      expect(await exists(f.configPath)).toBe(false);
    } finally {
      await f.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  });
});

/** 服務來源與權杖上限：安裝器與 runtime 共用同一組判準，兩端都不接受寬鬆寫法。 */
describe("setup-omp service origin and token bounds", () => {
  test("rejects a service url with a path, and refuses a config that contains one", async () => {
    const f = await fixture();
    try {
      for (const bad of ["http://127.0.0.1:18787/api", "http://127.0.0.1:18787/api/"]) {
        const run = await runSetup(
          baseArgs(f).map((value) => (value === "http://127.0.0.1:18787/" ? bad : value)),
        );
        expect(run.code).toBe(1);
        expect(run.stderr).toContain("service_url_not_origin");
        expect(await exists(f.configPath)).toBe(false);
      }

      // 舊版安裝留下的帶路徑來源：status 不得把它當成可用的啟用設定（假就緒）。
      const stale = memoryConfig(f, "http://127.0.0.1:18787/api");
      await mkdir(join(f.root, ".omp"), { recursive: true });
      await writeFile(f.configPath, stale);
      const status = await runSetup([
        "--project",
        f.root,
        "--global-config",
        f.globalConfig,
        "--adapter",
        f.adapter,
        "--status",
      ]);
      expect(status.code).toBe(1);
      expect(status.stdout).toContain("config_invalid");
      expect(status.stdout).toContain("未啟用");

      // apply 也必須拒絕這份設定，而不是默默改成別的來源。
      const apply = await runSetup(baseArgs(f, ["--apply"]));
      expect(apply.code).toBe(1);
      expect(apply.stderr).toContain("config_invalid");
      expect(await readText(f.configPath)).toBe(stale);
    } finally {
      await f.cleanup();
    }
  });

  test("enforces the runtime 8192-byte token bound in apply and status", async () => {
    const f = await fixture();
    try {
      await writeFile(f.token, "x".repeat(8193), { mode: 0o600 });
      const oversized = await runSetup(baseArgs(f, ["--apply"]));
      expect(oversized.code).toBe(1);
      expect(oversized.stderr).toContain("token_file_too_large");
      expect(await exists(f.configPath)).toBe(false);

      // 邊界：剛好 8192 位元組仍是 runtime 讀得下的權杖。
      await writeFile(f.token, "x".repeat(8192), { mode: 0o600 });
      expect((await runSetup(baseArgs(f, ["--apply"]))).code).toBe(0);

      // 安裝後權杖被換成超大檔：status 必須降級而不是維持就緒。
      await writeFile(f.token, "x".repeat(8193), { mode: 0o600 });
      const status = await runSetup([
        "--project",
        f.root,
        "--global-config",
        f.globalConfig,
        "--adapter",
        f.adapter,
        "--status",
      ]);
      expect(status.code).toBe(1);
      expect(status.stdout).toContain("token_file_too_large");
      expect(status.stdout).toContain("降級");
    } finally {
      await f.cleanup();
    }
  });
});

/** --status 的判準是 stub 實際繫結的 artifact，不是來源專案的預設建置輸出。 */
describe("setup-omp status adapter judgment", () => {
  test("judges the stub-bound adapter and rejects an explicitly different one", async () => {
    const f = await fixture();
    try {
      expect((await runSetup(baseArgs(f, ["--apply"]))).code).toBe(0);

      // 未指定 --adapter：只靠 stub 自己的繫結路徑就要能判定就緒。
      const bound = await runSetup([
        "--project",
        f.root,
        "--global-config",
        f.globalConfig,
        "--status",
      ]);
      expect(bound.code).toBe(0);
      expect(bound.stdout).toContain("已顯式註冊 stub");

      // 明確指定另一個（本身有效的）配接器：必須指出繫結不一致並降級。
      const alternative = await writeAlternativeAdapter(f);
      const mismatch = await runSetup([
        "--project",
        f.root,
        "--global-config",
        f.globalConfig,
        "--adapter",
        alternative,
        "--status",
      ]);
      expect(mismatch.code).toBe(1);
      expect(mismatch.stdout).toContain("stub_adapter_mismatch");
      expect(mismatch.stdout).toContain("降級");

      // 明確指定的就是繫結的那一個時，覆寫有效且維持就緒。
      const matching = await runSetup([
        "--project",
        f.root,
        "--global-config",
        f.globalConfig,
        "--adapter",
        f.adapter,
        "--status",
      ]);
      expect(matching.code).toBe(0);
      expect(matching.stdout).not.toContain("stub_adapter_mismatch");
    } finally {
      await f.cleanup();
    }
  });

  test("still inspects an explicitly named adapter when no stub is bound yet", async () => {
    const f = await fixture();
    try {
      const run = await runSetup([
        "--project",
        f.root,
        "--global-config",
        f.globalConfig,
        "--adapter",
        f.adapter,
        "--status",
      ]);
      expect(run.code).toBe(1);
      // 報告要指出實際被檢查的 artifact，而不是來源專案的預設路徑。
      expect(run.stdout).toContain(f.adapter);
      expect(run.stdout).toContain("stub_missing");
    } finally {
      await f.cleanup();
    }
  });
});
