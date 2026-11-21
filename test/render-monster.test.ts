import { describe, expect, it } from 'vitest';
import { FlowModel } from '../src/core/model';
import { agent, run, snap } from './helpers';
import { fakeCanvas, newRecorded } from './fakeCanvas';

// 怪獸機甲的畫法：用「記錄繪圖指令」的假畫布，直接檢查細節畫在哪裡（沒有真的瀏覽器）。
// 曾經的錯誤：藍色手上的三根金爪漏掉了手的位置，被畫到身體正中央（兩腿之間），看起來像手指頭跑掉了。

describe('怪獸機甲的手', () => {
  it('三根金爪畫在藍色的手上（x 與手一致），不是身體中央', async () => {
    const { FlowRenderer } = await import('../src/webview/render');
    const m = new FlowModel({ freeIdle: false });
    m.sync(snap(0));
    m.sync(snap(2, [], [agent()]));
    run(m, 3, 2);
    const mon = m.aliens.find(u => u.isMonster)!;
    expect(mon.alpha).toBeGreaterThan(0.02);

    const rec = newRecorded();
    const r = new FlowRenderer(fakeCanvas(rec));
    r.resize(1000, 600, 1);
    (r as unknown as { drawMonster(m: FlowModel, u: unknown): void }).drawMonster(m, mon);

    const hand = rec.arcs.find(a => a.fill === 'rgba(74,127,212,1)' && Math.abs(a.r - 2.3) < 1e-9);
    expect(hand).toBeDefined();
    const claws = rec.fills.filter(f => f.fill === 'rgba(244,226,160,1)' && f.path.pts.length === 3);
    expect(claws).toHaveLength(3);
    for (const c of claws) expect(Math.abs(c.path.pts[2][0] - hand!.x)).toBeLessThanOrEqual(1.5); // 爪尖離手的中心不超過左右兩根的偏移
    const mean = claws.reduce((s, c) => s + c.path.pts[2][0], 0) / 3;
    expect(mean).toBeCloseTo(hand!.x, 5);
  });
});
