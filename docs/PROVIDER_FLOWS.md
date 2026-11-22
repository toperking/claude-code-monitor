# 依 AI 來源分列流程圖

Windows 桌面版與 VS Code 版只有一張桌布、一個畫布：Claude 在第一列，Codex 在第二列；快照出現其他 `Provider`／`provider` 時，自動依首次出現順序向下新增節點群。所有來源共用背景、世界座標、縮放與拖曳平移，雙擊還原整張圖；點工具可展開。沒有分割面板或獨立視窗。

每個來源都有自己的 FlowModel，因此 session、主節點、模型文字、子代理、機甲、工具種類、粒子、輸出、成功／失敗統計、忙碌與淡出狀態完全獨立。相同名稱的工具不跨來源合併。沒有事件的來源列仍保留標題，圖形沿用原本的閒置淡出行為。

來源辨識依 session 的 provider，工具或子代理沿用其 session 的來源；工具缺少 session 時使用自身 provider。為相容既有紀錄，`codex:` session ID 視為 Codex，未指定來源的舊資料視為 Claude。Claude 的用量與額度事件只屬於 Claude，不複製到其他來源。

新增 AI 的資料接入仍需實作掃描器；掃描器只要在 session 與工具 DTO 填入一致的來源名稱，畫面會自動增加一列，不必另寫版面。Gemini 僅用於多來源測試，尚未新增 Gemini 掃描器。

實作位置：`Core/Flow/ProviderSnapshot.cs`、`vscode-extension/src/core/providerSnapshot.ts`。來源隔離測試：`Tests/ProviderFlowTests.cs`、`vscode-extension/test/providers.test.ts`。
