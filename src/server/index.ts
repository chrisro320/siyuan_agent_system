import { AppError } from "../contracts";
import { Worker } from "../pipeline/worker";
import { Store } from "../storage/store";
import { createApp } from "./app";
import { loadConfig } from "./config";

try {
  const config = await loadConfig();
  const store = new Store(config.dataDir);
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
