// 即時流程的繪製與互動（對應 C# 的 FlowCanvas.cs）：滾輪縮放、拖曳平移、雙擊還原、點方塊展開。
// 狀態與時間軸都在 core/model.ts；這裡每一幀只負責把 FlowModel 畫出來（Canvas 2D）。
// 發光用「多層半透明線條」疊出來，不用 shadowBlur（避免每幀大量模糊運算）。

import { BubbleAnchors, BubbleQueue } from '../core/bubbles';
import { tailLabel } from '../core/tailChips';
import { FlowSceneRow, flowSceneRows, outputShiftFor, sharedOutputY } from '../core/flowSceneLayout';
import { BrainOutline, BrainFolds, BrainJunctions } from './brainGlyph';
import { ArmorPaths } from './armorGlyph';
import {
  FlowAlien, FlowModel, FlowPill, Layout, Palette, Pt, cubic, formatModel, hhmmss, num1, pillInfo,
  routeIn, routeOut, routeRejected, route, tailChipWidth, tailWeight, AlienReachUnits,
} from '../core/model';
import { SessionStatus, ToolCallDto, ToolResult, isActive } from '../core/types';

const UI = '"Segoe UI Variable", "Segoe UI", "Microsoft JhengHei UI", system-ui, sans-serif';
const MONO = '"Cascadia Mono", Consolas, "Microsoft JhengHei UI", monospace';
const Breath = 800; // 呼吸週期：sin(ms / Breath)，越大越慢
const BrainShape = new Path2D(BrainOutline);
const BrainFoldPaths = BrainFolds.map(path => new Path2D(path));
const ArmorShapes = Object.fromEntries(Object.entries(ArmorPaths).map(([key, path]) => [key, new Path2D(path)])) as Record<keyof typeof ArmorPaths, Path2D>;
const ClickSlop = 4;

type Align = 'left' | 'center' | 'right';
interface TextOpts { alpha?: number; bold?: boolean; mono?: boolean; align?: Align }

const colorCache = new Map<string, string>();
/** "#rrggbb" + 透明度 → "rgba(...)"（有快取，不要每幀都重新組字串）。 */
function rgba(hex: string, alpha = 1): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 64) / 64;
  const key = hex + '|' + a;
  let v = colorCache.get(key);
  if (!v) {
    const n = parseInt(hex.slice(1), 16);
    v = `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    colorCache.set(key, v);
  }
  return v;
}

/** 說明泡泡文字的最大寬度（像素，圖面座標）；超過以 ... 結尾。 */
const BubbleMaxTextW = 300;

const shorten = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function rowLabel(c: ToolCallDto): string {
  const parts = c.tool.split('__');
  const sub = parts[0] === 'mcp' && parts.length >= 3 ? parts.slice(2).join('__') : '';
  return (sub.length > 0 ? sub + '  ' : '') + c.summary;
}

// ── 機器人的幾何（單位座標，只建一次）──────────────────────────────────────────
function poly(...pts: [number, number][]): Path2D {
  const p = new Path2D();
  pts.forEach(([x, y], i) => (i === 0 ? p.moveTo(x, y) : p.lineTo(x, y)));
  p.closePath();
  return p;
}
const HornGeo = (() => { const p = new Path2D(); p.moveTo(2.2, -10.4); p.quadraticCurveTo(7.8, -10.0, 6.4, -16); return p; })(); // 彎月：先往外、再向上
const ChestGeo = poly([-6, -5.5], [6, -5.5], [4.4, 4], [-4.4, 4]);
const CrestGeo = poly([-1.2, -12.2], [1.2, -12.2], [0, -15.6]);
const FlameGeo = poly([-1.4, 0], [1.4, 0], [0, 1]);
const ChestSideGeo = poly([-3.4, -5.5], [3.4, -5.5], [2.6, 4], [-2.8, 4]);
const CrestSideGeo = poly([-1.6, -12.2], [0.6, -12.2], [-0.6, -15.2]);
const HornSideGeo = (() => { const p = new Path2D(); p.moveTo(0.2, -11.8); p.quadraticCurveTo(5.2, -11.2, 5.4, -15.8); return p; })(); // 側面只看得到一支角：往前彎

// ── 怪獸機甲（子代理用）的幾何：黑色裝甲＋金色鉤爪大腳＋紅橘色蝙蝠翅膀＋藍色頭帶白色口罩與金色尖角＋肩砲 ──
// 參考使用者給的圖，只取輪廓與配色，用簡化的向量重畫（不是描圖）。單位座標與主機器人相同。
const WingGeo = poly([0, 0], [8, -9], [21, -18], [18, -9], [22, -3], [15, -5], [16, 4], [9, 0], [9, 8], [2, 5]); // 右翼，原點＝肩膀；左翼用 scale(-1,1) 鏡射
const FootGeo = poly([-3.6, 0], [3.6, 0], [4, 2.4], [3.1, 2.4], [2.4, 5.4], [1.7, 2.4], [0.7, 2.4], [0, 5.8], [-0.7, 2.4], [-1.7, 2.4], [-2.4, 5.4], [-3.1, 2.4], [-4, 2.4]); // 三爪大腳（正面）
const SideFootGeo = poly([-2.6, 0], [3.2, 0], [7.8, 1.5], [4.4, 1.5], [8.2, 3.0], [4.0, 2.7], [7.4, 4.5], [3.2, 3.6], [-2.6, 3.4]); // 鉤爪大腳（側面，腳尖朝 +x）
const MonsterHornGeo = poly([-1, -12], [1, -12], [0, -17.6]); // 頭頂中央的金色尖角
const BladeGeo = poly([2.4, -10.6], [8.8, -16.4], [5.6, -10.4], [3.8, -9.4]); // 右側向後上方掃的金色刀刃；左側鏡射
const MonsterChestGeo = poly([-6.2, -5.8], [6.2, -5.8], [4.6, 3.6], [-4.6, 3.6]);
const MonsterChestSideGeo = poly([-3.6, -5.8], [3.6, -5.8], [2.8, 3.6], [-3, 3.6]);
const MuzzleGeo = poly([-2.8, -8.4], [2.8, -8.4], [1.6, -5.2], [-1.6, -5.2]); // 白色口罩（正面）
const SideMuzzleGeo = poly([2.2, -9.2], [6.2, -8.4], [5.6, -6.8], [2.4, -6.4]); // 白色口罩（側面，朝前）
const SideBladeGeo = poly([-0.8, -11.2], [-6, -15, ], [-2.4, -10.2]); // 側面：向後掃的金色刀刃
const SideHornGeo = poly([0.6, -12], [2.4, -12], [3.8, -17.4]); // 側面：向前傾的尖角
const TailGeo = (() => { const p = new Path2D(); p.moveTo(2, 9); p.bezierCurveTo(10, 11, 16, 7, 14.5, -0.5); return p; })(); // 藍色尾巴（正面，捲在右邊）
const SideTailGeo = (() => { const p = new Path2D(); p.moveTo(-2.4, 7); p.bezierCurveTo(-9, 9, -14, 6, -15.5, 0); return p; })(); // 側面：尾巴往後甩

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** 出拳火花的顏色：平常是各自的暖色；在 Output 處理結果時依結果變色（成功綠、失敗紅）。 */
const sparkColor = (u: FlowAlien, normal: string): string => (u.deliverTarget === 'ok' ? Palette.Ok : u.deliverTarget === 'fail' ? Palette.Fail : normal);

export class FlowRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private fit = 1;
  private camX = 0;
  /** 手／腳整組目前往右讓開的距離（由動畫迴圈慢慢滑過去）。 */
  private outX = 0;
  private camY = 0;
  private camK = 1;
  private ms = 0;
  private hoverKey: string | null = null;
  model: FlowModel | null = null;
  private rows: FlowSceneRow[] = [];
  private hoverPill: FlowPill | null = null;

  // 拖曳
  private dragging = false;
  private dragFrom = { x: 0, y: 0 };
  private dragCam = { x: 0, y: 0 };
  private dragMoved = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      this.camK = Math.min(3, Math.max(0.4, this.camK * (e.deltaY < 0 ? 1.1 : 0.9)));
    }, { passive: false });
    canvas.addEventListener('dblclick', () => { this.camX = this.camY = 0; this.camK = 1; });
    canvas.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      this.dragging = true; this.dragMoved = 0;
      this.dragFrom = { x: e.offsetX, y: e.offsetY }; this.dragCam = { x: this.camX, y: this.camY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', e => {
      if (this.dragging) {
        this.dragMoved = Math.max(this.dragMoved, Math.hypot(e.offsetX - this.dragFrom.x, e.offsetY - this.dragFrom.y));
        if (this.dragMoved > ClickSlop) { this.camX = this.dragCam.x + e.offsetX - this.dragFrom.x; this.camY = this.dragCam.y + e.offsetY - this.dragFrom.y; }
        return;
      }
      const wp = this.toWorld(e.offsetX, e.offsetY);
      const hit = this.hitScene(wp);
      this.hoverPill = hit;
      this.hoverKey = hit?.key ?? null;
      canvas.style.cursor = hit ? 'pointer' : 'default';
    });
    canvas.addEventListener('pointerup', e => {
      if (!this.dragging) return;
      this.dragging = false;
      canvas.releasePointerCapture(e.pointerId);
      if (this.dragMoved <= ClickSlop) { // 移動不超過 4px 才算點擊（展開／收起）；超過就是平移
        const wp = this.toWorld(e.offsetX, e.offsetY);
        const p = this.hitScene(wp);
        if (p) p.expanded = !p.expanded;
      }
    });
    canvas.addEventListener('pointerleave', () => { if (!this.dragging) { this.hoverKey = null; this.hoverPill = null; canvas.style.cursor = 'default'; } });
  }

  /** 把鏡頭對準世界座標 (wx, wy) 並放大到 k 倍（測試頁用，方便看機器人的細節）。 */
  focus(wx: number, wy: number, k: number): void {
    const base = this.fit / this.camK;
    this.camK = k;
    this.camX = -wx * base * k;
    this.camY = -wy * base * k - 30; // 世界原點在畫布中心下方 30，所以要再扣掉
  }

  /** 畫布大小改變（CSS 像素與裝置像素比）。 */
  resize(w: number, h: number, dpr: number): void {
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
  }

  private toWorld(x: number, y: number): Pt {
    return { x: (x - (this.w / 2 + this.camX)) / this.fit + this.outX / 2, y: (y - (this.h / 2 + 30 + this.camY)) / this.fit };
  }

  private hitScene(point: Pt): FlowPill | null {
    if (this.rows.length === 0) return this.model?.hitPill(point.x, point.y) ?? null;
    for (const row of this.rows) {
      const pill = row.model.hitPill(point.x, point.y - row.y);
      if (pill) return pill;
    }
    return null;
  }

  /** `outputY`：手／腳整組目前的 Y（動畫迴圈慢慢滑過去的值）；沒給就直接用目標位置。 */
  renderScene(models: readonly FlowModel[], ms: number, outputY?: number, outputX = 0): void {
    this.rows = flowSceneRows(models);
    this.outX = outputX;
    const outY = outputY ?? sharedOutputY(this.rows);
    this.ms = ms;
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.globalAlpha = 1;
    c.fillStyle = '#0b0d10'; c.fillRect(0, 0, this.w, this.h);
    if (this.w < 10 || this.h < 10 || this.rows.length === 0) return;
    this.drawGrid();
    const height = this.rows.reduce((sum, row) => sum + row.height, 0);
    this.fit = Math.min(1.35, Math.max(0.1, Math.min(this.w / (1400 + outputX), (this.h - 100) / height))) * this.camK;
    c.save();
    c.translate(this.w / 2 + this.camX, this.h / 2 + 30 + this.camY);
    c.scale(this.fit, this.fit);
    c.translate(-outputX / 2, 0); // 手／腳右移時整張圖往左補回半個位移，兩邊都留在畫面內
    for (const [rowIndex, row] of this.rows.entries()) {
      const m = row.model;
      m.outputOffsetY = outY - row.y;
      m.outputOffsetX = outputX;
      m.outputSlotOffset = rowIndex;
      c.save(); c.translate(0, row.y);
      this.alpha(m.source, () => { this.drawChipEdges(m); this.drawChips(m); this.drawHub(m); });
      this.alpha(1, () => { this.drawEdges(m); this.drawPills(m); this.drawParticles(m); this.drawAliens(m); this.drawBubbles(m); });
      c.restore();
    }
    c.save(); c.translate(outputX, outY);
    const visibleModels = this.rows.map(row => row.model);
    this.alpha(Math.max(...visibleModels.map(m => m.sink)), () => { this.drawOutputs(visibleModels); this.drawSummary(visibleModels); });
    c.restore();
    c.restore();
  }

  /**
   * 手／腳整組這一刻該往右讓多遠：看各方塊的尾巴標籤與說明泡泡伸到哪裡，擋到手／腳就讓開；
   * 全部消失後回傳 0（呼叫端用 OutputAnchor 讓它慢慢滑過去、再滑回來）。
   */
  requiredOutputShiftX(models: readonly FlowModel[]): number {
    const edges: number[] = [];
    for (const m of models) {
      for (const p of m.pillList) {
        if (p.fade < 0.01) continue;
        const end = m.tailEndX(p);
        if (end > p.right + 1) edges.push(end);
        for (const b of m.bubbles.items) {
          if (b.anchorKey !== p.key) continue;
          if (b.alpha(BubbleQueue.FadeSeconds) * p.fade < 0.02) continue;
          const text = this.fitText(b.text, BubbleMaxTextW, 11, false);
          edges.push(end + 18 + this.measure(text, 11, false, false) + 22);
        }
      }
    }
    // 送結果過去的小機甲站在圓環左邊更遠處，一併算進去，泡泡才不會蓋住它們
    return outputShiftFor(edges, Layout.Out.x - Layout.OutR - (AlienReachUnits * Layout.AlienUnit + 20));
  }

  // ── 小工具 ───────────────────────────────────────────────────────────
  private alpha(a: number, draw: () => void): void {
    if (a <= 0.005) return;
    const c = this.ctx;
    c.save();
    c.globalAlpha *= Math.min(1, a);
    draw();
    c.restore();
  }

  private rr(x: number, y: number, w: number, h: number, r: number): void {
    this.ctx.beginPath();
    this.ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
  }

  private fillRR(x: number, y: number, w: number, h: number, r: number, fill: string | null, stroke: string | null = null, lw = 1): void {
    this.rr(x, y, w, h, r);
    if (fill) { this.ctx.fillStyle = fill; this.ctx.fill(); }
    if (stroke) { this.ctx.strokeStyle = stroke; this.ctx.lineWidth = lw; this.ctx.stroke(); }
  }

  private circle(x: number, y: number, r: number, fill: string | null, stroke: string | null = null, lw = 1): void {
    const c = this.ctx;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    if (fill) { c.fillStyle = fill; c.fill(); }
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw; c.stroke(); }
  }

  private ellipse(x: number, y: number, rx: number, ry: number, fill: string | null, stroke: string | null = null, lw = 1): void {
    const c = this.ctx;
    c.beginPath();
    c.ellipse(x, y, Math.max(0.01, rx), Math.max(0.01, ry), 0, 0, Math.PI * 2);
    if (fill) { c.fillStyle = fill; c.fill(); }
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw; c.stroke(); }
  }

  private lineSeg(x0: number, y0: number, x1: number, y1: number, stroke: string, lw: number, round = false): void {
    const c = this.ctx;
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1);
    c.strokeStyle = stroke; c.lineWidth = lw; c.lineCap = round ? 'round' : 'butt';
    c.stroke(); c.lineCap = 'butt';
  }

  private fillPath(p: Path2D, fill: string | null, stroke: string | null = null, lw = 1, round = false): void {
    const c = this.ctx;
    if (fill) { c.fillStyle = fill; c.fill(p); }
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw; c.lineCap = round ? 'round' : 'butt'; c.stroke(p); c.lineCap = 'butt'; }
  }

  /** 文字以「垂直置中」的 y 定位。回傳寬度。 */
  private text(s: string, x: number, yMid: number, size: number, hex: string, o: TextOpts = {}): number {
    const c = this.ctx;
    c.font = `${o.bold ? 'bold ' : ''}${size}px ${o.mono ? MONO : UI}`;
    const width = c.measureText(s).width;
    const a = o.alpha ?? 1;
    if (a <= 0.004) return width;
    c.textAlign = o.align ?? 'left';
    c.textBaseline = 'middle';
    c.fillStyle = rgba(hex, a);
    c.fillText(s, x, yMid);
    return width;
  }

  private measure(s: string, size: number, bold: boolean, mono: boolean): number {
    this.ctx.font = `${bold ? 'bold ' : ''}${size}px ${mono ? MONO : UI}`;
    return this.ctx.measureText(s).width;
  }

  /** 依像素寬度截短文字（中文字比英文寬），超過就以「...」結尾。 */
  private fitText(s: string, maxWidth: number, size: number, mono = true): string {
    if (this.measure(s, size, false, mono) <= maxWidth) return s;
    let n = s.length;
    while (n > 1 && this.measure(s.slice(0, n) + '...', size, false, mono) > maxWidth) n--;
    return s.slice(0, n) + '...';
  }

  private bezier(p: [Pt, Pt, Pt, Pt]): Path2D {
    const path = new Path2D();
    path.moveTo(p[0].x, p[0].y);
    path.bezierCurveTo(p[1].x, p[1].y, p[2].x, p[2].y, p[3].x, p[3].y);
    return path;
  }

  /** 發光：在線條底下疊 3 層更寬、更淡的線。 */
  private glowStroke(path: Path2D, hex: string, alpha: number, radius: number): void {
    if (radius < 0.8 || alpha < 0.01) return;
    const c = this.ctx;
    c.lineCap = 'round';
    for (const [k, a] of [[1, 0.10], [0.55, 0.16], [0.25, 0.22]] as const) {
      c.strokeStyle = rgba(hex, alpha * a); c.lineWidth = radius * k; c.stroke(path);
    }
    c.lineCap = 'butt';
  }

  private glowRect(x: number, y: number, w: number, h: number, corner: number, hex: string, alpha: number, radius: number): void {
    if (radius < 0.8 || alpha < 0.01) return;
    for (const [k, a] of [[0.9, 0.10], [0.5, 0.16], [0.22, 0.22]] as const) {
      this.rr(x, y, w, h, corner);
      this.ctx.strokeStyle = rgba(hex, alpha * a); this.ctx.lineWidth = radius * k; this.ctx.stroke();
    }
  }

  private glowCircle(cx: number, cy: number, r: number, hex: string, alpha: number, radius: number): void {
    if (radius < 0.8 || alpha < 0.01) return;
    const c = this.ctx;
    const a = Math.min(1, Math.max(0, alpha));
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, r + radius);
    g.addColorStop(0, rgba(hex, 0.55 * a));
    g.addColorStop(r / (r + radius), rgba(hex, 0.55 * a));
    g.addColorStop(1, rgba(hex, 0));
    c.fillStyle = g;
    c.beginPath(); c.arc(cx, cy, r + radius, 0, Math.PI * 2); c.fill();
  }

  private line(path: [Pt, Pt, Pt, Pt], hex: string, width: number, alpha: number, glow: number): void {
    const g = this.bezier(path);
    this.glowStroke(g, hex, alpha, glow);
    this.ctx.strokeStyle = rgba(hex, alpha); this.ctx.lineWidth = width; this.ctx.stroke(g);
  }

  // ── 主繪製 ───────────────────────────────────────────────────────────
  render(m: FlowModel, ms: number): void {
    this.rows = [];
    this.model = m; this.ms = ms;
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.globalAlpha = 1;
    c.fillStyle = '#0b0d10';
    c.fillRect(0, 0, this.w, this.h);
    if (this.w < 10 || this.h < 10) return;
    this.drawGrid();

    // 依「實際有幾排」決定縮放：工具少時畫面放大，不必永遠按最多 14 排預留空間
    const half = Math.max(250, m.columnHeight / 2 + 70);
    // 下限放寬到 0.1：放在窄的側邊欄（約 300 像素寬）時，整張圖也要縮得進去，而不是被切掉
    this.fit = Math.min(1.35, Math.max(0.1, Math.min(this.w / 1400, (this.h - 90) / (half * 2 + 60)))) * this.camK;

    c.save();
    c.translate(this.w / 2 + this.camX, this.h / 2 + 30 + this.camY);
    c.scale(this.fit, this.fit);
    // 三組各自用自己的透明度疊上去：AI（最先淡出）、output（最後淡出）、方塊與它們的連線／粒子（各方塊用自己的 fade）
    this.alpha(m.source, () => { this.drawChipEdges(m); this.drawChips(m); this.drawHub(m); });
    this.alpha(m.sink, () => { this.drawOutputs([m]); this.drawSummary([m]); });
    this.alpha(1, () => { this.drawEdges(m); this.drawPills(m); this.drawParticles(m); this.drawAliens(m); this.drawBubbles(m); });
    c.restore();

    this.drawLog(m);
    this.drawHeader(m);
    if (m.sink <= 0.05) {
      this.text('目前沒有 AI 在執行。', this.w / 2, this.h / 2 - 12, 14, '#6b7685', { align: 'center' });
      this.text('開始執行後，節點與流動粒子會自動浮現；停止一段時間後會慢慢消失。', this.w / 2, this.h / 2 + 12, 13, '#6b7685', { align: 'center' });
    }
  }

  private drawGrid(): void {
    const step = 38 * this.camK;
    const ox = (((this.w / 2 + this.camX) % step) + step) % step;
    const oy = (((this.h / 2 + this.camY) % step) + step) % step;
    this.ctx.fillStyle = rgba('#7cc4ff', 0.06);
    for (let x = ox; x < this.w; x += step) for (let y = oy; y < this.h; y += step) this.ctx.fillRect(x, y, 1.3, 1.3);
  }

  private drawChipEdges(m: FlowModel): void {
    m.sessions.forEach((s, i) => {
      const active = isActive(s.status);
      this.line(route({ x: Layout.ChipX + Layout.ChipW, y: m.chipY(i) }, { x: Layout.Hub.x - Layout.HubR, y: Layout.Hub.y }), Palette.Agent, 1.2, active ? 0.45 : 0.14, active ? 8 : 0);
    });
  }

  // 每個方塊的三條連線（主節點→方塊、方塊→輸出、方塊→REJECTED）都跟著該方塊淡出（乘上 fade）
  private drawEdges(m: FlowModel): void {
    for (const agent of m.agents) {
      if (agent.info.parentToolUseId === null) continue;
      const parent = m.agents.find(a => a.info.sessionId === agent.info.sessionId && a.info.agentId === agent.info.parentAgentId);
      if (agent.info.parentAgentId.length > 0 && !parent) continue;
      const start: Pt = parent ? { x: Layout.AgentX + Layout.AgentW / 2, y: parent.y } : { x: Layout.Hub.x + Layout.HubR, y: Layout.Hub.y };
      this.line(route(start, { x: Layout.AgentX - Layout.AgentW / 2, y: agent.y }), Palette.Task, 1.2, 0.4 * agent.fade, 0);
    }
    for (const p of m.pillList) {
      if (p.fade < 0.01) continue;
      const lv = p.runLevel;
      const pulse = m.reduceMotion ? 0 : 0.1 * Math.sin(this.ms / Breath);
      // 在「平常 0.2」與「執行中 0.55（±0.1 的緩慢呼吸）」之間依 runLevel 平滑過渡，而不是開關
      this.line(routeIn(p), p.color, 1.2 + 0.8 * lv, (0.2 + (0.35 + pulse) * lv) * p.fade, 12 * lv * p.fade);
      const startX = m.tailEndX(p); // 有小標籤時，輸出連線從標籤尾端接出，不被標籤蓋住
      this.line(routeOut(p, m.outputOffsetY, startX, m.outputOffsetX), p.color, 1, (0.1 + (p.ok > 0 ? 0.1 : 0)) * p.fade, 0);
      if (p.fail > 0) this.line(routeRejected(p, m.outputOffsetY, startX, m.outputOffsetX), Palette.Fail, 1, 0.12 * p.fade, 0);
    }
  }

  private drawChips(m: FlowModel): void {
    m.sessions.forEach((s, i) => {
      const y = m.chipY(i) - Layout.ChipH / 2;
      const active = isActive(s.status);
      const col = s.status === SessionStatus.Waiting ? Palette.Task : Palette.Agent;
      this.fillRR(Layout.ChipX, y, Layout.ChipW, Layout.ChipH, 7, rgba('#12161c'), rgba(col, active ? 0.9 : 0.35), 1.2);
      const dotR = 3.2 + (active && !m.reduceMotion ? 0.5 * Math.sin(this.ms / Breath) : 0);
      this.circle(Layout.ChipX + 12, y + Layout.ChipH / 2, dotR, rgba(active ? col : Palette.Dim));
      this.text(((m.providerLabel === 'AI' ? s.provider || 'Claude' : m.providerLabel) + ' ' + (s.sessionId.startsWith('codex:') ? s.sessionId.slice(6, 10) : s.sessionId.slice(0, 4))).toUpperCase(), Layout.ChipX + 24, y + Layout.ChipH / 2, 11, Palette.Text, { mono: true });
      this.circle(Layout.ChipX + Layout.ChipW, y + Layout.ChipH / 2, 3, rgba(col));
    });
  }

  private drawPills(m: FlowModel): void {
    this.drawAgentNodes(m);
    for (const p of m.pillList) {
      if (p.fade < 0.01) continue; // 已淡完
      const x = p.left, y = p.y - Layout.PillH / 2;
      const lv = p.runLevel;
      const runLabel = p.running > 0 && p.runSeconds > 1.2;
      const hover = this.rows.length > 0 ? p === this.hoverPill : p.key === this.hoverKey;
      this.alpha(p.intro * p.fade, () => { // 新出現時淡入；沒有 AI 時依序淡出
        const corner = Math.min(16, p.h / 2);
        const glow = 6 + 6 * lv + (m.reduceMotion ? 0 : 3 * lv * Math.sin(this.ms / Breath)) + 8 * p.flash + (hover ? 8 : 0);
        this.glowRect(x, y, p.w, p.h, corner, p.color, 1, glow);
        // 邊框一律用方塊自己的顏色（失敗由右邊的 REJECTED 呈現），不隨事件抵達變色
        this.fillRR(x, y, p.w, p.h, corner, rgba('#10141a'), rgba(p.color), 1.4 + 0.6 * Math.max(lv, hover ? 1 : 0));
        // 圖示方塊 + 首字母
        this.fillRR(x + 8, y + 6, 20, 20, 6, rgba(p.color, 0.25));
        this.text(p.name.slice(0, 1).toUpperCase(), x + 18, y + Layout.PillH / 2 + 1, 12, p.color, { bold: true, mono: true, align: 'center' });
        // 名稱與次數
        this.text(shorten(p.name, 13), x + 36, y + Layout.PillH / 2, 12, Palette.Text);
        this.text(runLabel ? `…${p.running}` : '×' + p.count, x + p.w - 28, y + Layout.PillH / 2, 10, runLabel ? Palette.Warn : Palette.Sub, { mono: true, align: 'right' });
        this.text(p.expanded ? '▾' : '▸', x + p.w - 14, y + Layout.PillH / 2, 10, hover ? Palette.Text : Palette.Dim, { mono: true, align: 'center' });
        this.drawRows(p, x, y, corner);
        this.drawTail(m, p);
        // 兩端連接點
        this.circle(x, p.y, 3, rgba(p.color));
        this.circle(x + p.w, p.y, 3, rgba(p.color));
      });
    }
  }

  private drawAgentNodes(m: FlowModel): void {
    for (const a of m.agents) {
      if (a.fade < 0.01) continue;
      this.alpha(a.fade, () => {
        this.drawBrain(Layout.AgentX, a.y, .65, isActive(a.info.status), m.reduceMotion);
        this.text(formatModel(a.info.model), Layout.AgentX, a.y + 45, 10, '#c6f7ff', { bold: true, mono: true, align: 'center' });
      });
    }
  }

  // 展開時：標題列下方列出最近幾筆「真實」呼叫（✓／✕／… 時間 內容 耗時）
  private drawRows(p: FlowPill, x: number, y: number, corner: number): void {
    const open = Math.min(1, Math.max(0, (p.h - Layout.PillH) / 24)); // 展開動畫進行中：內容隨高度淡入，並裁切不外溢
    if (open <= 0.02 || (p.recent.length === 0 && !p.expanded)) return;
    const c = this.ctx;
    c.save();
    this.rr(x, y, p.w, p.h, corner); c.clip();
    c.globalAlpha *= open;
    this.lineSeg(x + 10, y + Layout.PillH, x + p.w - 10, y + Layout.PillH, rgba(p.color, 0.25), 1);
    const chars = Math.max(8, Math.floor((p.w - 150) / 6.2));
    p.recent.forEach((cl, i) => {
      const cy = y + Layout.PillH + Layout.ExpandedPad / 2 + i * Layout.ExpandedRowH + Layout.ExpandedRowH / 2;
      const mark = cl.result === ToolResult.Ok ? '✓' : cl.result === ToolResult.Failed ? '✕' : '…';
      this.text(mark, x + 14, cy, 10.5, cl.result === ToolResult.Ok ? Palette.Ok : cl.result === ToolResult.Failed ? Palette.Fail : Palette.Warn, { mono: true });
      this.text(hhmmss(cl.time), x + 28, cy, 10.5, Palette.Sub, { mono: true });
      this.text(shorten(rowLabel(cl), chars), x + 92, cy, 10.5, Palette.Text, { mono: true });
      this.text(cl.result === ToolResult.Running ? '…' : num1(cl.durationSeconds) + 's', x + p.w - 12, cy, 10.5, Palette.Sub, { mono: true, align: 'right' });
    });
    c.restore();
  }

  // 方塊尾巴的小標籤：執行中（橘、發光脈動）／剛成功（綠 ✓）／剛失敗（紅 ✕），結束一段時間後淡出
  private drawTail(m: FlowModel, p: FlowPill): void {
    const { chips, more } = m.tailOf(p);
    if (chips.length === 0) return;
    const W = tailChipWidth(tailWeight(chips)), H = Layout.TailH, gap = Layout.TailGap;
    let x = p.left + Layout.PillW + Layout.TailLead;
    this.lineSeg(p.left + Layout.PillW, p.y, x, p.y, rgba(p.color, 0.5), 1);
    chips.forEach((chip, i) => {
      const col = chip.state === 'run' ? Palette.Task : chip.state === 'ok' ? Palette.Ok : Palette.Fail;
      const y = p.y - H / 2;
      this.alpha(chip.alpha, () => {
        if (chip.state === 'run') {
          const pulse = m.reduceMotion ? 0.5 : 0.5 + 0.5 * Math.sin(this.ms / Breath);
          this.glowRect(x, y, W, H, 6, col, 1, 5 + 5 * pulse);
        }
        this.fillRR(x, y, W, H, 6, rgba('#12161c'), rgba(col, chip.state === 'run' ? 0.95 : 0.7), 1.2);
        const mark = chip.state === 'run' ? '…' : chip.state === 'ok' ? '✓' : '✕';
        this.text(mark, x + 10, p.y, 10.5, col, { mono: true, bold: true, align: 'center' });
        const secText = num1(chip.seconds) + 's';
        const room = W - 20 - 8 - this.measure(secText, 9.5, false, true) - 6; // 標記、秒數與留白之外，文字能用的寬度
        this.text(this.fitText(tailLabel(chip.call), room, 10), x + 20, p.y, 10, Palette.Text, { mono: true });
        this.text(secText, x + W - 6, p.y, 9.5, Palette.Sub, { mono: true, align: 'right' });
      });
      if (i < chips.length - 1) this.lineSeg(x + W, p.y, x + W + gap, p.y, rgba(col, 0.4 * chip.alpha), 1);
      x += W + gap;
    });
    if (more > 0) this.text('+' + more, x, p.y, 10, Palette.Sub, { mono: true });
    this.circle(m.tailEndX(p), p.y, 3, rgba(p.color)); // 輸出連線的新起點
  }

  private drawHub(m: FlowModel): void {
    const { x, y } = Layout.Hub;
    this.drawBrain(x, y, 1, m.busy, m.reduceMotion);
    if (m.modelText.length > 0) this.text(m.modelText, x, y + 65, 15, '#c6f7ff', { bold: true, mono: true, align: 'center' });
  }

  private drawBrain(x: number, y: number, scale: number, busy: boolean, reduceMotion: boolean): void {
    const phase = reduceMotion ? 0 : this.ms / (busy ? 700 : 1400);
    const breath = reduceMotion ? 1 : 1 + Math.sin(phase) * (busy ? .025 : .01);
    const bob = reduceMotion ? 0 : Math.sin(phase * .7) * 1.8 * scale;
    const c = this.ctx;
    c.save(); c.translate(x, y + bob); c.scale(breath * scale, breath * scale);
    this.glowStroke(BrainShape, '#3de5ff', .7, 17);
    this.fillPath(BrainShape, rgba('#0a1d2c'), rgba('#62e6ff', .9), 1.8, true);
    BrainFoldPaths.forEach((path, i) => {
      const level = reduceMotion ? .6 : .45 + .45 * (1 + Math.sin(phase * 1.4 - i * .7)) / 2;
      this.fillPath(path, null, rgba(i % 3 === 0 ? '#c59aff' : '#38d9ef', level), 1.4, true);
    });
    BrainJunctions.forEach(([nx, ny], i) => {
      const pulse = reduceMotion ? .3 : Math.pow(Math.max(0, Math.sin(phase * 2 - i * .8)), 6);
      this.circle(nx, ny, 3.5 + pulse * 2, rgba('#3de5ff', .1 + pulse * .25));
      this.circle(nx, ny, 1.3 + pulse, rgba('#d4fbff', .45 + pulse * .55));
    });
    if (!reduceMotion) {
      const scanY = -44 + ((this.ms / (busy ? 2400 : 4800)) % 1) * 92;
      c.save(); c.clip(BrainShape);
      c.fillStyle = rgba('#71f4ff', .08); c.fillRect(-52, scanY - 9, 104, 10);
      this.lineSeg(-52, scanY, 52, scanY, rgba('#adfaff', .65), 1);
      c.restore();
    }
    c.restore();
  }

  private drawOutputs(models: readonly FlowModel[]): void {
    this.drawArmor(false, models);
    this.drawArmor(true, models);
    this.text('成功 ' + models.reduce((n, m) => n + m.stats.ok, 0), Layout.Out.x, Layout.Out.y + 66, 12, Palette.Ok, { bold: true, mono: true, align: 'center' });
    this.text('失敗 ' + models.reduce((n, m) => n + m.stats.fail, 0), Layout.Rej.x, Layout.Rej.y + 66, 12, Palette.Fail, { bold: true, mono: true, align: 'center' });
  }

  private drawArmor(leg: boolean, models: readonly FlowModel[]): void {
    const reduce = models.every(m => m.reduceMotion);
    const busy = models.some(m => m.busy);
    const flash = Math.max(...models.map(m => leg ? m.rejFlash : m.outFlash));
    const phase = reduce ? 0 : this.ms / (busy ? 500 : 1100);
    const angle = reduce ? 0 : Math.sin(phase) * (busy ? 4 : 1.2) + flash * (leg ? -6 : 7);
    const color = leg ? Palette.Fail : Palette.Ok;
    const anchor = leg ? Layout.Rej : Layout.Out;
    const pivot = leg ? { x: -3, y: -7 } : { x: -17, y: 24 };
    const c = this.ctx;
    c.save(); c.translate(anchor.x, anchor.y);
    const plate = (shape: Path2D, fill: string, bright = false): void => {
      this.glowStroke(shape, color, bright ? .5 + flash : .2, bright ? 7 + flash * 10 : 4);
      this.fillPath(shape, rgba(fill), rgba(bright ? color : '#7090a8', .95), bright ? 1.5 : 1.1, true);
    };
    this.lineSeg(leg ? -46 : -54, 0, pivot.x, pivot.y, rgba(color, .6), 2);
    plate(leg ? ArmorShapes.Thigh : ArmorShapes.UpperArm, '#172635');
    plate(leg ? ArmorShapes.ThighFacet : ArmorShapes.UpperFacet, '#38536b');
    this.circle(pivot.x, pivot.y, 8, rgba('#0d1925'), rgba('#8da8bd'), 1.4);
    this.circle(pivot.x, pivot.y, 3, rgba(color, .6 + flash * .4));
    c.translate(pivot.x, pivot.y); c.rotate(angle * Math.PI / 180); c.translate(-pivot.x, -pivot.y);
    plate(leg ? ArmorShapes.Shin : ArmorShapes.Forearm, '#152938', true);
    plate(leg ? ArmorShapes.ShinFacet : ArmorShapes.ForeFacet, '#42657a');
    plate(leg ? ArmorShapes.Boot : ArmorShapes.Fist, '#243e52', true);
    if (leg) plate(ArmorShapes.BootFacet, '#55778d');
    else this.fillPath(ArmorShapes.Fingers, null, rgba('#a9d9ec', .8), 1.2, true);
    const u = reduce ? .5 : (this.ms / (busy ? 1300 : 2600)) % 1;
    const px = leg ? -3 + 11 * u : -16 + 30 * u;
    const py = leg ? -7 + 37 * u : 20 - 44 * u;
    this.circle(px, py, 6, rgba(color, .16));
    this.circle(px, py, 1.7, rgba('#e5ffff', .9));
    c.restore();
  }

  private drawBubbles(m: FlowModel): void {
    const h = 26, tail = 6, stackGap = 4;
    const stacked = new Map<string, number>(); // 同一個位置同時有幾顆：第 2 顆起往外排開，不疊在一起
    for (const b of m.bubbles.items) {
      if (b.anchorKey === BubbleAnchors.Hub) continue;
      const pill = m.pillList.find(p => p.key === b.anchorKey);
      const agent = pill ? undefined : m.agents.find(a => a.key === b.anchorKey);
      if (!pill && m.agents.some(a => a.key === b.anchorKey)) continue;
      if (!pill && !agent && !BubbleAnchors.isFixed(b.anchorKey)) continue;
      const nth = stacked.get(b.anchorKey) ?? 0;
      stacked.set(b.anchorKey, nth + 1);
      const dy = nth * (h + stackGap);
      // 可見度 = 泡泡自己的淡入淡出 × 它指向的元素的淡出（AI 主節點跟 AI 一組、REJECTED 跟 output 一組）
      const follow = pill?.fade ?? agent?.fade ?? (b.anchorKey === BubbleAnchors.Hub ? m.source : m.sink);
      const alpha = b.alpha(BubbleQueue.FadeSeconds) * follow;
      if (alpha < 0.02) continue;

      const text = this.fitText(b.text, BubbleMaxTextW, 11, false); // 字太多就以 ... 結尾，泡泡不會無限變寬
      const w = this.measure(text, 11, false, false) + 22;
      let bx: number, by: number;
      const tailPath = new Path2D();
      if (pill) {
        // 方塊：泡泡在右側，尾巴朝左
        // 有尾巴小標籤時，泡泡讓到標籤之後，兩者都看得到
        const edge = m.tailEndX(pill);
        bx = edge + 18; by = pill.y - h / 2 + dy;
        if (nth === 0) { // 只有第一顆畫尾巴；往下排開的幾顆是同一個方塊的補充說明
          tailPath.moveTo(edge + 5, pill.y); tailPath.lineTo(bx + 1, pill.y - tail); tailPath.lineTo(bx + 1, pill.y + tail); tailPath.closePath();
        }
      } else if (b.anchorKey === BubbleAnchors.Rejected) {
        const cy = Layout.Rej.y + m.outputOffsetY;
        bx = Layout.Rej.x + m.outputOffsetX - 105 - w; by = cy - h / 2 + dy;
        if (nth === 0) {
          tailPath.moveTo(Layout.Rej.x + m.outputOffsetX - 52, cy); tailPath.lineTo(bx + w - 1, cy - tail); tailPath.lineTo(bx + w - 1, cy + tail); tailPath.closePath();
        }
      } else {
        // 子代理與 AI 主節點：泡泡在上方，尾巴朝下；REJECTED：泡泡在下方，尾巴朝上
        const hub = b.anchorKey === BubbleAnchors.Hub;
        const [cx, top, tipY, below] = agent
          ? [Layout.AgentX, agent.y - Layout.AgentH / 2 - 14 - h, agent.y - Layout.AgentH / 2 - 3, false] as const
          : hub ? [Layout.Hub.x, Layout.Hub.y - Layout.HubR - 18 - h, Layout.Hub.y - Layout.HubR - 5, false] as const
          : [Layout.Rej.x + m.outputOffsetX, Layout.Rej.y + 15 + 14, Layout.Rej.y + 17, true] as const;
        bx = cx - w / 2; by = below ? top + dy : top - dy; // 往外排開：上方的往上疊、下方的往下疊
        if (nth === 0) {
          const baseY = below ? by + 1 : by + h - 1;
          tailPath.moveTo(cx, tipY); tailPath.lineTo(cx - tail, baseY); tailPath.lineTo(cx + tail, baseY); tailPath.closePath();
        }
      }
      this.alpha(alpha, () => {
        this.glowRect(bx, by, w, h, 9, b.color, 0.8, 6);
        this.fillPath(tailPath, rgba('#161b22'), rgba(b.color), 1.2); // 尾巴先畫，方塊蓋在上面，兩者接縫就看不到
        this.fillRR(bx, by, w, h, 9, rgba('#161b22'), rgba(b.color), 1.2);
        this.text(text, bx + w / 2, by + h / 2, 11, Palette.Text, { align: 'center' });
      });
    }
  }

  private drawParticles(m: FlowModel): void {
    for (const pt of m.particles) {
      const p = m.pillList.find(x => x.key === pt.pillKey);
      if (!p) continue;
      // 光點要走在畫出來的線上：輸出線從標籤尾端出發（drawEdges），光點的路徑也要用同一個起點
      const startX = m.tailEndX(p);
      const path = pt.kind === 'in' ? routeIn(p) : pt.kind === 'out' ? routeOut(p, m.outputOffsetY, startX, m.outputOffsetX) : routeRejected(p, m.outputOffsetY, startX, m.outputOffsetX);
      for (let i = 8; i >= 0; i--) { // 彗星尾巴
        const q = cubic(path, Math.min(1, Math.max(0, pt.t - i * 0.03)));
        const r = 4.6 - i * 0.4;
        this.circle(q.x, q.y, r, rgba(pt.color, (1 - i / 9) * 0.85));
      }
      const hd = cubic(path, Math.min(1, Math.max(0, pt.t)));
      this.glowCircle(hd.x, hd.y, 2.2, pt.color, 1, 12);
      this.circle(hd.x, hd.y, 2.2, '#ffffff');
    }
  }

  // ── 機器人 ───────────────────────────────────────────────────────────
  // 位置、動作權重、推進強度都來自 FlowModel；這裡只負責「依權重混合各關節角度」並畫外形。
  // 動作：站（待命）、坐（AI 停下來）、飛（移動中，身體往前倒、領頭那隻手舉起）、攻擊（側身對著執行中的工具出拳）、
  //       歡呼（成功，雙手舉起小跳）、受創（失敗，眼睛變紅、抖動後仰）。主機器人核心與眼睛是青色、子代理的是橘色。
  private drawAliens(m: FlowModel): void {
    for (const u of m.aliens) {
      if (u.isMonster) this.drawMonster(m, u); // 子代理：怪獸機甲
      else this.drawAlien(m, u); // 主 AI：超級機器人
    }
  }

  // ── 怪獸機甲（子代理）────────────────────────────────────────────────────
  // 與主機器人共用同一套動作（位置、權重、出拳節奏都來自 FlowModel），只是外形不同：
  // 翅膀在飛行與攻擊時張開、平常收攏；尾巴微微擺動；左手是肩砲，右手是鉤爪。
  private drawMonster(m: FlowModel, u: FlowAlien): void {
    if (u.alpha < 0.02) return;
    const Black = '#1a1d24', Gold = '#e8b84a', GoldDark = '#a67c1a', ClawGold = '#f4e2a0', Red = '#d8402a', RedDark = '#8e1f14',
      Blue = '#4a7fd4', BlueDark = '#2b4aa6', White = '#e9edf2', Steel = '#8e99a6';
    const c = this.ctx;
    const q = u.scale * Layout.AlienUnit;
    const accent = u.tint ?? Palette.Task; // 眼睛與核心：橘色（分流的增援改用工具方塊的顏色）
    const eye = u.wHurt > 0.5 ? Palette.Fail : '#ff5a3a';
    const drop = 4.5 * u.wSit;
    const cy = u.y + u.bob + drop * q;
    const shake = m.reduceMotion ? 0 : Math.sin(this.ms / 18) * u.wHurt * 1.1;
    const deg = u.lean * 62 * u.wFly + u.tilt * 57 * 0.6 * (1 - u.wFly) - u.wHurt * 9 + u.wAttack * u.face * 7;
    const punch = u.wAttack * Math.max(u.punch, u.punchB);
    const turn = u.wAttack * Math.PI / 2;
    const fx = Math.cos(turn), sx = Math.sin(turn);
    const sideOnly = u.wAttack > 0.97;
    // 翅膀：飛行／攻擊／歡呼時張開；平常收攏並隨呼吸微微起伏；飛行時快速拍動
    const spread = 0.55 + 0.45 * Math.max(u.wFly, u.wCheer, u.wAttack * 0.6);
    const flap = m.reduceMotion ? 0 : (Math.sin(this.ms / 90) * 0.16 * u.wFly + Math.sin(this.ms / 380 + u.seed) * 0.04);

    c.save();
    c.globalAlpha *= Math.min(1, u.alpha);
    this.glowCircle(u.x, cy, 10 * q, accent, 0.5 + 0.3 * punch, 14 * q);
    c.translate(u.x, cy + 6 * q); c.rotate(deg * Math.PI / 180); c.translate(-u.x, -(cy + 6 * q));

    if (!sideOnly) {
      c.save();
      c.translate(u.x + shake * q, cy);
      c.scale(q * Math.max(fx, 0.03), q);

      // 翅膀與尾巴（在身體後面）
      for (const side of [-1, 1]) {
        c.save(); c.translate(side * 4.6, -4.2); c.scale(side * spread, spread * (1 + flap));
        this.fillPath(WingGeo, rgba(Red), rgba(Gold), 0.7);
        for (const [x, y] of [[21, -18], [22, -3], [16, 4]]) this.lineSeg(0, 0, x, y, rgba(RedDark), 0.9, true); // 翼骨
        c.restore();
      }
      c.save(); c.translate(0, Math.sin(this.ms / 300 + u.seed) * 0.4);
      this.fillPath(TailGeo, null, rgba(Blue), 2.4, true);
      c.restore();

      // 腿與鉤爪大腳；腳底推進火焰
      const flame = 2.2 + 5.5 * u.thrust + 3 * u.wFly + 0.9 * Math.sin(this.ms / 55 + u.x);
      for (const side of [-1, 1]) {
        const bx = side * (3.8 + 2.2 * u.wSit - 1.6 * u.wFly);
        const footY = 11.2 - drop;
        c.save(); c.translate(bx, footY + 5.4); c.scale(1, flame);
        this.fillPath(FlameGeo, rgba('#ff8a3a', 0.6 + 0.4 * u.thrust));
        c.restore();
        this.fillRR(bx - 2.1, 4.5, 4.2, 7 - drop, 0.8, rgba(Black), rgba(Gold), 0.5); // 黑色裝甲腿
        this.circle(bx, footY - 0.2, 1.7, rgba(White), rgba(Steel), 0.4); // 白色膝甲
        c.save(); c.translate(bx, footY); this.fillPath(FootGeo, rgba(ClawGold), rgba(GoldDark), 0.5); c.restore(); // 金色三爪大腳
      }
      this.fillRR(-4.8, 3.4, 9.6, 2.4, 0.6, rgba(Gold), rgba(GoldDark), 0.5); // 金色腰帶

      // 手臂：與主機器人共用同一套角度混合；左手＝肩砲，右手＝鉤爪
      const lead = u.lean >= 0 ? 1 : -1;
      const aimDeg = Math.atan2(-u.aimX, u.aimY) * 180 / Math.PI;
      const tips: { x: number; y: number; p: number }[] = [{ x: 0, y: 0, p: 0 }, { x: 0, y: 0, p: 0 }];
      const arms = (): void => {
        for (const side of [-1, 1]) {
          let a = lerp(6, 22, u.wSit);
          a = lerp(a, side === lead ? 158 : 26, u.wFly);
          a = lerp(a, 165, u.wCheer);
          if (side === u.waveSide) a = lerp(a, 150 + 18 * Math.sin(this.ms / 110), u.wWave);
          a = lerp(a, 55 + 14 * Math.sin(this.ms / 60 + side), u.wHurt);
          let theta = -side * a;
          const p = side > 0 ? u.punch : u.punchB;
          const ext = 7.5 * p * u.wAttack;
          theta = lerp(theta, aimDeg - side * 6, u.wAttack);
          const len = 7 + ext;
          c.save();
          c.translate(side * 8.6, -2.5); c.rotate(theta * Math.PI / 180); c.translate(-side * 8.6, 2.5);
          this.fillRR(side * 8.6 - 1.9, -2.5, 3.8, len, 0.9, rgba(Black), rgba(Gold), 0.5); // 黑色裝甲臂
          this.fillRR(side * 8.6 - 2.0, -2.5 + len * 0.45, 4.0, 1.0, 0.3, rgba(Gold)); // 金色臂環
          if (side < 0) { // 肩砲：砲管＋砲口
            this.fillRR(side * 8.6 - 1.3, -2.5 + len, 2.6, 3.8, 0.6, rgba(Steel), rgba(Black), 0.5);
            this.fillRR(side * 8.6 - 1.7, -2.5 + len + 3.2, 3.4, 1.0, 0.3, rgba(Black));
          } else { // 藍色鉤爪手＋三根金爪
            this.circle(side * 8.6, -2.5 + len + 1.2, 2.3, rgba(Blue), rgba(BlueDark), 0.5);
            for (const dx of [-1.4, 0, 1.4]) { // 爪子要接在手上：x 是「手的位置 + 偏移」（曾漏掉手的位置，三根爪子就畫到兩腿中間去了）
              const cx = side * 8.6 + dx;
              this.fillPath(poly([cx - 0.5, -2.5 + len + 2.8], [cx + 0.5, -2.5 + len + 2.8], [cx, -2.5 + len + 5]), rgba(ClawGold), null, 0, false);
            }
          }
          c.restore();
          const rad = theta * Math.PI / 180;
          tips[side > 0 ? 1 : 0] = { x: side * 8.6 - (len + 5) * Math.sin(rad), y: -2.5 + (len + 5) * Math.cos(rad), p: p * u.wAttack };
        }
      };
      if (u.wAttack <= 0.5) arms();

      this.fillPath(MonsterChestGeo, rgba(Black), rgba(Gold), 0.6); // 黑色裝甲胸
      this.fillPath(poly([-2.6, -5.4], [2.6, -5.4], [0, 1.8]), rgba(White)); // 白色 V 形胸板
      for (const side of [-1, 1]) {
        this.fillRR(side * 7.4 - 2.8, -6.8, 5.6, 4.6, 1.2, rgba(Black), rgba(Gold), 0.6); // 肩甲
        this.lineSeg(side * 5.2, -3.4, side * 3.6, -1, rgba(Gold), 0.8, true); // 胸側金線
      }
      this.glowCircle(0, -1.8, 1.6, accent, 1, 5);
      this.circle(0, -1.8, 1.5 + 0.5 * punch, rgba(accent), rgba('#ffffff', 0.8), 0.4); // 胸口核心
      if (u.wAttack > 0.5) arms();

      // 頭：藍色頭盔、白色口罩、黑色面罩與發光眼、金色中央尖角與兩側刀刃
      for (const side of [-1, 1]) { c.save(); c.scale(side, 1); this.fillPath(BladeGeo, rgba(Gold), rgba(GoldDark), 0.5); c.restore(); }
      this.ellipse(0, -9, 3.9, 3.6, rgba(Blue), rgba(BlueDark), 0.6);
      this.fillPath(MuzzleGeo, rgba(White), rgba(Steel), 0.4);
      this.fillRR(-3.2, -10.6, 6.4, 2.2, 0.9, rgba(Black));
      this.fillPath(MonsterHornGeo, rgba(Gold), rgba(GoldDark), 0.5);
      const look = m.reduceMotion ? 0 : Math.min(0.9, Math.max(-0.9, u.tilt * 3));
      for (const side of [-1, 1]) this.ellipse(side * 1.6 + look, -9.5, 0.95, 0.55, rgba(eye));

      for (const t of tips)
        if (t.p > 0.15 && u.wAttack < 0.5) this.glowCircle(t.x, t.y, 1.9 * (0.6 + 0.8 * t.p), sparkColor(u, '#ff9a4a'), Math.min(1, t.p * 1.2), 6);
      c.restore();
    }

    if (sx > 0.03) this.drawMonsterSide(u, q, cy, sx, accent, eye, spread, flap); // 側面（攻擊時）
    c.restore();
  }

  private drawMonsterSide(u: FlowAlien, q: number, cy: number, sx: number, accent: string, eye: string, spread: number, flap: number): void {
    const Black = '#1a1d24', Gold = '#e8b84a', GoldDark = '#a67c1a', ClawGold = '#f4e2a0', Red = '#d8402a', RedDark = '#8e1f14',
      Blue = '#4a7fd4', BlueDark = '#2b4aa6', White = '#e9edf2', Steel = '#8e99a6';
    const c = this.ctx;
    c.save();
    c.translate(u.x, cy);
    c.scale(q * sx * u.face, q);

    // 翅膀（身體後面，往後上方張開）與尾巴
    for (const [dx, dy, a] of [[-0.6, -3.6, 0.55], [-1.6, -4.2, 1]] as const) { // 遠側的翅膀較暗
      c.save(); c.translate(dx, dy); c.scale(-spread * (a === 1 ? 1 : 0.9), spread * (1 + flap) * (a === 1 ? 1 : 0.9));
      c.globalAlpha *= a === 1 ? 1 : 0.75;
      this.fillPath(WingGeo, rgba(a === 1 ? Red : RedDark), rgba(Gold), 0.7);
      for (const [x, y] of [[21, -18], [22, -3], [16, 4]]) this.lineSeg(0, 0, x, y, rgba(RedDark), 0.9, true);
      c.restore();
    }
    this.fillPath(SideTailGeo, null, rgba(Blue), 2.4, true);

    // 腿：後腳往後、前腳往前（弓步），金色鉤爪大腳朝前
    for (const [hx, th] of [[-1.0, 18], [1.2, -16]] as const) {
      c.save(); c.translate(hx, 4.5); c.rotate(th * Math.PI / 180); c.translate(-hx, -4.5);
      this.fillRR(hx - 2, 4.5, 4, 7.5, 0.8, rgba(Black), rgba(Gold), 0.5);
      c.restore();
      const rad = th * Math.PI / 180;
      const tx = hx - 7.5 * Math.sin(rad), ty = 4.5 + 7.5 * Math.cos(rad);
      this.circle(tx, ty - 0.4, 1.6, rgba(White), rgba(Steel), 0.4);
      c.save(); c.translate(tx, ty); this.fillPath(SideFootGeo, rgba(ClawGold), rgba(GoldDark), 0.5); c.restore();
    }
    this.fillRR(-3.6, 3.4, 7.2, 2.4, 0.6, rgba(Gold), rgba(GoldDark), 0.5);

    // 遠側的手 → 身體 → 近側的手（肩砲）→ 肩甲：兩手輪流出擊
    const tips: { x: number; y: number; p: number }[] = [];
    const arm = (px: number, py: number, p: number, far: boolean, cannon: boolean): void => {
      const theta = lerp(-30, -92, p);
      const len = 7 + 7.5 * p;
      c.save(); c.translate(px, py); c.rotate(theta * Math.PI / 180); c.translate(-px, -py);
      this.fillRR(px - 1.8, py, 3.6, len, 0.9, rgba(far ? '#10121a' : Black), rgba(Gold), 0.5);
      this.fillRR(px - 1.9, py + len * 0.45, 3.8, 1.0, 0.3, rgba(Gold));
      if (cannon) { // 肩砲：砲管＋砲口
        this.fillRR(px - 1.2, py + len, 2.4, 4.2, 0.6, rgba(Steel), rgba(Black), 0.5);
        this.fillRR(px - 1.6, py + len + 3.6, 3.2, 1.0, 0.3, rgba(Black));
      } else {
        this.circle(px, py + len + 1.2, 2.1, rgba(far ? BlueDark : Blue), rgba(BlueDark), 0.5);
        for (const dx of [-1.2, 0, 1.2]) this.fillPath(poly([px + dx - 0.45, py + len + 2.6], [px + dx + 0.45, py + len + 2.6], [px + dx, py + len + 4.6]), rgba(ClawGold));
      }
      c.restore();
      const rad = theta * Math.PI / 180;
      tips.push({ x: px - (len + 5.2) * Math.sin(rad), y: py + (len + 5.2) * Math.cos(rad), p });
    };
    arm(-0.6, -3.2, u.punchB, true, false);
    this.fillPath(MonsterChestSideGeo, rgba(Black), rgba(Gold), 0.6);
    this.fillPath(poly([2.2, -5.2], [3.5, -5.2], [2.8, 2], [1.8, 2]), rgba(White)); // 前胸的白色板
    this.glowCircle(2.4, -1.6, 1.3, accent, 1, 4);
    this.circle(2.4, -1.6, 1.2, rgba(accent), rgba('#ffffff', 0.8), 0.4);
    arm(0.6, -3.4, u.punch, false, true);
    this.fillRR(-2.6, -7, 5.2, 4.6, 1.2, rgba(Black), rgba(Gold), 0.6); // 肩甲

    // 頭：側面的藍色頭盔、白色口罩往前、紅眼、向前傾的金角與向後掃的刀刃
    this.fillPath(SideBladeGeo, rgba(Gold), rgba(GoldDark), 0.5);
    this.ellipse(0.6, -9, 3.7, 3.5, rgba(Blue), rgba(BlueDark), 0.6);
    this.fillPath(SideMuzzleGeo, rgba(White), rgba(Steel), 0.4);
    this.fillRR(0.8, -10.8, 3.2, 2.0, 0.8, rgba(Black));
    this.fillPath(SideHornGeo, rgba(Gold), rgba(GoldDark), 0.5);
    this.ellipse(2.7, -9.8, 0.95, 0.55, rgba(eye));

    for (const t of tips)
      if (t.p > 0.15) this.glowCircle(t.x, t.y, 1.9 * (0.6 + 0.8 * t.p), sparkColor(u, '#ff9a4a'), Math.min(1, t.p * 1.2), 6);
    c.restore();
  }

  private drawAlien(m: FlowModel, u: FlowAlien): void {
    if (u.alpha < 0.02) return;
    const Silver = '#c9d1da', SilverDark = '#8e99a6', Red = '#d8322b', RedLight = '#ff7a6a', Navy = '#2b4aa6',
      NavyLight = '#7aa0ff', Gold = '#f2c230', Dark = '#12161c';
    const c = this.ctx;
    const q = u.scale * Layout.AlienUnit; // 約 85 像素高（子代理 0.7 倍）
    const accent = u.tint ?? '#7ff3ff'; // 分流的增援：光暈用它正在打的工具方塊的顏色
    const eye = u.wHurt > 0.5 ? Palette.Fail : accent;
    const drop = 4.5 * u.wSit; // 坐下：胸口放低、腿縮短、靴子外八；腳底仍踩在同一條地平線
    const cy = u.y + u.bob + drop * q;
    const shake = m.reduceMotion ? 0 : Math.sin(this.ms / 18) * u.wHurt * 1.1;
    const deg = u.lean * 62 * u.wFly + u.tilt * 57 * 0.6 * (1 - u.wFly) - u.wHurt * 9 + u.wAttack * u.face * 7; // 出拳時身體微微前傾
    const punch = u.wAttack * Math.max(u.punch, u.punchB);
    // 攻擊時轉成側身：正面的身體橫向縮窄（cos）、側面的剪影橫向展開（sin），像轉身一樣；全轉過去之後正面就不畫了
    const turn = u.wAttack * Math.PI / 2;
    const fx = Math.cos(turn), sx = Math.sin(turn);
    const sideOnly = u.wAttack > 0.97;

    c.save();
    c.globalAlpha *= Math.min(1, u.alpha);
    this.glowCircle(u.x, cy, 9 * q, accent, 0.6 + 0.3 * punch, 14 * q);
    // 旋轉（以腳邊為軸）
    c.translate(u.x, cy + 6 * q); c.rotate(deg * Math.PI / 180); c.translate(-u.x, -(cy + 6 * q));

    if (!sideOnly) {
      c.save();
      c.translate(u.x + shake * q, cy);
      c.scale(q * Math.max(fx, 0.03), q);

      // 腿與靴子；腳底推進火焰（長度由真實移動速度決定，飛行時最長）
      const flame = 2.2 + 5.5 * u.thrust + 3 * u.wFly + 0.9 * Math.sin(this.ms / 55 + u.x);
      for (const side of [-1, 1]) {
        const bx = side * (3.4 + 2.2 * u.wSit - 1.6 * u.wFly);
        c.save(); c.translate(bx, 14 - drop); c.scale(1, flame);
        this.fillPath(FlameGeo, rgba('#ffb347', 0.6 + 0.4 * u.thrust));
        c.restore();
        this.fillRR(bx - 1.8, 4.5, 3.6, 7 - drop, 0.8, rgba(Silver), rgba(SilverDark), 0.6); // 腿
        this.fillRR(bx - 2.6, 10.8 - drop, 5.2, 3.4, 1, rgba(Navy), rgba(NavyLight), 0.6); // 藍色重靴
      }
      c.fillStyle = rgba(Dark); c.fillRect(-4.6, 3.6, 9.2, 2.6); // 腰

      // 手臂：每個動作各有一個目標角度（0＝垂下，往外舉為正），依權重混合；攻擊時雙手都朝向目標並伸縮
      const lead = u.lean >= 0 ? 1 : -1;
      const aimDeg = Math.atan2(-u.aimX, u.aimY) * 180 / Math.PI;
      const tips: { x: number; y: number; p: number }[] = [{ x: 0, y: 0, p: 0 }, { x: 0, y: 0, p: 0 }]; // 兩個拳頭尖端與各自的出拳程度
      const arms = (): void => { // 平常畫在胸甲後面；攻擊時改畫在前面（一隻手要橫過胸前）
        for (const side of [-1, 1]) {
          let a = lerp(6, 22, u.wSit);
          a = lerp(a, side === lead ? 158 : 26, u.wFly);
          a = lerp(a, 165, u.wCheer);
          if (side === u.waveSide) a = lerp(a, 150 + 18 * Math.sin(this.ms / 110), u.wWave); // 揮手：一隻手舉高左右擺
          a = lerp(a, 55 + 14 * Math.sin(this.ms / 60 + side), u.wHurt);
          let theta = -side * a;
          const p = side > 0 ? u.punch : u.punchB; // 兩手錯開半個週期：一左一右輪流出拳
          const ext = 7.5 * p * u.wAttack;
          theta = lerp(theta, aimDeg - side * 6, u.wAttack); // 雙手都朝向目標（左右各偏 6°）
          const len = 7 + ext;
          c.save();
          c.translate(side * 8.4, -2.5); c.rotate(theta * Math.PI / 180); c.translate(-side * 8.4, 2.5);
          this.fillRR(side * 8.4 - 1.5, -2.5, 3, len, 0.8, rgba(Silver), rgba(SilverDark), 0.6); // 手臂
          this.circle(side * 8.4, -2.5 + len + 1.1, 2.1, rgba(Navy), rgba(NavyLight), 0.6); // 拳頭
          this.ellipse(side * 8.4, -2.5 + len + 3.2, 3.4, 1.1, rgba('#e6e9ee'), rgba(Gold), 0.6); // 拳盾（小飛碟）
          c.restore();
          const rad = theta * Math.PI / 180; // 拳頭尖端（單位座標）
          tips[side > 0 ? 1 : 0] = { x: side * 8.4 - (len + 4) * Math.sin(rad), y: -2.5 + (len + 4) * Math.cos(rad), p: p * u.wAttack };
        }
      };
      if (u.wAttack <= 0.5) arms();

      this.fillPath(ChestGeo, rgba(Red), rgba(RedLight), 0.6); // 紅色胸甲
      for (const side of [-1, 1]) this.fillRR(side * 7.2 - 2.4, -6.2, 4.8, 4.2, 1.2, rgba(Red), rgba(RedLight), 0.6); // 肩甲
      this.glowCircle(0, -0.8, 2.2, accent, 1, 5);
      this.circle(0, -0.8, 2 + 0.5 * punch, rgba(accent), rgba('#ffffff', 0.8), 0.5); // 胸口核心（出拳時變亮）
      if (u.wAttack > 0.5) arms();

      this.ellipse(0, -9, 3.9, 3.5, rgba(Silver), rgba(SilverDark), 0.6); // 頭盔
      for (const side of [-1, 1]) { // 金色彎月長角
        c.save(); c.scale(side, 1);
        this.fillPath(HornGeo, null, rgba(Gold), 1.5, true);
        c.restore();
      }
      this.fillPath(CrestGeo, rgba(Red)); // 頭頂紅冠
      this.fillRR(-2.8, -10.4, 5.6, 2.4, 1, rgba(Dark)); // 面罩
      const look = m.reduceMotion ? 0 : Math.min(0.9, Math.max(-0.9, u.tilt * 3)); // 眼睛朝飛行方向偏一點
      for (const side of [-1, 1]) this.ellipse(side * 1.4 + look, -9.2, 0.95, 0.6, rgba(eye));

      for (const t of tips) // 出拳命中的火花（每個拳頭各一個）
        if (t.p > 0.15 && u.wAttack < 0.5) this.glowCircle(t.x, t.y, 1.8 * (0.6 + 0.8 * t.p), sparkColor(u, '#ffd36b'), Math.min(1, t.p * 1.2), 6);
      c.restore();
    }

    if (sx > 0.03) this.drawAlienSide(u, q, cy, sx, accent, eye); // 側面剪影（攻擊時）
    c.restore();
  }

  // ── 側面剪影（攻擊用）：面向 +x，原點＝胸口中心；face＝−1 時整個鏡射 ──────────────────────
  private drawAlienSide(u: FlowAlien, q: number, cy: number, sx: number, accent: string, eye: string): void {
    const Silver = '#c9d1da', SilverDark = '#8e99a6', Red = '#d8322b', RedLight = '#ff7a6a', Navy = '#2b4aa6',
      NavyDark = '#1f3680', NavyLight = '#7aa0ff', Gold = '#f2c230', Dark = '#12161c', Pack = '#3a4452';
    const c = this.ctx;
    c.save();
    c.translate(u.x, cy);
    c.scale(q * sx * u.face, q);

    // 背包推進器與往後噴的火焰
    const flame = 2 + 4.5 * u.thrust + 0.9 * Math.sin(this.ms / 55 + u.x);
    c.save(); c.translate(-4.6, 2.2); c.rotate(28 * Math.PI / 180); c.scale(1.2, flame);
    this.fillPath(FlameGeo, rgba('#ffb347', 0.6 + 0.4 * u.thrust));
    c.restore();
    this.fillRR(-6.4, -6, 3.4, 8.4, 1, rgba(Pack), rgba(SilverDark), 0.6);

    // 腿：後腳往後、前腳往前（弓步），靴子朝前
    for (const [hx, th] of [[-1.0, 18], [1.2, -16]] as const) {
      c.save(); c.translate(hx, 4.5); c.rotate(th * Math.PI / 180); c.translate(-hx, -4.5);
      this.fillRR(hx - 1.7, 4.5, 3.4, 7.5, 0.8, rgba(Silver), rgba(SilverDark), 0.6);
      c.restore();
      const rad = th * Math.PI / 180;
      const tx = hx - 7.5 * Math.sin(rad), ty = 4.5 + 7.5 * Math.cos(rad);
      this.fillRR(tx - 2.4, ty - 0.6, 6.4, 3.2, 1, rgba(Navy), rgba(NavyLight), 0.6); // 靴子（腳尖朝前）
    }
    c.fillStyle = rgba(Dark); c.fillRect(-3.2, 3.4, 6.4, 2.6); // 腰

    // 遠側的手（畫在身體後面、顏色暗一點）→ 身體 → 近側的手 → 肩甲：兩手輪流出拳（punch / punchB）
    const tips: { x: number; y: number; p: number }[] = [];
    const arm = (px: number, py: number, p: number, far: boolean): void => {
      const theta = lerp(-30, -92, p); // 收回時拳頭在胸前（斜下），打出去時水平向前
      const len = 7 + 7.5 * p;
      c.save(); c.translate(px, py); c.rotate(theta * Math.PI / 180); c.translate(-px, -py);
      this.fillRR(px - 1.4, py, 2.8, len, 0.8, rgba(far ? SilverDark : Silver), rgba(SilverDark), 0.6);
      this.circle(px, py + len + 1.1, 2.0, rgba(far ? NavyDark : Navy), rgba(NavyLight), 0.6); // 拳頭
      this.ellipse(px, py + len + 3.2, 3.4, 1.1, rgba(far ? '#aab2bd' : '#e6e9ee'), rgba(Gold), 0.6); // 拳盾（側看是一條橫線）
      c.restore();
      const rad = theta * Math.PI / 180;
      tips.push({ x: px - (len + 4) * Math.sin(rad), y: py + (len + 4) * Math.cos(rad), p });
    };
    arm(-0.6, -3.2, u.punchB, true);
    this.fillPath(ChestSideGeo, rgba(Red), rgba(RedLight), 0.6); // 側面的胸甲
    this.glowCircle(2.2, -0.8, 1.5, accent, 1, 4);
    this.circle(2.2, -0.8, 1.3, rgba(accent), rgba('#ffffff', 0.8), 0.4); // 胸口核心（在前面）
    arm(0.6, -3.4, u.punch, false);
    this.circle(0, -4.2, 2.7, rgba(Red), rgba(RedLight), 0.6); // 肩甲

    // 頭：頭盔、面罩在前面、單眼、一支向前彎的角、紅冠
    this.ellipse(0.6, -9, 3.6, 3.5, rgba(Silver), rgba(SilverDark), 0.6);
    this.fillPath(HornSideGeo, null, rgba(Gold), 1.5, true);
    this.fillPath(CrestSideGeo, rgba(Red));
    this.fillRR(1.0, -10.3, 3.0, 2.4, 1, rgba(Dark));
    this.ellipse(2.7, -9.1, 0.95, 0.6, rgba(eye));

    for (const t of tips) // 命中火花（拳頭在最前面）
      if (t.p > 0.15) this.glowCircle(t.x, t.y, 1.8 * (0.6 + 0.8 * t.p), sparkColor(u, '#ffd36b'), Math.min(1, t.p * 1.2), 6);
    c.restore();
  }

  // 右下摘要卡
  private drawSummary(models: readonly FlowModel[]): void {
    const m = models[0];
    const x = 330, y = 190, w = 290, h = 92;
    this.fillRR(x, y, w, h, 10, rgba('#10141a', 0.92), rgba('#232a33'), 1);
    this.circle(x + 16, y + 18, 3, rgba(Palette.Ok));
    this.text(`WINDOW · ${m.windowMinutes} MIN`, x + 26, y + 18, 10, Palette.Sub, { mono: true });
    this.text(`${models.reduce((n, m) => n + m.stats.total, 0)} 次呼叫`, x + 16, y + 49, 30, Palette.Text, { bold: true });
    this.text(`${models.reduce((n, m) => n + m.agents.length, 0)} 子代理 · ${models.reduce((n, m) => n + m.pillList.length, 0)} 工具節點 · ${models.reduce((n, m) => n + m.stats.running, 0)} 執行中`, x + 16, y + 76, 11, Palette.Sub);
  }

  // 底部日誌：最近 3 筆真實呼叫（螢幕座標，不隨縮放），屬於 output，最後才淡出
  private drawLog(m: FlowModel): void {
    const log = m.log.slice(0, 3).reverse();
    log.forEach((c, i) => {
      const mark = c.result === ToolResult.Ok ? '✓' : c.result === ToolResult.Failed ? '✕' : '…';
      const line = `${hhmmss(c.time)}  ${mark}  ${pillInfo(c.tool).name}  ${shorten(c.summary, 70)}`;
      this.text(line, 16, this.h - 14 - (log.length - 1 - i) * 16 - 6, 11, Palette.Sub, { alpha: (0.45 + 0.18 * i) * m.sink, mono: true });
    });
  }

  // 頂部：標題（固定）、統計數字（屬於 output，最後才淡出）、LIVE／IDLE 徽章、模型
  private drawHeader(m: FlowModel): void {
    const c = this.ctx;
    const g = c.createLinearGradient(0, 0, 0, 62);
    g.addColorStop(0, '#0b0d10'); g.addColorStop(1, 'rgba(11,13,16,0)');
    c.fillStyle = g; c.fillRect(0, 0, this.w, 62);
    const narrow = this.w < 640; // 窄的側邊欄：標題、LIVE 徽章一行，統計數字縮成一行小字
    const tiny = this.w < 260; // 更窄（窄面板）：LIVE 只剩一個小圓點、不畫菱形圖示
    let tx = 18;
    if (!tiny) tx += this.text('◈', tx, 24, 13, Palette.Agent) + 10;
    tx += this.text(m.providerLabel.toUpperCase() + ' FLOW', tx, 24, 12, Palette.Text, { bold: true }) + 10;
    if (narrow) {
      const s = m.stats;
      const dot = m.isLive ? Palette.Ok : Palette.Warn;
      this.text(tiny ? '●' : m.isLive ? '● LIVE' : '● IDLE', this.w - 14, 24, 11, dot, { bold: true, align: 'right' });
      // 統計：依寬度挑第一個放得下的版本，不要被切掉
      const variants = [
        `執行中 ${s.running} · 失敗 ${s.fail} · 成功 ${s.ok} · 共 ${s.total} · 活躍 ${m.activeSessions}`,
        `執行 ${s.running} · 失敗 ${s.fail} · 成功 ${s.ok} · 共 ${s.total}`,
        `${s.running} 執行 · ${s.fail} 失敗 · ${s.ok} 成功`,
      ];
      const line = variants.find(v => this.measure(v, 10.5, false, false) <= this.w - 28) ?? variants[2];
      this.text(line, 18, 46, 10.5, Palette.Sub, { alpha: m.sink });
      return;
    }
    this.text('本機 ' + m.providerLabel, tx, 24, 12, '#6b7685');

    let x = this.w - 18;
    if (m.modelText.length > 0) {
      const wd = this.measure(m.modelText, 11, true, true) + 20;
      this.fillRR(x - wd, 12, wd, 24, 12, rgba('#161b22'), rgba('#2a323c'), 1);
      this.text(m.modelText, x - wd / 2, 24, 11, Palette.Text, { bold: true, mono: true, align: 'center' });
      x -= wd + 22;
    }
    x -= this.text(m.liveText, x, 24, 11, m.isLive ? Palette.Ok : Palette.Warn, { bold: true, align: 'right' }) + 22;

    const s = m.stats;
    const cols: [string, string, string][] = [
      [String(s.running), '執行中', Palette.Warn],
      [String(s.fail), '失敗', Palette.Fail],
      [String(s.ok), '成功', Palette.Ok],
      [String(s.total), '工具呼叫', Palette.Text],
      [String(m.activeSessions), '活躍 session', Palette.Text],
    ];
    for (const [num, label, hex] of cols) {
      const wd = Math.max(this.measure(num, 20, true, false), this.measure(label, 10, false, false));
      this.text(num, x - wd / 2, 18, 20, hex, { alpha: m.sink, bold: true, align: 'center' });
      this.text(label, x - wd / 2, 38, 10, '#6b7685', { alpha: m.sink, align: 'center' });
      x -= wd + 22;
    }
  }
}

