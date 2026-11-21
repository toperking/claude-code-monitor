import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 用模擬的 vscode 介面驗證擴充功能主機：命令、面板、定時掃描、送快照、設定變更、收尾。
const h = vi.hoisted(() => {
  const state = {
    commands: new Map<string, () => void>(),
    executed: [] as string[],
    viewProviders: new Map<string, { resolveWebviewView: (v: unknown) => void }>(),
    panels: [] as Array<{
      html: string; posted: unknown[]; visible: boolean; revealed: number; disposed: boolean;
      receive: (m: unknown) => void; dispose: () => void;
    }>,
    statusItems: [] as Array<{ text: string; command?: string; shown: boolean }>,
    config: { claudeHome: '', refreshSeconds: 1, bubbles: true, freeIdle: true } as Record<string, unknown>,
    configListeners: [] as Array<(e: { affectsConfiguration: (s: string) => boolean }) => void>,
  };
  return state;
});

vi.mock('vscode', () => ({
  ViewColumn: { Beside: -2 },
  StatusBarAlignment: { Right: 2 },
  Uri: { joinPath: (_base: unknown, ...parts: string[]) => ({ toString: () => 'vscode-webview://x/' + parts.join('/') }) },
  commands: {
    registerCommand: (id: string, fn: () => void) => { h.commands.set(id, fn); return { dispose() { /* 測試用 */ } }; },
    executeCommand: (id: string) => { h.executed.push(id); return Promise.resolve(); },
  },
  window: {
    registerWebviewViewProvider: (id: string, provider: { resolveWebviewView: (v: unknown) => void }) => { h.viewProviders.set(id, provider); return { dispose() { /* 測試用 */ } }; },
    createStatusBarItem: () => {
      const it = { text: '', tooltip: '', command: undefined as string | undefined, shown: false, show() { it.shown = true; } };
      h.statusItems.push(it);
      return it;
    },
    createWebviewPanel: () => {
      let onMsg: (m: unknown) => void = () => undefined;
      let onDispose: () => void = () => undefined;
      const rec = {
        html: '', posted: [] as unknown[], visible: true, revealed: 0, disposed: false,
        receive: (m: unknown) => onMsg(m),
        dispose: () => { rec.disposed = true; onDispose(); },
      };
      h.panels.push(rec);
      return {
        get visible() { return rec.visible; },
        reveal: () => { rec.revealed++; },
        onDidChangeViewState: () => ({ dispose() { /* 測試用 */ } }),
        onDidDispose: (cb: () => void) => { onDispose = cb; return { dispose() { /* 測試用 */ } }; },
        webview: {
          cspSource: 'vscode-resource:',
          set html(v: string) { rec.html = v; },
          get html() { return rec.html; },
          asWebviewUri: (u: unknown) => u,
          postMessage: (m: unknown) => { rec.posted.push(m); return Promise.resolve(true); },
          onDidReceiveMessage: (cb: (m: unknown) => void) => { onMsg = cb; return { dispose() { /* 測試用 */ } }; },
        },
      };
    },
  },
  workspace: {
    getConfiguration: () => ({ get: <T>(key: string, def: T): T => (key in h.config ? (h.config[key] as T) : def) }),
    onDidChangeConfiguration: (cb: (e: { affectsConfiguration: (s: string) => boolean }) => void) => { h.configListeners.push(cb); return { dispose() { /* 測試用 */ } }; },
  },
}));

import { activate } from '../src/extension';

const SID = '11111111-aaaa-bbbb-cccc-000000000001';
let home: string;

const writeTranscript = (home2: string, lines: unknown[]): void => {
  const dir = path.join(home2, 'projects', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SID + '.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
};
const toolLine = (): unknown => ({
  sessionId: SID, timestamp: new Date(Date.now() - 2000).toISOString(),
  message: { id: 'm1', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 90 } },
});

const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 10)); };
const ctx = (): { subscriptions: unknown[]; extensionUri: unknown } => ({ subscriptions: [], extensionUri: {} });
const posted = (type: string): Array<Record<string, unknown>> =>
  h.panels[0].posted.filter((m): m is Record<string, unknown> => (m as { type?: string }).type === type);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-ext-'));
  h.commands.clear(); h.executed.length = 0; h.viewProviders.clear(); h.panels.length = 0; h.statusItems.length = 0; h.configListeners.length = 0;
  h.config = { claudeHome: home, refreshSeconds: 1, bubbles: true, freeIdle: true };
});
afterEach(() => {
  for (const p of h.panels) if (!p.disposed) p.dispose();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('擴充功能主機', () => {
  it('啟動時註冊命令、側邊欄畫面並顯示狀態列按鈕', () => {
    activate(ctx() as never);
    expect(h.commands.has('claudeMonitor.open')).toBe(true);
    expect(h.commands.has('claudeMonitor.show')).toBe(true);
    expect(h.viewProviders.has('claudeMonitor.view')).toBe(true);
    expect(h.statusItems[0]).toMatchObject({ command: 'claudeMonitor.show', shown: true });
    expect(h.statusItems[0].text).toContain('Claude Monitor');
  });

  it('開啟面板：HTML 有嚴格的 CSP、用 nonce 載入腳本、不載入任何外部網址', () => {
    activate(ctx() as never);
    h.commands.get('claudeMonitor.open')!();
    const html = h.panels[0].html;
    expect(html).toMatch(/Content-Security-Policy[^>]*default-src 'none'/);
    const nonce = /script-src 'nonce-([a-z0-9]+)'/.exec(html)![1];
    expect(html).toContain(`<script nonce="${nonce}" src="vscode-webview://x/media/webview.js">`);
    expect(html).toContain('webview.css');
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('再執行一次命令只是把既有面板帶到前面，不會開第二個', () => {
    activate(ctx() as never);
    h.commands.get('claudeMonitor.open')!();
    h.commands.get('claudeMonitor.open')!();
    expect(h.panels).toHaveLength(1);
    expect(h.panels[0].revealed).toBe(1);
  });

  it('畫面回報 ready 後：先送設定，再送掃描到的快照（只讀本機逐字稿）', async () => {
    writeTranscript(home, [toolLine()]);
    activate(ctx() as never);
    h.commands.get('claudeMonitor.open')!();
    h.panels[0].receive({ type: 'ready' });
    await flush();

    expect(posted('config')[0]).toMatchObject({ bubbles: true, freeIdle: true });
    const snap = posted('snapshot')[0].snapshot as { claudeHome: string; claudeHomeFound: boolean; recentToolCalls: Array<{ tool: string; result: string }>; usageWindows: Array<{ totalTokens: number }> };
    expect(snap.claudeHome).toBe(home);
    expect(snap.claudeHomeFound).toBe(true);
    expect(snap.recentToolCalls).toMatchObject([{ tool: 'Bash', result: '執行中' }]);
    expect(snap.usageWindows[0].totalTokens).toBe(100);
  });

  it('掃描是唯讀的：不會改動逐字稿檔案', async () => {
    writeTranscript(home, [toolLine()]);
    const file = path.join(home, 'projects', 'demo', SID + '.jsonl');
    const before = fs.readFileSync(file, 'utf8'), mtime = fs.statSync(file).mtimeMs;
    activate(ctx() as never);
    h.commands.get('claudeMonitor.open')!();
    h.panels[0].receive({ type: 'ready' });
    await flush();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
    expect(fs.readdirSync(home).sort()).toEqual(['projects']);                  // 沒有在 .claude 底下多寫任何東西
  });

  it('~/.claude 不存在：不丟例外，快照回報找不到', async () => {
    h.config.claudeHome = path.join(home, 'nope');
    activate(ctx() as never);
    h.commands.get('claudeMonitor.open')!();
    h.panels[0].receive({ type: 'ready' });
    await flush();
    expect((posted('snapshot')[0].snapshot as { claudeHomeFound: boolean }).claudeHomeFound).toBe(false);
  });

  it('設定改變：重新送出設定；改了 claudeHome 就改讀新的資料夾', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-ext2-'));
    writeTranscript(other, [toolLine()]);
    try {
      activate(ctx() as never);
      h.commands.get('claudeMonitor.open')!();
      h.panels[0].receive({ type: 'ready' });
      await flush();
      h.panels[0].posted.length = 0;

      h.config.claudeHome = other; h.config.bubbles = false;
      for (const l of h.configListeners) l({ affectsConfiguration: s => s === 'claudeMonitor' });
      await flush();
      expect(posted('config')[0]).toMatchObject({ bubbles: false });
      expect((posted('snapshot').at(-1)!.snapshot as { claudeHome: string; recentToolCalls: unknown[] })).toMatchObject({ claudeHome: other });
      expect((posted('snapshot').at(-1)!.snapshot as { recentToolCalls: unknown[] }).recentToolCalls).toHaveLength(1);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('面板關掉後停止掃描、可以再開一個新的', async () => {
    activate(ctx() as never);
    h.commands.get('claudeMonitor.open')!();
    h.panels[0].dispose();
    const count = h.panels[0].posted.length;
    await new Promise(r => setTimeout(r, 1300));                                  // 超過一個掃描週期
    expect(h.panels[0].posted.length).toBe(count);
    h.commands.get('claudeMonitor.open')!();
    expect(h.panels).toHaveLength(2);
  });
});

// ── 活動列圖示與側邊欄 ─────────────────────────────────────────────────────────

/** 假的 WebviewView（側邊欄用）。 */
function fakeView(visible = true) {
  const rec = { html: '', posted: [] as unknown[], visible, disposed: false, onMsg: (_m: unknown) => undefined as void, onVis: () => undefined as void, onDispose: () => undefined as void };
  const view = {
    get visible() { return rec.visible; },
    onDidChangeVisibility: (cb: () => void) => { rec.onVis = cb; return { dispose() { /* 測試用 */ } }; },
    onDidDispose: (cb: () => void) => { rec.onDispose = cb; return { dispose() { /* 測試用 */ } }; },
    webview: {
      options: undefined as unknown, cspSource: 'vscode-resource:',
      set html(v: string) { rec.html = v; }, get html() { return rec.html; },
      asWebviewUri: (u: unknown) => u,
      postMessage: (m: unknown) => { rec.posted.push(m); return Promise.resolve(true); },
      onDidReceiveMessage: (cb: (m: unknown) => void) => { rec.onMsg = cb as typeof rec.onMsg; return { dispose() { /* 測試用 */ } }; },
    },
  };
  return { view, rec };
}
const snapshotsOf = (rec: { posted: unknown[] }): Array<{ snapshot: { at: number; recentToolCalls: unknown[] } }> =>
  rec.posted.filter((m): m is { type: string; snapshot: { at: number; recentToolCalls: unknown[] } } => (m as { type?: string }).type === 'snapshot');

describe('活動列圖示與側邊欄', () => {
  it('點活動列的圖示（顯示側邊欄命令）會聚焦到「本機監控」畫面', () => {
    activate(ctx() as never);
    h.commands.get('claudeMonitor.show')!();
    expect(h.executed).toEqual(['claudeMonitor.view.focus']);
  });

  it('側邊欄畫面：只開放 media 資料夾、有嚴格的內容安全政策、收到 ready 後送出設定與快照', async () => {
    writeTranscript(home, [toolLine()]);
    activate(ctx() as never);
    const { view, rec } = fakeView();
    h.viewProviders.get('claudeMonitor.view')!.resolveWebviewView(view);

    expect((view.webview.options as { enableScripts: boolean }).enableScripts).toBe(true);
    expect(rec.html).toMatch(/default-src 'none'/);
    expect(rec.html).not.toMatch(/https?:\/\//);
    rec.onMsg({ type: 'ready' });
    await flush();
    expect(rec.posted.some(m => (m as { type?: string }).type === 'config')).toBe(true);
    expect(snapshotsOf(rec)[0].snapshot.recentToolCalls).toHaveLength(1);
  });

  it('看不到的畫面不會被送快照（側邊欄收起時不浪費掃描）；變成看得到時立刻更新', async () => {
    writeTranscript(home, [toolLine()]);
    activate(ctx() as never);
    const { view, rec } = fakeView(false);
    h.viewProviders.get('claudeMonitor.view')!.resolveWebviewView(view);
    rec.onMsg({ type: 'ready' });
    await flush();
    expect(snapshotsOf(rec)).toHaveLength(0);

    rec.visible = true; rec.onVis();
    await flush();
    expect(snapshotsOf(rec).length).toBeGreaterThan(0);
  });

  it('側邊欄與編輯區面板共用同一次掃描：拿到的是同一份快照', async () => {
    writeTranscript(home, [toolLine()]);
    activate(ctx() as never);
    const { view, rec } = fakeView();
    h.viewProviders.get('claudeMonitor.view')!.resolveWebviewView(view);
    h.commands.get('claudeMonitor.open')!();
    h.panels[0].receive({ type: 'ready' });
    rec.onMsg({ type: 'ready' });
    await flush();

    const a = snapshotsOf(h.panels[0]).at(-1)!.snapshot, b = snapshotsOf(rec).at(-1)!.snapshot;
    expect(a.recentToolCalls).toHaveLength(1);
    expect(b.recentToolCalls).toHaveLength(1);
    expect(Math.abs(a.at - b.at)).toBeLessThan(2000);
  });

  it('兩個畫面都關掉之後才停掉計時器；側邊欄先關，編輯區面板仍然會更新', async () => {
    activate(ctx() as never);
    const { view, rec } = fakeView();
    h.viewProviders.get('claudeMonitor.view')!.resolveWebviewView(view);
    h.commands.get('claudeMonitor.open')!();
    rec.onDispose();
    h.panels[0].receive({ type: 'ready' });
    await flush();
    expect(snapshotsOf(h.panels[0]).length).toBeGreaterThan(0);

    h.panels[0].dispose();
    const n = h.panels[0].posted.length;
    await new Promise(r => setTimeout(r, 1300));
    expect(h.panels[0].posted.length).toBe(n);
  });
});

describe('外掛設定檔（package.json）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
    icon: string;
    contributes: {
      commands: Array<{ command: string }>;
      viewsContainers: { activitybar: Array<{ id: string; icon: string }> };
      views: Record<string, Array<{ id: string; type: string }>>;
      menus: Record<string, Array<{ command: string; when: string }>>;
    };
  };

  it('活動列容器的圖示與外掛圖示檔案都存在，而且會被打包進去', () => {
    const root = path.join(__dirname, '..');
    expect(fs.existsSync(path.join(root, pkg.icon))).toBe(true);
    const bar = pkg.contributes.viewsContainers.activitybar[0];
    expect(fs.existsSync(path.join(root, bar.icon))).toBe(true);
    const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
    expect(ignore).toContain('!' + pkg.icon);
    expect(ignore).toContain('!' + bar.icon);
  });

  it('活動列容器裡有一個網頁畫面，id 與程式註冊的一致', async () => {
    const bar = pkg.contributes.viewsContainers.activitybar[0];
    const views = pkg.contributes.views[bar.id];
    expect(views).toHaveLength(1);
    expect(views[0].type).toBe('webview');
    activate(ctx() as never);
    expect(h.viewProviders.has(views[0].id)).toBe(true);
  });

  it('設定檔宣告的每個命令，程式都有註冊；側邊欄標題列有「在編輯區開啟」按鈕', () => {
    activate(ctx() as never);
    for (const c of pkg.contributes.commands) expect(h.commands.has(c.command)).toBe(true);
    expect(pkg.contributes.menus['view/title']).toContainEqual(expect.objectContaining({ command: 'claudeMonitor.open', when: 'view == claudeMonitor.view' }));
  });
});
