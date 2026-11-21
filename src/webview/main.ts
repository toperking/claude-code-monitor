// Webview 入口：收到擴充功能主機送來的快照 → 餵給 FlowModel → 用 requestAnimationFrame 驅動時間軸並繪製。
// 上方的用量卡片、狀態列與「說明泡泡」開關是一般 HTML；流程圖是 Canvas。

import { FlowModel } from '../core/model';
import { MonitorSnapshot, UsageWindowDto, LimitHitDto, isActive } from '../core/types';
import { FlowRenderer } from './render';

interface VsCodeApi { postMessage(message: unknown): void }
declare function acquireVsCodeApi(): VsCodeApi;
const vscode: VsCodeApi | null = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const model = new FlowModel();
const canvas = $<HTMLCanvasElement>('flow');
const renderer = new FlowRenderer(canvas);
renderer.model = model;

const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
model.reduceMotion = motion.matches;
motion.addEventListener('change', () => { model.reduceMotion = motion.matches; });

// ── 用量卡片 ───────────────────────────────────────────────────────────────
const pct = (p: number): string => (p >= 1 ? `${Math.round(p)}%` : '<1%');
const esc = (s: string): string => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));

function renderUsage(windows: UsageWindowDto[]): void {
  const html = windows.map(w => {
    const hasData = w.totalTokens > 0;
    const hit = w.cacheHitRate !== null ? pct(w.cacheHitRate * 100) : '—';
    const rows = w.models.map(m => `
      <div class="share"><span class="name">${esc(m.model)}</span>
        <span class="bar"><i style="width:${Math.max(2, Math.round(m.percent))}%"></i></span>
        <span class="pct">${pct(m.percent)}</span></div>`).join('');
    return `<div class="card">
      <div class="card-head"><span class="label">${esc(w.label)}</span>
        <span class="meta">快取命中率 <b>${hit}</b> · <b>${w.totalTokens.toLocaleString('en-US')}</b> tokens</span></div>
      ${hasData ? rows : '<div class="empty">這段時間沒有資料</div>'}
    </div>`;
  }).join('');
  const key = html;
  const el = $('usage');
  if (el.dataset.key !== key) { el.innerHTML = html; el.dataset.key = key; } // 內容沒變就不重建，避免閃動
}

function describeLimitHit(hit: LimitHitDto | null, now: number): string {
  if (!hit) return '';
  const kind = hit.limitType === 'five_hour' ? '5 小時額度' : hit.limitType;
  const fmt = (ms: number): string => {
    const d = new Date(ms);
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  return `最近一次達到${kind}上限：${fmt(hit.hitAt)}；重置時間 ${fmt(hit.resetsAt)}${hit.resetsAt > now ? '，尚未重置' : '，已重置'}`;
}

function renderStatus(s: MonitorSnapshot): void {
  const notice = $('notice');
  const limit = describeLimitHit(s.lastLimitHit, s.at);
  const home = s.claudeHomeFound ? '' : `找不到 .claude 資料夾：${s.claudeHome}`;
  const text = [home, limit].filter(Boolean).join('\n');
  notice.hidden = text.length === 0;
  notice.textContent = text;
  notice.className = 'notice' + (home ? ' warn' : '');

  const active = s.sessions.filter(x => isActive(x.status)).length;
  const activeAgents = s.agents.filter(a => isActive(a.status)).length;
  $('status').textContent = s.claudeHomeFound
    ? `已讀取本機 .claude  ·  活躍 ${active} / ${s.sessions.length} 個 session  ·  ${activeAgents} 個活躍子代理  ·  ${s.recentToolCalls.length} 筆工具呼叫`
    : '尚未找到 .claude 資料夾';
}

// ── 訊息 ───────────────────────────────────────────────────────────────────
let maxFps = 30;
window.addEventListener('message', ev => {
  const msg = ev.data as { type: string; snapshot?: MonitorSnapshot; bubbles?: boolean; freeIdle?: boolean; maxFps?: number };
  if (msg.type === 'snapshot' && msg.snapshot) applySnapshot(msg.snapshot);
  else if (msg.type === 'config') {
    if (typeof msg.bubbles === 'boolean') { model.bubbles.enabled = msg.bubbles; $<HTMLInputElement>('bubbles').checked = msg.bubbles; }
    if (typeof msg.freeIdle === 'boolean') model.freeIdle = msg.freeIdle;
    if (typeof msg.maxFps === 'number') maxFps = Math.min(60, Math.max(10, msg.maxFps));
  }
});

/** 供除錯與測試頁面直接餵快照。 */
export function applySnapshot(s: MonitorSnapshot): void {
  model.sync(s);
  renderUsage(s.usageWindows);
  renderStatus(s);
}
(window as unknown as { applySnapshot: typeof applySnapshot; flowModel: FlowModel }).applySnapshot = applySnapshot;
(window as unknown as { flowModel: FlowModel; flowRenderer: FlowRenderer }).flowModel = model;
(window as unknown as { flowRenderer: FlowRenderer }).flowRenderer = renderer; // 測試頁用

$<HTMLInputElement>('bubbles').addEventListener('change', e => {
  model.bubbles.enabled = (e.target as HTMLInputElement).checked; // 只影響之後新產生的泡泡（已在畫面上的自然淡出）
});

// ── 大小與動畫迴圈 ─────────────────────────────────────────────────────────
// 畫面負擔要小：每秒最多 maxFps 張（預設 30，設定可調）、裝置像素比最多算 MaxDpr 倍、
// 全部淡掉之後畫面是靜止的，一秒才畫一次（不需要每秒畫幾十次）。
const MaxDpr = 1.5;
const stage = $('stage');
const resize = (): void => {
  const r = stage.getBoundingClientRect();
  renderer.resize(Math.max(1, Math.floor(r.width)), Math.max(1, Math.floor(r.height)), Math.min(MaxDpr, window.devicePixelRatio || 1));
};
new ResizeObserver(resize).observe(stage);
resize();

// 除錯用：累計實際畫了幾張、花了多少毫秒（測試頁會顯示）
const renderStats = { frames: 0, ms: 0 };
(window as unknown as { renderStats: typeof renderStats }).renderStats = renderStats;

let lastDraw = 0;
const frame = (ts: number): void => {
  const interval = model.animating ? 1000 / maxFps : 1000;
  if (lastDraw === 0 || ts - lastDraw >= interval - 2) {
    const dt = lastDraw === 0 ? 0 : (ts - lastDraw) / 1000;
    lastDraw = ts;
    const t0 = performance.now();
    model.tick(dt, Date.now());
    renderer.render(model, ts);
    renderStats.frames++; renderStats.ms += performance.now() - t0;
  }
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);

vscode?.postMessage({ type: 'ready' });
