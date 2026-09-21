# SiYuan 知識蒸餾控制面板

獨立的 Bun／SQLite 服務：匯入對話 → Ollama Cloud 抽取候選 → TypeSafe Jev 判斷 → 寫入指定的思源筆記本。附繁體中文網頁、候選審閱、專案心智卡、重試及受管區塊撤回。

生成角色固定使用 **Ollama Cloud `deepseek-v4.1-flash`**，包含摘錄與心智維護；不使用本機推論、不自動替換模型。Jev 使用 `jev-latest`，紀錄回應中的實際模型名稱。**這不是離線工具。**

## 啟動

需求：Docker Engine 與 Docker Compose；思源核心可從容器連線。已實測思源 v3.8.4。

1. 若尚無 `.env`，依 `.env.example` 建立，將權限設為 `0600`。不要覆蓋已有憑據的 `.env`。
2. 設定下列值；Key 不要貼進控制面板、來源資料或 Git。
3. 執行：

```sh
docker compose up --build -d
docker compose ps
```

預設開啟 <http://localhost:8787>。在「設定與操作」指定專案 ID、筆記本及受管根目錄，再到「匯入與來源」送入合成範例或你有權處理的對話。

| 環境變數 | 用途 |
| --- | --- |
| `OLLAMA_API_KEY` | Ollama Cloud Key |
| `TYPESAFE_API_KEY` | TypeSafe Jev Key |
| `SIYUAN_URL` | 後端可連到的思源 HTTP 根網址；本機服務可使用 `http://host.docker.internal:6806`，前提是思源接受該連線 |
| `SIYUAN_TOKEN` | 對應工作空間的 API Token |
| `SIYUAN_PUBLIC_URL` | 選填；瀏覽器可開啟的思源根網址。留空時使用 `siyuan://blocks/…` |
| `PORT` | 對外本機連接埠，預設 `8787` |
| `PUBLIC_ORIGIN` | 面板完整 origin，不含路徑或末尾 `/`。留空時 Compose 依 `PORT` 設為 `http://localhost:PORT`；若使用 `127.0.0.1`，必須明確設定相同 origin |
| `OMP_SESSIONS_DIR` | 選填；宿主機上一個明確授權的 OMP session 目錄，以唯讀方式掛載為 `/sources/omp` |

三個憑據也支援對應的 `_FILE` 變數，例如 `OLLAMA_API_KEY_FILE=/run/secrets/ollama-key`。`./secrets` 會唯讀掛載到 `/run/secrets`，檔案必須讓容器內 `bun` 使用者可讀；直接環境值優先於檔案。

Compose 只綁定 `127.0.0.1`。此版**沒有多使用者登入或權限系統**，不得直接公開到網際網路。需要遠端存取時，另行部署有驗證的安全入口。

## 匯入格式

- **通用對話 JSON**：完整範例見 [`examples/conversation.json`](examples/conversation.json)。頂層包含 `schemaVersion: 1`、`source`、`sourceSessionId`、`projectId`、`messages`；訊息包含 `sourceMessageId`、`parentId`、`role`、`timestamp`、`text`、`attachments`、`rawLocator`、`missing`、`truncated`。未知時間使用 `null`，不得編造。匯入表單的來源與專案設定是權威值。
- **文字／Markdown**：保留為明確未結構化的來源；不猜作者或時間。想要持續識別同一來源的新版本，請填入穩定的 session ID。
- **OMP JSONL**：範例見 [`examples/omp-session.jsonl`](examples/omp-session.jsonl)。可手動上傳，或在面板明確啟用 `/sources/omp` 與專案對應。只掃直屬普通 `.jsonl`，不遞迴、不跟隨符號連結。輪詢約每 15 秒一次，背景工作進行時會延後。沒有換行結尾的最後一筆須等寫完才採用。

網頁／API 單次內容上限為 8,000,000 個 UTF-16 單位，HTTP 請求上限 33 MB；目錄掃描每檔上限 64 MiB。長內容會分段，保留訊息 ID、原始位置、分段與截斷警告，不靜默丟棄尾段。附件只記錄位置及狀態，不進行附件辨識。

API 亦可送出 `POST /api/import`，JSON 欄位為 `format`（`conversation`／`text`／`omp`）、`content`、`projectId`、`source`，選填 `sourceSessionId`、`sourceLocator`。`content` 是原始檔案的字串，不是巢狀物件。必須使用與 `PUBLIC_ORIGIN` 一致的地址及 `Content-Type: application/json`。

## 操作流程

1. **概覽**：工作階段、實際錯誤、退避重試、來源健康。缺少憑據或供應商失敗會保留來源並顯示失敗，不產生假結果。
2. **候選審閱**：查看原文、引文及 Jev 各題回答。可修正候選後重新送 Jev，或僅封存。人工修改仍不能略過 Jev 的保留閘門。
3. **專案心智**：只引用同專案已保留且發布／去重確認的候選。保留修訂歷史；人工版本、衝突及無法安全合併的改動不會被生成結果靜默覆蓋。
4. **設定與操作**：目的地、政策、排除來源、遮蔽詞、操作回執與撤回。設定採版本檢查；跨分頁更新不覆蓋未送出的草稿。

相同來源版本重複匯入沿用既有工作。來源文字改變則保存新版本；想用新政策重新判斷，請按「重新處理」。修正會建立新的候選／工作並保留舊紀錄，不覆寫歷史。

## 寫入、重試與撤回的邊界

- 只在選定筆記本／受管根目錄內建立文件，或追加到本系統擁有、同專案的文件。每次追加都有獨立受管區塊，不整篇覆寫人工筆記。
- 寫入前保存操作及預留 ID。回應遺失時先查回該 ID；若結果仍不明，標示待確認並只做讀回重試，**不盲目重送**。
- 首次讀回會檢查身分、位置與全部來源屬性。思源會重新排版 Markdown；字面不同時，以思源 `md2html` 的語義結果核對，保留段落與程式碼空白。
- 撤回以首次保存的 Kramdown 與屬性逐字核對。內容已被改動就停止，只刪除未修改的受管區塊；文件與其他人工內容保留。
- **思源 API 沒有原子條件刪除。** 最後讀回與刪除間若有人同步修改，仍有競態；撤回時不要並行編輯該區塊。本版只允許單一服務實例使用同一資料目錄。
- `conflict` 是停止狀態，不會因重試就覆蓋遠端內容。無法證實成功或不存在的操作，需要人工核對，不提供危險的強制覆寫。

## 資料與安全

SQLite、原始快照與回執保存在 `agent-data` named volume；正常容器更新不會刪資料。**不要使用 `docker compose down -v`，除非確定要刪除全部匯入與狀態。** SQLite 備份應使用 online backup API；不能只複製正在寫入的主 DB 而漏掉 WAL。

原文與資料庫不是加密儲存，請保護宿主機與備份。已知憑據樣式及設定遮蔽詞會在送雲端前遮蔽，但這不是通用 DLP；來源 ID／位置不會被改寫。政策排除的來源不送雲端。對敏感資料有疑慮時不要匯入。

`.env*`（範例除外）、`secrets/`、`data/`、Trellis runtime 及建置依賴不進 Git／Docker build context。UI/API 只顯示提供者是否設定，不回傳提供者憑據。

## 開發與驗證

使用 Bun 1.3.14：

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
bun run lint
bun run start
```

本機模式另支援 `DATA_DIR`、`HOST`、逗號分隔的 `OMP_ALLOWED_ROOTS`；目錄白名單仍須在面板中明確啟用。

0.1.0 首版已完成真實雲端與隔離思源功能驗收；詳細證據見 [本輪實作紀錄](.trellis/tasks/09-21-siyuan-agent-system-v1/implement.md)。驗收只使用合成資料，不代表模型準確率、效能或成本基準測試。
