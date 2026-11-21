import { describe, expect, it } from 'vitest';
import { alienSpot, FlowAlien, FlowModel, EscortScale, MaxEscorts } from '../src/core/model';
import { ToolResult } from '../src/core/types';
import { agent, call, run, snap } from './helpers';

// 分流：同時有好幾個工具在跑，就有幾隻機甲出動（隊長 + 增援，有上限）；只依真實的執行中呼叫，主機器人與子代理都一樣。

const Real = { freeIdle: false };
const group = (m: FlowModel, g = ''): FlowAlien[] => m.aliens.filter(u => u.groupKey === g).sort((a, b) => a.escortIndex - b.escortIndex);
const dist = (u: FlowAlien, p: { x: number; y: number }): number => Math.hypot(u.x - p.x, u.y - p.y);

function started(...calls: ReturnType<typeof call>[]): FlowModel {
  const m = new FlowModel(Real);
  m.sync(snap(0));
  m.sync(snap(2, calls));
  run(m, 3, 2);
  return m;
}

describe('分流：幾個工作就出動幾隻機甲', () => {
  it('兩種不同的工具同時在跑：兩隻機甲各去各的方塊', () => {
    const m = started(call('a', 'Bash', ToolResult.Running, 1.0), call('b', 'Grep', ToolResult.Running, 1.1));
    const g = group(m);
    expect(g).toHaveLength(2);
    expect(new Set(g.map(u => u.targetKey)).size).toBe(2);
    for (const u of g) {
      expect(u.pose).toBe('attack');
      const pill = m.pillList.find(p => p.key === u.targetKey)!;
      expect(dist(u, alienSpot(pill, u.baseScale))).toBeLessThan(4);
    }
  });

  it('同一種工具並行三個：在同一個方塊左邊排成一列，不疊在一起', () => {
    const m = started(call('a', 'Read', ToolResult.Running, 1.0), call('b', 'Read', ToolResult.Running, 1.1), call('c', 'Read', ToolResult.Running, 1.2));
    const g = group(m);
    expect(g).toHaveLength(3);
    expect(new Set(g.map(u => u.targetKey)).size).toBe(1);
    expect(g[0].x).toBeGreaterThan(g[1].x);
    expect(g[1].x).toBeGreaterThan(g[2].x);
  });

  it('一隊最多隊長加四隻增援', () => {
    // 九種不同的工具（各自一個方塊）：同一個方塊的 recent 只留 5 筆，用同一種工具會被資料上限擋住、測不到隊伍上限
    const calls = Array.from({ length: 9 }, (_, i) => call('c' + i, 'Tool' + i, ToolResult.Running, 1 + i * 0.05));
    expect(group(started(...calls))).toHaveLength(1 + MaxEscorts);
  });

  it('增援比隊長小一點，光暈是它那個工具方塊的顏色', () => {
    const m = started(call('a', 'Bash', ToolResult.Running, 1.0), call('b', 'Grep', ToolResult.Running, 1.1));
    const g = group(m);
    expect(g[0].tint).toBeNull();
    expect(g[1].baseScale / g[0].baseScale).toBeCloseTo(EscortScale, 3);
    expect(g[1].tint).toBe(m.pillList.find(p => p.key === g[1].targetKey)!.color);
  });

  it('新的呼叫來了，原本在打的機甲不換人，新的交給增援', () => {
    const m = started(call('a', 'Bash', ToolResult.Running, 1.0));
    const leader = group(m)[0];
    const first = leader.targetKey;
    m.sync(snap(4, [call('a', 'Bash', ToolResult.Running, 1.0), call('b', 'Grep', ToolResult.Running, 3.9)]));
    run(m, 2.5, 4);
    expect(leader.targetKey).toBe(first);
    const g = group(m);
    expect(g).toHaveLength(2);
    expect(g[1].targetKey).not.toBe(first);
  });

  it('增援各自帶著自己的結果飛到 Output，做完就淡出收隊', () => {
    const m = started(call('a', 'Bash', ToolResult.Running, 1.0), call('b', 'Grep', ToolResult.Running, 1.1));
    m.sync(snap(4, [call('a', 'Bash', ToolResult.Ok, 1.0), call('b', 'Grep', ToolResult.Failed, 1.1)]));
    const delivered = new Set<string>();
    for (let i = 0; i < 160; i++) {
      m.tick(0.05, 4000 + 0);
      for (const u of group(m)) delivered.add(`${u.escortIndex}:${u.deliverTarget}`);
    }
    expect(delivered.has('0:fail')).toBe(true); // 較新的 b 歸隊長：失敗的結果去 REJECTED
    expect(delivered.has('1:ok')).toBe(true); // 較舊的 a 歸增援：增援自己送成功的結果去 VERIFIED OUTPUT
    run(m, 14, 4);
    expect(group(m)).toHaveLength(1);
  });

  it('子代理並行的呼叫派出怪獸增援；主機器人沒事就不派', () => {
    const m = new FlowModel(Real);
    m.sync(snap(0));
    m.sync(snap(2, [call('g', 'Grep', ToolResult.Running, 1.9, { agentId: 'a1' }), call('r', 'Read', ToolResult.Running, 1.95, { agentId: 'a1' })], [agent()]));
    run(m, 3, 2);
    const g = group(m, 's1:a1');
    expect(g).toHaveLength(2);
    expect(g.every(u => u.isMonster)).toBe(true);
    expect(g[1].baseScale).toBeCloseTo(0.7 * EscortScale, 3);
    expect(group(m)).toHaveLength(1);
  });

  it('「分流 ×N · 機甲出動」泡泡在並行開始時只彈一次', () => {
    const m = new FlowModel(Real);
    m.sync(snap(0));
    m.sync(snap(2, [call('a', 'Bash', ToolResult.Running, 1.9)]));
    const count = (): number => m.bubbles.items.filter(b => b.text.startsWith('分流')).length;
    expect(count()).toBe(0);
    m.sync(snap(3, [call('a', 'Bash', ToolResult.Running, 1.9), call('b', 'Grep', ToolResult.Running, 2.9)]));
    m.sync(snap(4, [call('a', 'Bash', ToolResult.Running, 1.9), call('b', 'Grep', ToolResult.Running, 2.9), call('c', 'Read', ToolResult.Running, 3.9)]));
    expect(count()).toBe(1);
    expect(m.bubbles.items.some(b => b.text === '分流 ×2 · 機甲出動')).toBe(true);
  });

  it('減少動態：不派增援也不彈泡泡', () => {
    const m = new FlowModel(Real);
    m.reduceMotion = true;
    m.sync(snap(0));
    m.sync(snap(2, [call('a', 'Bash', ToolResult.Running, 1.9), call('b', 'Grep', ToolResult.Running, 1.95)]));
    run(m, 3, 2);
    expect(group(m)).toHaveLength(1);
    expect(m.bubbles.items.some(b => b.text.startsWith('分流'))).toBe(false);
  });
});
