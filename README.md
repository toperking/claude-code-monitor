# Claude/codex Monitor 本機監控（VS Code 外掛）

在 VS Code 裡同時監看 Claude Code 與 Codex 的本機任務、工具與機甲狀態：

- **同一張流程桌布**：Claude、Codex 各自的 session → 大腦主節點／子代理 → 工具方塊；大腦依模型首次出現順序排成單一清單，新模型一律接在下方，相同模型的 session 共用大腦。整張桌布共用縮放與拖曳平移。
- **動態大腦**：人類大腦側面輪廓、腦迴、小腦與腦幹，搭配神經脈衝、掃描與呼吸光效；旁邊僅顯示實際模型名稱，例如 `GPT-6.1 SOL`。
- **唯一一組裝甲手腳**：所有 AI 與子代理的結果都匯聚到同一組裝甲護臂／腿部，分別標示成功與失敗，關節與能量流具有動態科技風格；統計與摘要只顯示一次。
- **工具尾巴小標籤**：每個工具方塊右邊接幾張小卡，執行中橘色發光、剛成功綠色、剛失敗紅色，結束後自動淡出；最多 3 張，其餘以「+N」表示。
- **來源獨立**：各來源的模型、機甲、工具與忙碌狀態分開，同名工具不跨來源合併。用量卡片與固定額度提示列已移除。
- **說明泡泡**：工具開始、失敗、讀寫 `.md` 文件、撞到額度上限；大腦與子代理節點不再彈泡泡遮住模型名稱。
- **機器人**：每個來源有自己的超級機器人——有工具在跑就飛到自己的方塊旁側身出拳，成功歡呼、失敗受創，AI 停下來就坐下；沒事時自己隨機活動（可關閉）。

## 隱私

- 監控本身**只讀取**本機 `~/.claude/projects/**/*.jsonl` 與 `~/.codex/sessions/**/*.jsonl`（可在設定改路徑），**不連網**、不上傳。Codex 路徑預設優先採用 `CODEX_HOME`。
- 平常**不寫入任何檔案、不執行外部程式**。唯一的例外是下面的「RAG 資料庫位置」功能：只有你**主動執行「套用 RAG 資料庫位置」命令、並在跳出的確認視窗按下同意**，才會搬移資料庫檔案，並執行 `claude mcp remove／add-json` 修改 Claude Code 的使用者設定（`~/.claude.json`）。只改設定頁的欄位不會有任何動作。
- 為了這個功能，擴充功能會**唯讀**讀取 `~/.claude.json` 裡你指定名稱（預設 `local-rag`）的那一筆 MCP 註冊，其餘內容不讀取、不記錄。
- 泡泡與日誌會顯示工具命令與檔案路徑的前幾十個字，螢幕分享時請留意。

## 使用

- **活動列圖示**：左邊活動列（最左邊那排圖示）有一個機器人圖示，點它就會在側邊欄顯示監控。
- **狀態列按鈕**：右下角的 `Claude/codex Monitor` 也可以點，效果相同。
- **在編輯區開啟（較大）**：側邊欄標題列右上角的「↗」按鈕，或命令面板（`Ctrl+Shift+P`）執行 **Claude/codex Monitor: 在編輯區開啟（較大）**。側邊欄比較窄，流程圖會縮得很小；想看清楚就用這個。
- 想要更寬的側邊欄：把活動列的圖示拖到右側的「次要側邊欄」或下方的面板區。

Codex 依本機 rollout 的任務開始／完成／中止、工具呼叫／回傳更新狀態；子代理先顯示為獨立 session。沒有新活動超過 10 分鐘視為已結束，長時間無輸出的任務可能暫時被判為結束。Codex exec 內的巢狀工具只顯示逐字稿實際提供的外層呼叫。這是本機紀錄推算，無法觀察內部思考。

畫面可依快照中的來源名稱自動向下新增 AI 節點群；本版實際支援 Claude、Codex，其他 AI 仍需實作資料掃描器。

## 安裝

從 [GitHub Releases](https://github.com/toperking/claude-code-monitor/releases) 下載 VSIX，執行 VS Code 命令「Extensions: Install from VSIX」，安裝後重新載入視窗。也可在 Open VSX 搜尋 `toperking.claude-code-monitor`。

Windows 桌面版同一個 Release 附 `ClaudeMonitor-win-x64-0.5.8.zip`：解壓後執行 `ClaudeMonitor.Desktop.exe`，不需另外安裝 .NET。先關閉舊版（含通知區程式），再開新版。路徑以環境變數 `Monitor__ClaudeHome`、`Monitor__CodexHome` 覆寫，未設 Codex 路徑時採用 `CODEX_HOME` 或 `~/.codex`。桌面版也是唯讀本機紀錄，RAG 搬移需主動確認才執行。

設定齒輪新增「產生並安裝 RAG 技能」：只在已存在的 `~/.claude/` 或 `~/.codex/` 下安裝 `rag-mcp` 技能，產生 `rag-MCP.md` 並建立或連結 `SKILL.md`；不存在的 AI 資料夾會略過。桌面版的 RAG 設定視窗也有同名按鈕。此功能只安裝技能說明；使用 RAG 工具仍需另外註冊 MCP 伺服器。

| 操作 | 效果 |
| --- | --- |
| 點工具方塊 | 展開／收起最近 5 筆呼叫 |
| 滾輪 | 縮放 |
| 拖曳 | 平移 |
| 雙擊空白處 | 還原 |
| 「說明泡泡」勾選框 | 開關泡泡 |

## 設定

| 設定 | 預設 | 說明 |
| --- | --- | --- |
| `claudeMonitor.claudeHome` | （空） | Claude Code 資料夾；留空＝使用者目錄下的 `.claude` |
| `claudeMonitor.codexEnabled` | true | 同時監看 Codex；關閉後不掃描也不顯示 Codex |
| `claudeMonitor.codexHome` | （空） | Codex 資料夾（內含 sessions）；留空依序採用 CODEX_HOME、~/.codex |
| `claudeMonitor.refreshSeconds` | 2 | 重新掃描逐字稿的間隔（秒） |
| `claudeMonitor.bubbles` | true | 顯示說明泡泡 |
| `claudeMonitor.freeIdle` | true | 機器人沒事做時自己隨機活動；關閉＝只依真實事件動作 |
| `claudeMonitor.maxFps` | 30 | 流程圖每秒最多重畫幾張（10–60）。調低可減少 CPU／GPU 負擔；沒有 AI 在執行、畫面完全靜止時自動降到每秒 1 張 |

系統開啟「減少動態」時，不會產生粒子、泡泡與機器人。

### RAG 資料庫位置（選用）

如果你用本機 RAG（MCP 伺服器，預設註冊名稱 `local-rag`），可以改變資料庫放的位置。**不用手打路徑**：按畫面底部的**齒輪按鈕**（或側邊欄標題列的齒輪、或命令 **Claude/codex Monitor: RAG 資料庫設定**），選單裡：

- **選擇資料夾…**：跳出資料夾挑選器，點選資料夾後自動填入「資料夾\rag.db」（沿用原本的 .db 檔名）。這一步只是填路徑，**不會搬任何東西**。
- **套用 RAG 資料庫位置…**：顯示計畫並要你確認，同意後才搬移並重新註冊。
- **開啟設定頁**：在 VS Code 設定頁手動輸入（設定頁的說明裡也有可點的「選擇資料夾…」連結）。

相關設定：

| 設定 | 預設 | 說明 |
| --- | --- | --- |
| `claudeMonitor.ragDbPath` | （空） | 新位置的完整路徑，例如 `D:\RagData\rag.db`；留空＝預設的 `%LOCALAPPDATA%\LocalRag\rag.db` |
| `claudeMonitor.ragServerName` | `local-rag` | Claude Code 裡 RAG MCP 伺服器的名稱 |
| `claudeMonitor.ragClaudeCommand` | `claude` | 重新註冊時執行的 claude 命令；找不到時填完整路徑 |

執行「套用」（命令 **Claude/codex Monitor: 套用 RAG 資料庫位置（搬移並重新註冊）**）時，它會先顯示「從哪搬到哪」並要你確認，然後：

1. 把資料庫（含 `-wal`、`-shm` 與 `.bak` 備份資料夾）**剪下貼上**到新位置，舊位置不留檔案。跨磁碟時備份資料夾改用複製，核對檔案數與總大小一致才刪舊的；核對失敗會保留舊備份並提醒。
2. 重新註冊 MCP 伺服器（`RAG_DB` 環境變數），其餘註冊內容原樣保留。

資料庫本身是分層結構（索引層 `sources`、連結層 `chunks`、詳細層 `chunk_text`／`chunk_vectors`）；搬移只是整個檔案連同 `-wal`、`-shm` 與備份一起搬，不受結構影響。舊結構的資料庫不會被自動轉換。

安全設計：資料庫**使用中會拒絕並且什麼都不動**（先把檔案改名成 `.moving` 測試占用）；不接受網路路徑；目的地已有檔案不會覆蓋；不會自動建資料夾；任何一步失敗都會還原註冊與資料庫位置。套用後，已經開著的 Claude Code 對話要重新連線（`/mcp`）才會改用新位置；命令列工具 `RagCli` 要另外設定環境變數 `RAG_DB`。

## 限制

- 主畫面不顯示 token 用量、模型占比、快取命中率或固定額度提示列；真正撞到額度上限的事件仍可透過說明泡泡呈現。
- 這個外掛是 WPF 版（`Desktop/`）的 TypeScript 重寫，兩邊各自維護。

## 開發

```bash
npm install
npm test              # vitest
npm run build         # 建置 dist/extension.js 與 media/webview.js
npm run harness       # 開 http://localhost:5173/test/harness.html，用假資料在瀏覽器看畫面
npm run package       # 型別檢查 + 建置 + 打包成 .vsix
```

結構：`src/core/`（掃描器、模型、泡泡；與畫面無關）、`src/webview/`（Canvas 繪製與頁面）、`src/extension.ts`（面板與定時掃描）。

0.5.14：修正光點沒有走在輸出線上的問題。僅 VS Code 版。

0.5.13：標籤與說明泡泡串長時，成功手／失敗腳會往右讓開、消失後移回；泡泡文字太長以 ... 結尾；多張標籤自動縮窄。僅 VS Code 版。

0.5.12：尾巴小標籤顯示「讀取 檔名」「Screenshot」這類動作與對象，標籤加寬。僅 VS Code 版。

0.5.11：說明泡泡讓到尾巴小標籤之後，不再蓋住標籤。僅 VS Code 版。

0.5.10：尾巴小標籤不再蓋住連線，輸出連線改從標籤尾端接出。僅 VS Code 版。

0.5.9：工具方塊尾巴新增小標籤，顯示執行中（橘）與剛成功（綠 ✓）、剛失敗（紅 ✕）的呼叫，結束後淡出。僅 VS Code 版。

0.5.8：Windows 桌面版啟動畫面標題字樣縮小為 0.75 倍。

0.5.7：RAG 設定新增一鍵產生並安裝 `rag-MCP.md` 到 Claude Code 與 Codex 技能目錄；安裝技能不會修改 MCP 註冊或資料庫。

0.5.6：三個以上大腦時，共用的手、腳與呼叫摘要移到列表中間。

0.5.5：新模型在全域清單下方出現；看不見的歷史模型不佔空白列，少量工具時大腦的垂直間距縮小。

0.5.4：同來源切換到不同模型時顯示新的大腦；同模型的 session 共用大腦，舊大腦淡出後移除。

0.5.3：共用的手／腳（成功拳頭、失敗靴子）換位置時會慢慢滑過去，不再瞬間跳到新位置；系統設定「減少動態」時維持直接就位。

0.5.2：來源依首次出現順序由上往下排列，GPT/Codex 先出現時，Claude 接在下方，共用同一張桌布。
