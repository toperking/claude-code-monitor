// 擴充功能主機：只做三件事——定時掃描本機 ~/.claude 的逐字稿（唯讀）、把快照送給畫面、處理設定變更。
// 不連網、不寫入任何檔案、不執行任何外部程式。
//
// 畫面有兩個出口，共用同一個 MonitorHub（同一個掃描器、同一個計時器）：
//   ① 左邊活動列的圖示 → 側邊欄裡的「本機監控」（WebviewView）
//   ② 命令「在編輯區開啟」→ 編輯區旁邊的較大面板（WebviewPanel）

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { TranscriptScanner } from './core/scanner';
import { MonitorSnapshot } from './core/types';

function claudeHome(): string {
  const configured = vscode.workspace.getConfiguration('claudeMonitor').get<string>('claudeHome', '').trim();
  return configured.length > 0 ? configured : path.join(os.homedir(), '.claude');
}

interface Target { webview: vscode.Webview; visible: () => boolean }

/** 掃描器與計時器的唯一擁有者；所有畫面（側邊欄、編輯區面板）都向它登記。 */
export class MonitorHub implements vscode.Disposable {
  private scanner: TranscriptScanner;
  private home: string;
  private timer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private last: MonitorSnapshot | undefined;
  private readonly targets = new Set<Target>();
  private readonly configSub: vscode.Disposable;

  constructor() {
    this.home = claudeHome();
    this.scanner = new TranscriptScanner(this.home);
    this.configSub = vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('claudeMonitor')) return;
      const home = claudeHome();
      if (home !== this.home) { this.home = home; this.scanner = new TranscriptScanner(home); this.last = undefined; }
      for (const t of this.targets) this.sendConfig(t);
      this.restartTimer();
      void this.refresh();
    });
  }

  /** 登記一個畫面；回傳的 Disposable 負責取消登記（最後一個畫面離開時停掉計時器）。 */
  attach(webview: vscode.Webview, visible: () => boolean): vscode.Disposable {
    const target: Target = { webview, visible };
    this.targets.add(target);
    const sub = webview.onDidReceiveMessage((m: { type?: string }) => {
      if (m.type !== 'ready') return;
      this.sendConfig(target);
      if (this.last) void webview.postMessage({ type: 'snapshot', snapshot: this.last }); // 先給最近一份，不用等下一輪掃描
      void this.refresh();
    });
    this.restartTimer();
    return {
      dispose: () => {
        sub.dispose();
        this.targets.delete(target);
        if (this.targets.size === 0 && this.timer) { clearInterval(this.timer); this.timer = undefined; }
      },
    };
  }

  /** 畫面從看不到變成看得到時，立刻更新一次。 */
  poke(): void { void this.refresh(); }

  private restartTimer(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.targets.size === 0) { this.timer = undefined; return; }
    const seconds = Math.min(30, Math.max(1, vscode.workspace.getConfiguration('claudeMonitor').get<number>('refreshSeconds', 2)));
    this.timer = setInterval(() => void this.refresh(), seconds * 1000);
  }

  private sendConfig(t: Target): void {
    const cfg = vscode.workspace.getConfiguration('claudeMonitor');
    void t.webview.postMessage({
      type: 'config', bubbles: cfg.get<boolean>('bubbles', true), freeIdle: cfg.get<boolean>('freeIdle', true),
      maxFps: Math.min(60, Math.max(10, cfg.get<number>('maxFps', 30))),
    });
  }

  /** 掃描一次並把快照送給「看得到的」畫面。上一輪還沒結束就跳過，不疊請求；沒有人看就不掃。 */
  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    const visible = [...this.targets].filter(t => t.visible());
    if (visible.length === 0) return;
    this.refreshing = true;
    try {
      await this.scanner.refresh();
      this.last = this.scanner.snapshot();
      for (const t of visible) await t.webview.postMessage({ type: 'snapshot', snapshot: this.last });
    } catch (err) {
      console.error('[claude-monitor] 掃描失敗', err);
    } finally {
      this.refreshing = false;
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.configSub.dispose();
    this.targets.clear();
  }
}

/** 兩個出口共用的 HTML：嚴格的內容安全政策，腳本只允許帶 nonce 的那一支，不載入任何外部網址。 */
function html(webview: vscode.Webview, root: vscode.Uri): string {
  const uri = (file: string): vscode.Uri => webview.asWebviewUri(vscode.Uri.joinPath(root, 'media', file));
  const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri('webview.css')}">
<title>Claude 本機監控</title>
</head>
<body>
<div id="app">
  <section id="usage" class="usage"></section>
  <div id="notice" class="notice" hidden></div>
  <div id="stage" class="stage"><canvas id="flow"></canvas></div>
  <footer>
    <span class="hint">點工具方塊展開最近 5 筆呼叫；滾輪縮放、拖曳平移、雙擊空白處還原。快取命中率 = 快取讀取 ÷ 全部輸入。「已用額度百分比」是 Anthropic 伺服器端資料，不在本機，所以不顯示。</span>
    <label><input type="checkbox" id="bubbles" checked> 說明泡泡</label>
  </footer>
  <div id="status"></div>
</div>
<script nonce="${nonce}" src="${uri('webview.js')}"></script>
</body>
</html>`;
}

/** 側邊欄的「本機監控」：點活動列的圖示就會顯示。 */
class SidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'claudeMonitor.view';
  constructor(private readonly hub: MonitorHub, private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    view.webview.html = html(view.webview, this.context.extensionUri);
    const attached = this.hub.attach(view.webview, () => view.visible);
    view.onDidChangeVisibility(() => { if (view.visible) this.hub.poke(); }, undefined, this.context.subscriptions);
    view.onDidDispose(() => attached.dispose());
  }
}

/** 編輯區旁邊較大的面板（流程圖比較看得清楚）。 */
class EditorPanel {
  private static current: EditorPanel | undefined;

  static show(hub: MonitorHub, context: vscode.ExtensionContext): void {
    if (EditorPanel.current) { EditorPanel.current.panel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel('claudeMonitor', 'Claude 本機監控', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true, // 切到別的分頁再回來，不用重建畫面與動畫狀態
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    EditorPanel.current = new EditorPanel(panel, hub, context);
  }

  private readonly disposables: vscode.Disposable[] = [];

  private constructor(private readonly panel: vscode.WebviewPanel, hub: MonitorHub, context: vscode.ExtensionContext) {
    panel.webview.html = html(panel.webview, context.extensionUri);
    this.disposables.push(
      hub.attach(panel.webview, () => panel.visible),
      panel.onDidChangeViewState(() => { if (panel.visible) hub.poke(); }),
      panel.onDidDispose(() => {
        EditorPanel.current = undefined;
        for (const d of this.disposables) d.dispose();
      }),
    );
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const hub = new MonitorHub();
  context.subscriptions.push(
    hub,
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, new SidebarProvider(hub, context), { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('claudeMonitor.show', () => vscode.commands.executeCommand('claudeMonitor.view.focus')),
    vscode.commands.registerCommand('claudeMonitor.open', () => EditorPanel.show(hub, context)),
  );

  // 狀態列右下角的小按鈕：點一下顯示側邊欄
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  item.text = '$(pulse) Claude Monitor';
  item.tooltip = '顯示 Claude Code 本機監控（只讀取本機 ~/.claude，不連網）';
  item.command = 'claudeMonitor.show';
  item.show();
  context.subscriptions.push(item);
}

export function deactivate(): void { /* 計時器與畫面由各自的 dispose 收尾 */ }
