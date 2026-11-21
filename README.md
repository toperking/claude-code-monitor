# Claude Code 本機監控（VS Code 外掛）

在 VS Code 裡即時看 Claude Code 正在做什麼：

- **即時流程圖**：session → AI 主節點 → 工具方塊（MCP 依伺服器合併、子代理各自一群）→ 成功輸出／失敗。
- **用量彙總**：近 5 小時、近 7 天的快取命中率、token 總量、模型占比。
- **說明泡泡**：工具開始、失敗、讀寫 `.md` 文件、子代理出現、AI 開始執行／閒置、撞到額度上限。
- **機器人**：一台超級機器人代表「AI 現在在做什麼」——有工具在跑就飛到那個方塊旁側身出拳，成功歡呼、失敗受創，AI 停下來就坐下；沒事時自己隨機活動（可關閉）。

## 隱私

- **只讀取**本機 `~/.claude/projects/**/*.jsonl`（可在設定改路徑）。
- **不連網**、不上傳、不寫入任何檔案、不執行外部程式。
- 泡泡與日誌會顯示工具命令與檔案路徑的前幾十個字，螢幕分享時請留意。

## 使用

- **活動列圖示**：左邊活動列（最左邊那排圖示）有一個機器人圖示，點它就會在側邊欄顯示監控。
- **狀態列按鈕**：右下角的 `Claude Monitor` 也可以點，效果相同。
- **在編輯區開啟（較大）**：側邊欄標題列右上角的「↗」按鈕，或命令面板（`Ctrl+Shift+P`）執行 **Claude Monitor: 在編輯區開啟（較大）**。側邊欄比較窄，流程圖會縮得很小；想看清楚就用這個。
- 想要更寬的側邊欄：把活動列的圖示拖到右側的「次要側邊欄」或下方的面板區。

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
| `claudeMonitor.refreshSeconds` | 2 | 重新掃描逐字稿的間隔（秒） |
| `claudeMonitor.bubbles` | true | 顯示說明泡泡 |
| `claudeMonitor.freeIdle` | true | 機器人沒事做時自己隨機活動；關閉＝只依真實事件動作 |
| `claudeMonitor.maxFps` | 30 | 流程圖每秒最多重畫幾張（10–60）。調低可減少 CPU／GPU 負擔；沒有 AI 在執行、畫面完全靜止時自動降到每秒 1 張 |

系統開啟「減少動態」時，不會產生粒子、泡泡與機器人。

## 限制

- 「已用額度百分比」與重置時間是 Anthropic 伺服器端資料，本機逐字稿裡沒有，所以**不顯示**；只有真的撞到上限時，才會顯示「已達上限、幾點重置」。
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
