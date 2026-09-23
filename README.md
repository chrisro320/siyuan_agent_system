# SiYuan 對話知識整理與發布

獨立的 Bun／SQLite 服務，把獲准的新對話整理成**給人閱讀的思源筆記**：正常聊天 → 背景增量收集 → 設定的生成端點抽取候選 → TypeSafe Jev 判斷 → 發布到指定思源筆記本。**Hindsight 仍是 LLM 的主要自動記憶系統**；本服務不做每輪自動召回、不注入對話上下文、不維護另一套心智模型。需要時可以明確要求 AI 搜尋思源。繁體中文面板用於查看、修正與排障，其他客戶端可用通用 API 或手動匯入。

抽取可選 OpenAI 相容 API（`/chat/completions`）或原生 Ollama（`/api/chat`）；預設仍是 Antigravity 相容端點與 `gemini-3.7-flash-medium`。兩者共用本機輸出與引文驗證，不會在失敗時自動切換服務或模型。Jev 使用 `jev-latest`，維持獨立的發布否決權；即使生成端點在本機，**整條流程仍不是離線工具**。

## 啟動

需求：Docker Engine 與 Docker Compose；思源核心可從容器連線。已實測思源 v3.8.4。

1. 若尚無 `.env`，依 `.env.example` 建立，將權限設為 `0600`。不要覆蓋已有憑據的 `.env`。
2. 設定下列值；Key 不要貼進控制面板、來源資料或 Git。
3. 執行：

```sh
docker compose up --build -d
docker compose ps
```

預設開啟 <http://localhost:8787>。在「設定與操作」指定專案 ID、筆記本及受管根目錄。先用合成範例驗證目的地，再依下節啟用指定 OMP 專案；既有歷史不會因此自動補匯。

| 環境變數 | 用途 |
| --- | --- |
| `GENERATION_PROTOCOL` | 初次啟動的協定：`openai-compatible`（預設）或 `ollama`；未知協定會被拒絕 |
| `GENERATION_BASE_URL` | 初次啟動的端點基底網址，預設 `http://127.0.0.1:7861/antigravity/v1`；不得包含帳密、查詢或 fragment |
| `GENERATION_MODEL` | 初次啟動的模型 ID，預設 `gemini-3.7-flash-medium`；模型回報身分須與設定值一致 |
| `GENERATION_AUTH_MODE` | `bearer`（預設）或 `none`；`none` 僅允許 `127.0.0.0/8`、`[::1]` 等 loopback IP 字面端點，不送 Authorization |
| `GENERATION_API_KEY` | `bearer` 模式的伺服器端 Key；不要使用 OMP 的 OAuth 憑證 |
| `GENERATION_API_KEY_ORIGIN` | 選填；Key 被允許送達的精確 origin。留空綁定環境變數 `GENERATION_BASE_URL` 的 origin；面板切換到其他來源時，須在伺服器端明示相符 origin 和 Key，遠端 `bearer` 僅接受 HTTPS |
| `TYPESAFE_API_KEY` | TypeSafe Jev Key |
| `SIYUAN_URL` | 後端可連到的思源 HTTP 根網址；桌面思源只監聽本機時使用 `http://127.0.0.1:6806` |
| `SIYUAN_TOKEN` | 對應工作空間的 API Token |
| `SIYUAN_PUBLIC_URL` | 選填；瀏覽器可開啟的思源根網址。留空時使用 `siyuan://blocks/…` |
| `PORT` | 對外本機連接埠，預設 `8787` |
| `PUBLIC_ORIGIN` | 面板完整 origin，不含路徑或末尾 `/`。留空時 Compose 依 `PORT` 設為 `http://localhost:PORT`；若使用 `127.0.0.1`，必須明確設定相同 origin |
| `OMP_SESSIONS_DIR` | 選填；宿主機上一個明確授權的 OMP session 目錄，以唯讀方式掛載為 `/sources/omp` |
| `ADAPTER_TOKEN` / `ADAPTER_TOKEN_FILE` | 背景採集／按需搜尋專用 Bearer 權杖；直接值優先，未設定時介面不啟用 |
| `ADAPTER_PROJECTS` | 允許採集與搜尋的專案 ID，以逗號分隔；同時需要面板中的目的地設定 |

所有憑據也支援對應的 `_FILE` 變數，例如 `GENERATION_API_KEY_FILE=/run/secrets/generation-key`。`./secrets` 會唯讀掛載到 `/run/secrets`，檔案必須讓容器內 `bun` 使用者可讀；直接環境值優先於檔案。面板只能調整非秘密的協定、端點、模型及驗證模式，無法輸入或讀取 Key。`none` 模式即使環境中仍有 Key，也不會送出 Authorization。

既有 Ollama 安裝可在「設定與操作」選擇 `ollama`、`http://127.0.0.1:11434`、實際模型 ID 與 `none`，或由伺服器環境變數設定同一組初次啟動值；其他網址需依上表設定安全驗證及憑據來源。既有 `OLLAMA_API_KEY` 不再使用。面板儲存只留下「待生效」草稿，不會改變正在執行或新建立工作的生成端點；**重新啟動服務後**才啟用。切換後，先前未完成的工作（包含尚未開始抽取者）會停止並顯示 `generation_config_changed`；一般重試不會改送新端點，只能由使用者明確按「重新處理」建立新工作。舊候選與已驗證回條保留，不會自動重送或發布。

Compose 使用 Linux host networking，以便容器連線到僅監聽主機 `127.0.0.1:7861` 的生成服務。應用程式仍只監聽 `127.0.0.1`，此版**沒有多使用者登入或權限系統**，不得直接公開到網際網路。需要遠端存取時，另行部署有驗證的安全入口。

若桌面思源只監聽 `127.0.0.1:6806`，請把 `SIYUAN_URL` 設為 `http://127.0.0.1:6806`；host networking 不需透過 Docker bridge 的 `host.docker.internal`。正式與測試服務必須使用不同資料卷，不把測試工作佇列改指正式思源。

## 啟用 OMP 背景知識發布

需求：Bun 1.3.14；原生 OMP 已以 18.2.3 實測。服務端與轉接器使用同一個獨立權杖；以權限 `0600` 的檔案保存，勿使用生成模型／Jev／思源的憑據代替。Docker 的 `_FILE` 路徑必須是容器內可讀的掛載路徑。

1. 在服務端設定權杖與 `ADAPTER_PROJECTS`，在面板設定相同專案 ID 的目的地。
2. 在本程式目錄建置，再替目標專案安裝：

```sh
bun install --frozen-lockfile
bun run build
bun run setup-omp -- \
  --project /absolute/path/to/project \
  --project-id my-project \
  --service-url http://localhost:8787 \
  --token-file /absolute/path/to/adapter-token
```

先檢查 dry-run 輸出，再於同一命令加上 `--apply`。`--service-url` 必須與服務的 `PUBLIC_ORIGIN` 完全一致；`localhost` 與 `127.0.0.1` 不互換。生成的 stub 綁定此次驗證過的建置絕對路徑；移動安裝或更換 artifact 須重新建置並使用 `--reconfigure`。

3. **新開一個可保存的根 OMP 會話**，照常聊天。既有會話、子代理及 `--no-session` 不自動收集。只有通過 Jev 與政策的候選才會發布；待審或僅封存內容不作為已確認知識。
4. 以 `bun run setup-omp -- --project /absolute/path/to/project --status` 查看安裝狀態；會話內 `/siyuan-memory` 查看待送數量與降級原因。保留此既有狀態指令名稱，不代表本服務取代 Hindsight。

安裝器只註冊發布配接器，不修改或要求關閉 Hindsight／Jev 記憶閘門。它把 stub 的絕對路徑寫進專案 `extensions`（stub 為 gitignored，必須顯式註冊），保留角色綁定、既有與繼承的擴充清單、其他設定，不修改全域設定。設定檔為 `.omp/siyuan-memory.json`，耐久待送與已處理身分保存在 `.omp/siyuan-memory-state/`，皆不進 Git。舊版自動召回的狀態可保留原位升級：待送與已處理身分保留，舊注入快照不再使用。

停用時將該設定檔的 `enabled` 設為 `false`，並重新開啟 OMP；已在執行的會話不會熱更新設定。停用不影響 Hindsight，也不刪除思源內容或待送狀態。不要刪除狀態目錄或倒退 `activatedAt` 來重送歷史。若曾使用會停用 Hindsight 的舊版安裝器，應只還原那次部署新增的專案 override，不要覆蓋自己的設定或全域配置。

OMP 對顯式指定的擴充檔案不套用 `disabledExtensions` 過濾；請使用上述 `enabled: false` 停用本轉接器，不要只把它加入停用清單。

### 發布與按需搜尋的邊界

- 只採集原始 user／assistant 正文；不採集 system、thinking、工具輸出、子代理或保留的知識信封。附件只保留參照。
- 服務離線時聊天仍可繼續，待送資料留在本機；相同捕獲重送不重複建立工作。
- 普通聊天、啟動、續跑與重試不會自動向思源搜尋，也不改寫送往模型的上下文。
- 明確要求「從思源找……」時，AI 可呼叫 `siyuan_search(query, limit?, maxChars?)`。專案範圍來自設定，不接受模型指定其他專案。這是全文檢索，不是向量語意搜尋，也不是整個私人思源的無限制檢索。
- 搜尋只回傳本服務已確認、當前仍獲授權的受管筆記，附來源與思源連結。人工修改會回傳目前內容，撤回、衝突、待審或失去確認的內容不回傳。
- 搜尋結果作為不可信工具資料，總輸出上限 16,000 字元並保留來源；不生成心智卡、不注入新系統指令。待送佇列與已處理修訂身分有容量上限，達上限時顯示降級，不丟棄舊識別碼換取空間。

其他客戶端可用 `POST /api/capture` 與 `POST /api/search`，需 Bearer 權杖、允許的專案及一致的服務 origin。採集傳入 `schemaVersion: 1`、不可重用於不同內容的 `captureId`、`branchLeafId` 與通用 `conversation`；搜尋傳入 `projectId`、`query`，可選 `limit`／`maxChars`，回傳 `{ projectId, notes, truncated }`。舊 `/api/recall` 與心智卡 API 已退役，沒有相容別名。完整欄位以 [`src/contracts/index.ts`](src/contracts/index.ts) 為準。

## 匯入格式

- **通用對話 JSON**：完整範例見 [`examples/conversation.json`](examples/conversation.json)。頂層包含 `schemaVersion: 1`、`source`、`sourceSessionId`、`projectId`、`messages`；訊息包含 `sourceMessageId`、`parentId`、`role`、`timestamp`、`text`、`attachments`、`rawLocator`、`missing`、`truncated`。未知時間使用 `null`，不得編造。匯入表單的來源與專案設定是權威值。
- **文字／Markdown**：保留為明確未結構化的來源；不猜作者或時間。想要持續識別同一來源的新版本，請填入穩定的 session ID。
- **OMP JSONL**：範例見 [`examples/omp-session.jsonl`](examples/omp-session.jsonl)。可手動上傳，或在面板明確啟用 `/sources/omp` 與專案對應。只掃直屬普通 `.jsonl`，不遞迴、不跟隨符號連結。輪詢約每 15 秒一次，背景工作進行時會延後。沒有換行結尾的最後一筆須等寫完才採用。

網頁／API 單次內容上限為 8,000,000 個 UTF-16 單位，HTTP 請求上限 33 MB；目錄掃描每檔上限 64 MiB。長內容會分段，保留訊息 ID、原始位置、分段與截斷警告，不靜默丟棄尾段。附件只記錄位置及狀態，不進行附件辨識。

API 亦可送出 `POST /api/import`，JSON 欄位為 `format`（`conversation`／`text`／`omp`）、`content`、`projectId`、`source`，選填 `sourceSessionId`、`sourceLocator`。`content` 是原始檔案的字串，不是巢狀物件。必須使用與 `PUBLIC_ORIGIN` 一致的地址及 `Content-Type: application/json`。

## 操作流程

1. **概覽**：工作階段、實際錯誤、退避重試、來源健康。缺少憑據或供應商失敗會保留來源並顯示失敗，不產生假結果。
2. **候選審閱**：查看原文、引文及 Jev 各題回答。可修正候選後重新送 Jev，或僅封存。人工修改仍不能略過 Jev 的保留閘門。
3. **匯入與來源**：明確提供對話或文字，檢查來源範圍；正常啟用的 OMP 新會話不需要每次手動匯入。
4. **設定與操作**：目的地、政策、排除來源、遮蔽詞、生成供應商的待生效設定、操作回執與撤回。生成草稿和一般政策各用自己的版本檢查；跨分頁更新不覆蓋未送出的草稿。

相同來源版本重複匯入沿用既有工作。來源文字改變則保存新版本；想用新政策重新判斷，請按「重新處理」。修正會建立新的候選／工作並保留舊紀錄，不覆寫歷史。

## 寫入、重試與撤回的邊界

- 目錄固定為「受管根目錄 → 專案 → 主題 → 文章」；`decision` 等內容類型保留在候選資料中，不另建一層目錄。
- 只在選定筆記本／受管根目錄內建立文件，或追加到本系統擁有、同專案的文件。每次追加都有獨立受管區塊，不整篇覆寫人工筆記。
- 寫入前保存操作及預留 ID。回應遺失時先查回該 ID；若結果仍不明，標示待確認並只做讀回重試，**不盲目重送**。
- 首次讀回會檢查身分、位置與全部來源屬性。思源會重新排版 Markdown；字面不同時，以思源 `md2html` 的語義結果核對，保留段落與程式碼空白。
- 標準 Markdown 匯出若在粗體／斜體／刪除線旁補空白，會再用同一區塊的原生 `textmark` 表示核對，不刪除或忽略正文空白；未知格式仍停止確認。
- 撤回以首次保存的 Kramdown 與屬性逐字核對。內容已被改動就停止，只刪除未修改的受管區塊；文件與其他人工內容保留。
- 已驗證筆記可在原筆記本／受管範圍內整理搬移，保留原 ID、搜尋能力與逐字撤回檢查；不改寫歷史計畫或收據。搬出授權範圍則不再符合搜尋或撤回資格。
- **思源 API 沒有原子條件刪除。** 最後讀回與刪除間若有人同步修改，仍有競態；撤回時不要並行編輯該區塊。本版只允許單一服務實例使用同一資料目錄。
- `conflict` 是停止狀態，不會因重試就覆蓋遠端內容。無法證實成功或不存在的操作，需要人工核對，不提供危險的強制覆寫。

## 資料與安全

SQLite、原始快照與回執保存在 `agent-data` named volume；正常容器更新不會刪資料。**不要使用 `docker compose down -v`，除非確定要刪除全部匯入與狀態。** SQLite 備份應使用 online backup API；不能只複製正在寫入的主 DB 而漏掉 WAL。

原文與資料庫不是加密儲存，請保護宿主機與備份。已知憑據樣式及設定遮蔽詞會在送雲端前遮蔽，但這不是通用 DLP；來源 ID／位置不會被改寫。政策排除的來源不送雲端。對敏感資料有疑慮時不要匯入。

舊版留下的心智卡歷史列不會在升級時刪除，但不再有執行、編輯、生成或召回入口。原始對話、工作與寫入回執仍保存在服務端；「思源是知識目的地」不代表服務端不保存處理紀錄。

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

實機驗收、目前啟用範圍與歷史版本差異見 [本輪實作紀錄](.trellis/tasks/09-21-siyuan-agent-system-v1/implement.md)。舊版自動召回的驗收紀錄只作歷史證據，不代表目前仍啟用該機制。驗收不是模型準確率、效能或成本基準測試。
