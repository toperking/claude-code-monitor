# Claude / Codex 本機監控 0.3.0

VS Code 擴充版與 Windows WPF 桌面版同步監看兩種來源，不連網、不執行逐字稿中的程式。

## 路徑與來源

- Claude：既有 `~/.claude/projects/**/*.jsonl`。
- VS Code Codex：`claudeMonitor.codexHome` → `CODEX_HOME` → `~/.codex`，讀取其 `sessions/**/*.jsonl`；`claudeMonitor.codexEnabled=false` 可停用。
- Windows Codex：`Monitor__CodexHome` → `CODEX_HOME` → `~/.codex`。啟動前設環境變數；變更後重開程式。
- 只初始載入最近七天有更新的檔案。定期發現新檔、增量處理完整行；不完整行留到下一輪，超過 8 MiB 的單行跳過，不執行其中指令。
- 以 session_meta.id 或 rollout 檔名 UUID 辨識 session；session 與 call ID 加 `codex:` 命名空間。子代理 rollout 先當作獨立 session，沒有假設 Claude 的父子代理結構。

## 狀態對照

| 真實紀錄 | 狀態 |
| --- | --- |
| task_started，尚未 task_complete／turn_aborted | 回應中 |
| function_call／custom_tool_call 尚未配對 output | 執行工具中；15 秒未更新改顯示等待授權/執行中 |
| function_call_output／custom_tool_call_output | 工具完成；明確 isError／is_error／非零 exit_code 或程序退出碼標示失敗 |
| task_complete／turn_aborted | 當回合停止；無回傳呼叫標示未完成/已中止，不假造成功輸出 |
| 10 分鐘無可辨識活動 | 已結束（防止崩潰留下永久忙碌；超長無輸出任務可能暫時被判為已結束） |

Codex 逐字稿是實際觀察到的本機格式，並非穩定公開 API；未知事件忽略，不補造時間。工具回傳代表呼叫已回傳，不代表命令業務結果一定成功。Codex exec 容器內的多個巢狀呼叫只呈現 rollout 實際提供的外層呼叫。

兩邊用同一套流程圖與機甲動畫；來源標籤及模型名稱區分 Claude / Codex。掃描有延遲，不代表能觀察內部思考；畫面最多顯示現有設計容納的四個 session。Claude 的額度與用量維持原統計，卡片明確標示 Claude，不把 Codex 累積用量與新格式紀錄混加。

## 安裝與發佈

- VS Code：安裝 `claude-code-monitor-0.3.0.vsix`，既有視窗重新載入後生效；GitHub Release 與 Open VSX 沿用 toperking/claude-code-monitor。
- Windows：解壓 `ClaudeMonitor-win-x64-0.3.0.zip`，執行 `ClaudeMonitor.Desktop.exe`，self-contained，無需另裝 .NET。先關閉舊版（含通知區圖示）再開新版；單一執行個體機制不允許同時開兩版。
- RAG 本體、資料庫、帳號 token 與本機逐字稿不放入公開發佈包。
