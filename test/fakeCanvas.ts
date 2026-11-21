import { vi } from 'vitest';

// 「記錄繪圖指令」的假畫布：沒有真的瀏覽器，直接檢查東西畫在哪裡、用了什麼顏色、寫了什麼字。
// 渲染器在載入時就會用到 Path2D，所以要先裝好假的，測試裡再 `await import('../src/webview/render')`。

export class FakePath {
  pts: [number, number][] = [];
  moveTo(x: number, y: number): void { this.pts.push([x, y]); }
  lineTo(x: number, y: number): void { this.pts.push([x, y]); }
  quadraticCurveTo(): void {}
  bezierCurveTo(): void {}
  closePath(): void {}
}
vi.stubGlobal('Path2D', FakePath);

export interface Recorded {
  arcs: { x: number; y: number; r: number; fill: unknown }[];
  fills: { path: FakePath; fill: unknown }[];
  /** 每次 stroke() 當下的描邊顏色。 */
  strokes: string[];
  /** 每次 fillText() 寫的字。 */
  texts: string[];
}

export const newRecorded = (): Recorded => ({ arcs: [], fills: [], strokes: [], texts: [] });

export function fakeCanvas(rec: Recorded): HTMLCanvasElement {
  const state: Record<string, unknown> = {};
  let lastArc: { x: number; y: number; r: number } | null = null; // 顏色是畫完路徑之後才設的，所以等到 fill() 才記
  const ctx = new Proxy({}, {
    get: (_t, k: string) => {
      if (k in state) return state[k];
      if (k === 'measureText') return () => ({ width: 0 });
      if (k === 'beginPath') return () => { lastArc = null; };
      if (k === 'arc') return (x: number, y: number, r: number) => { lastArc = { x, y, r }; };
      if (k === 'fill') return (p?: unknown) => {
        if (p instanceof FakePath) rec.fills.push({ path: p, fill: state.fillStyle });
        else if (lastArc) rec.arcs.push({ ...lastArc, fill: state.fillStyle });
      };
      if (k === 'stroke') return () => { rec.strokes.push(String(state.strokeStyle)); };
      if (k === 'fillText') return (s: string) => { rec.texts.push(s); };
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => ({ addColorStop() {} });
      return () => {};
    },
    set: (_t, k: string, v) => { state[k] = v; return true; },
  });
  return { getContext: () => ctx, addEventListener() {}, style: {}, width: 0, height: 0 } as unknown as HTMLCanvasElement;
}
