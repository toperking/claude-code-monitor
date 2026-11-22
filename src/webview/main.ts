// Webview 入口：收到擴充功能主機送來的快照 → 餵給 FlowModel → 用 requestAnimationFrame 驅動時間軸並繪製。
// 狀態列與「說明泡泡」開關是一般 HTML；流程圖是 Canvas。

import { FlowModel } from '../core/model';
import { flowSceneRows } from '../core/flowSceneLayout';
import { snapshotProviders } from '../core/providerSnapshot';
import { MonitorSnapshot, isActive } from '../core/types';
import { FlowRenderer } from './render';

interface VsCodeApi { postMessage(message: unknown): void }
declare function acquireVsCodeApi(): VsCodeApi;
const vscode: VsCodeApi | null = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const model = new FlowModel({ provider: 'Claude' });
const codexModel = new FlowModel({ provider: 'Codex' });
const models = [model, codexModel];
const canvas = $<HTMLCanvasElement>('flow');
const stage = $('stage');
canvas.setAttribute('aria-label', 'AI 共同桌布：各來源由上往下排列');
const renderer = new FlowRenderer(canvas);
renderer.model = model;

const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
models.forEach(m => { m.reduceMotion = motion.matches; });
motion.addEventListener('change', () => { models.forEach(m => { m.reduceMotion = motion.matches; }); });

function renderStatus(s: MonitorSnapshot): void {
  const notice = $('notice');
  const home = !s.claudeHomeFound && !s.codexHomeFound ? `找不到 .claude 資料夾：${s.claudeHome}` : '';
  const text = home;
  notice.hidden = text.length === 0;
  notice.textContent = text;
  notice.className = 'notice' + (home ? ' warn' : '');

  const active = s.sessions.filter(x => isActive(x.status)).length;
  const activeAgents = s.agents.filter(a => isActive(a.status)).length;
  const sources = [s.claudeHomeFound ? 'Claude' : '', s.codexHomeFound ? 'Codex' : ''].filter(Boolean).join(' + ');
  $('status').textContent = sources
    ? `已讀取本機 ${sources}  ·  活躍 ${active} / ${s.sessions.length} 個 session  ·  ${activeAgents} 個活躍子代理  ·  ${s.recentToolCalls.length} 筆工具呼叫`
    : '尚未找到本機逐字稿資料夾';
}

// ── 訊息 ───────────────────────────────────────────────────────────────────
let maxFps = 30;
window.addEventListener('message', ev => {
  const msg = ev.data as { type: string; snapshot?: MonitorSnapshot; bubbles?: boolean; freeIdle?: boolean; maxFps?: number };
  if (msg.type === 'snapshot' && msg.snapshot) applySnapshot(msg.snapshot);
  else if (msg.type === 'config') {
    if (typeof msg.bubbles === 'boolean') { models.forEach(m => { m.bubbles.enabled = msg.bubbles!; }); $<HTMLInputElement>('bubbles').checked = msg.bubbles; }
    if (typeof msg.freeIdle === 'boolean') models.forEach(m => { m.freeIdle = msg.freeIdle!; });
    if (typeof msg.maxFps === 'number') maxFps = Math.min(60, Math.max(10, msg.maxFps));
  }
});

/** 供除錯與測試頁面直接餵快照。 */
export function applySnapshot(s: MonitorSnapshot): void {
  for (const provider of snapshotProviders(s)) {
    if (models.some(m => m.providerLabel === provider)) continue;
    const next = new FlowModel({ provider, freeIdle: model.freeIdle });
    next.reduceMotion = model.reduceMotion;
    next.bubbles.enabled = model.bubbles.enabled;
    models.push(next);
    Object.assign((window as unknown as { flowModels: Record<string, FlowModel> }).flowModels, { [provider]: next });
  }
  models.forEach(m => m.sync(s));
  renderStatus(s);
}
(window as unknown as { applySnapshot: typeof applySnapshot; flowModel: FlowModel }).applySnapshot = applySnapshot;
(window as unknown as { flowModel: FlowModel; flowRenderer: FlowRenderer }).flowModel = model;
(window as unknown as { flowRenderer: FlowRenderer }).flowRenderer = renderer; // 測試頁用
Object.assign(window, { flowModels: { Claude: model, Codex: codexModel } });

// 設定按鈕：畫面本身不做任何設定，只通知擴充功能主機「使用者想開設定頁」
document.getElementById('settings')?.addEventListener('click', () => vscode?.postMessage({ type: 'openSettings' })); // 測試用的 harness 頁沒有這顆按鈕

$<HTMLInputElement>('bubbles').addEventListener('change', e => {
  models.forEach(m => { m.bubbles.enabled = (e.target as HTMLInputElement).checked; });
});

// ── 大小與動畫迴圈 ─────────────────────────────────────────────────────────
// 畫面負擔要小：每秒最多 maxFps 張（預設 30，設定可調）、裝置像素比最多算 MaxDpr 倍、
// 全部淡掉之後畫面是靜止的，一秒才畫一次（不需要每秒畫幾十次）。
const MaxDpr = 1.5;
const resize = (): void => {
  const r = stage.getBoundingClientRect();
  renderer.resize(Math.max(1, Math.floor(r.width)), Math.max(1, Math.floor(r.height)), Math.min(MaxDpr, window.devicePixelRatio || 1));
};
const observer = new ResizeObserver(resize);
observer.observe(stage);
resize();

// 除錯用：累計實際畫了幾張、花了多少毫秒（測試頁會顯示）
const renderStats = { frames: 0, ms: 0 };
(window as unknown as { renderStats: typeof renderStats }).renderStats = renderStats;

let lastDraw = 0;
const frame = (ts: number): void => {
  const interval = models.some(m => m.animating) ? 1000 / maxFps : 1000;
  if (lastDraw === 0 || ts - lastDraw >= interval - 2) {
    const dt = lastDraw === 0 ? 0 : (ts - lastDraw) / 1000;
    lastDraw = ts;
    const t0 = performance.now();
    flowSceneRows(models).forEach((row, i) => { row.model.outputOffsetY = -row.y; row.model.outputSlotOffset = i; });
    models.forEach(m => m.tick(dt, Date.now()));
    renderer.renderScene(models, ts);
    renderStats.frames++; renderStats.ms += performance.now() - t0;
  }
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);

vscode?.postMessage({ type: 'ready' });
