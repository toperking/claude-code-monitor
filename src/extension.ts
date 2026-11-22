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
import { CodexScanner } from './core/codexScanner';
import { MonitorSnapshot } from './core/types';
import { executeRagDb, planRagDb } from './ragdb/apply';
import { realRagDbDeps } from './ragdb/node';
import { dbFileInFolder } from './ragdb/plan';

function claudeHome(): string {
  const configured = vscode.workspace.getConfiguration('claudeMonitor').get<string>('claudeHome', '').trim();
  return configured.length > 0 ? configured : path.join(os.homedir(), '.claude');
}

function codexHome(): string {
  const configured = vscode.workspace.getConfiguration('claudeMonitor').get<string>('codexHome', '').trim();
  return configured || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

interface Target { webview: vscode.Webview; visible: () => boolean }

/** 掃描器與計時器的唯一擁有者；所有畫面（側邊欄、編輯區面板）都向它登記。 */
export class MonitorHub implements vscode.Disposable {
  private scanner: TranscriptScanner;
  private home: string;
  private codex = new CodexScanner(codexHome());
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
      const codex = codexHome();
      if (codex !== this.codex.home) { this.codex = new CodexScanner(codex); this.last = undefined; }
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
      if (m.type === 'openSettings') { void vscode.commands.executeCommand('claudeMonitor.ragMenu'); return; }
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
      const enabled = vscode.workspace.getConfiguration('claudeMonitor').get<boolean>('codexEnabled', true);
      if (enabled) await this.codex.refresh();
      const base = this.scanner.snapshot();
      this.last = enabled ? {
        ...base, codexHome: this.codex.home, codexHomeFound: this.codex.found,
        sessions: [...base.sessions, ...this.codex.snapshotSessions(base.at)].sort((a, b) => b.lastActivity - a.lastActivity),
        recentToolCalls: [...base.recentToolCalls, ...this.codex.snapshotCalls()].sort((a, b) => b.time - a.time).slice(0, 500),
      } : base;
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
<title>Claude / Codex 本機監控</title>
</head>
<body>
<div id="app">
  <div id="notice" class="notice" hidden></div>
  <div id="stage" class="stage"><canvas id="flow"></canvas></div>
  <footer>
    <span class="hint">點工具方塊展開最近 5 筆呼叫；滾輪縮放、拖曳平移、雙擊空白處還原。</span>
    <span class="tools">
      <button type="button" id="settings" class="icon-btn" title="RAG 資料庫設定" aria-label="RAG 資料庫設定">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/></svg>
      </button>
      <label><input type="checkbox" id="bubbles" checked> 說明泡泡</label>
    </span>
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
    const panel = vscode.window.createWebviewPanel('claudeMonitor', 'Claude / Codex 本機監控', vscode.ViewColumn.Beside, {
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

/**
 * 設定頁的「套用 RAG 資料庫位置」：規劃 → 一定要使用者在確認視窗按下去 → 搬資料庫並重新註冊 local-rag。
 * 這是整個擴充功能唯一會寫檔、會執行外部程式（claude）的地方，所以只在使用者明確按下確認時才動作。
 */
async function applyRagDb(log: vscode.OutputChannel): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('claudeMonitor');
  const name = (cfg.get<string>('ragServerName', 'local-rag') ?? '').trim() || 'local-rag';
  const input = cfg.get<string>('ragDbPath', '') ?? '';
  const claude = (cfg.get<string>('ragClaudeCommand', 'claude') ?? '').trim() || 'claude';
  const deps = realRagDbDeps(claude);

  const planned = await planRagDb(name, input, deps);
  if (!planned.ok) {
    log.appendLine(`[RAG 資料庫] 無法套用：${planned.reason}`);
    void vscode.window.showErrorMessage(`RAG 資料庫位置：${planned.reason}`);
    return;
  }
  const p = planned.plan;
  const confirm = '搬移並重新註冊';
  const choice = await vscode.window.showWarningMessage(
    `要把 RAG 資料庫搬到新位置，並重新註冊「${name}」嗎？`,
    {
      modal: true,
      detail: [
        `從：${p.oldPath}`,
        `到：${p.newPath}`,
        '',
        p.hasDb ? '會把資料庫（含 -wal、-shm 與 .bak 備份資料夾）剪下貼上到新位置，舊位置不留檔案。' : '舊位置沒有資料庫檔案，只會更新註冊。',
        `會執行 claude mcp remove／add-json 修改 Claude Code 的使用者設定（~/.claude.json）。`,
        '資料庫使用中會拒絕並且什麼都不動；任何一步失敗都會還原。',
      ].join('\n'),
    },
    confirm,
  );
  if (choice !== confirm) { log.appendLine('[RAG 資料庫] 使用者取消。'); return; }

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: '正在搬移 RAG 資料庫並重新註冊…' },
    () => executeRagDb(p, deps),
  );
  for (const line of result.messages) log.appendLine(`[RAG 資料庫] ${line}`);
  const text = result.messages.join('\n');
  if (result.ok) void vscode.window.showInformationMessage(text, { modal: false });
  else void vscode.window.showErrorMessage(text, { modal: true });
}

/**
 * 點一下就跳出「資料夾挑選器」：選好資料夾後，把「資料夾\rag.db」填進設定 claudeMonitor.ragDbPath，
 * 再問要不要現在套用。只是填路徑，還沒有搬任何東西；套用另外有確認視窗。
 */
async function pickRagDbFolder(log: vscode.OutputChannel): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('claudeMonitor');
  const current = (cfg.get<string>('ragDbPath', '') ?? '').trim();
  const start = current !== '' && path.isAbsolute(current) ? path.dirname(current) : undefined;
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
    openLabel: '選擇這個資料夾', title: '選擇 RAG 資料庫要放的資料夾',
    ...(start ? { defaultUri: vscode.Uri.file(start) } : {}),
  });
  const folder = picked?.[0]?.fsPath;
  if (!folder) return; // 使用者取消
  const file = dbFileInFolder(folder, current);
  await cfg.update('ragDbPath', file, vscode.ConfigurationTarget.Global);
  log.appendLine(`[RAG 資料庫] 新位置設為 ${file}（尚未套用，沒有搬移任何東西）`);
  const apply = '套用（搬移並重新註冊）';
  const choice = await vscode.window.showInformationMessage(`RAG 資料庫的新位置：${file}\n還沒有搬移，要現在套用嗎？`, apply, '稍後');
  if (choice === apply) await applyRagDb(log);
}

/** 設定按鈕（齒輪）點下去的選單：選資料夾、套用、開設定頁。 */
async function ragMenu(log: vscode.OutputChannel): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('claudeMonitor');
  const configured = (cfg.get<string>('ragDbPath', '') ?? '').trim();
  type Item = vscode.QuickPickItem & { run: () => Thenable<unknown> | Promise<unknown> };
  const items: Item[] = [
    { label: '$(folder) 選擇資料夾…', description: '跳出資料夾挑選器，選完自動填入路徑', run: () => pickRagDbFolder(log) },
    { label: '$(check) 套用 RAG 資料庫位置…', description: configured !== '' ? configured : '（尚未設定新位置）', detail: '先顯示計畫並要你確認，同意後才搬移資料庫並重新註冊', run: () => applyRagDb(log) },
    { label: '$(settings-gear) 開啟設定頁', run: () => vscode.commands.executeCommand('claudeMonitor.openRagSettings') },
  ];
  const choice = await vscode.window.showQuickPick(items, { title: 'RAG 資料庫設定', placeHolder: '選擇要做什麼' });
  await choice?.run();
}

export function activate(context: vscode.ExtensionContext): void {
  const hub = new MonitorHub();
  const ragLog = vscode.window.createOutputChannel('Claude Monitor');
  /** 命令的共同收尾：未預期的錯誤寫進輸出面板並提示，不讓命令靜悄悄失敗。 */
  const guarded = (fn: () => Promise<void>) => (): Promise<void> => fn().catch(err => {
    ragLog.appendLine(`[RAG 資料庫] 未預期的錯誤：${String(err)}`);
    void vscode.window.showErrorMessage(`RAG 資料庫位置：發生未預期的錯誤（${err instanceof Error ? err.message : String(err)}）`);
  });
  context.subscriptions.push(
    hub,
    ragLog,
    vscode.commands.registerCommand('claudeMonitor.openRagSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'claudeMonitor.rag')),
    vscode.commands.registerCommand('claudeMonitor.ragMenu', guarded(() => ragMenu(ragLog))),
    vscode.commands.registerCommand('claudeMonitor.pickRagDbFolder', guarded(() => pickRagDbFolder(ragLog))),
    vscode.commands.registerCommand('claudeMonitor.applyRagDb', guarded(() => applyRagDb(ragLog))),
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, new SidebarProvider(hub, context), { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('claudeMonitor.show', () => vscode.commands.executeCommand('claudeMonitor.view.focus')),
    vscode.commands.registerCommand('claudeMonitor.open', () => EditorPanel.show(hub, context)),
  );

  // 狀態列右下角的小按鈕：點一下顯示側邊欄
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  item.text = '$(pulse) Claude Monitor';
  item.tooltip = '顯示 Claude Code / Codex 本機監控（只讀取本機 Claude / Codex 逐字稿，不連網）';
  item.command = 'claudeMonitor.show';
  item.show();
  context.subscriptions.push(item);
}

export function deactivate(): void { /* 計時器與畫面由各自的 dispose 收尾 */ }
