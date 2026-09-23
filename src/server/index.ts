import { AppError } from "../contracts";
import { Worker } from "../pipeline/worker";
import { Store } from "../storage/store";
import { createApp } from "./app";
import { loadConfig, resolveGeneration } from "./config";

try {
  // 開機順序是契約的一部分：環境設定先解析（不合法即拒絕啟動），已保存的生成草稿再
  // 決定生效選擇，最後在任何工作被建立或執行之前凍結它。因此新工作的生成身分、執行中
  // 的 worker 與面板顯示的生效值三者一致，草稿要等下一次啟動才會生效。
  const environment = await loadConfig();
  const store = new Store(environment.dataDir);
  const config = resolveGeneration(environment, store.stagedGeneration()?.profile ?? null);
  store.activateGeneration(config.activeGeneration);
  const worker = new Worker(store, config);
  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    maxRequestBodySize: 33_000_000,
    idleTimeout: 120,
    fetch: createApp(config, store, worker),
  });
  worker.start();
  console.info(`SiYuan Agent System ready: ${config.publicOrigin}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await server.stop();
    await worker.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => {
    void stop();
  });
  process.on("SIGINT", () => {
    void stop();
  });
} catch (error) {
  console.error(
    error instanceof AppError ? error.message : "服務無法啟動，請檢查環境設定與資料目錄權限。",
  );
  process.exit(1);
}
