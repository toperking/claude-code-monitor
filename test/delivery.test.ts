import { describe, expect, it } from 'vitest';
import { alienHome, alienOutSpot, FlowAlien, FlowModel, Layout } from '../src/core/model';
import { ToolResult } from '../src/core/types';
import { agent, call, run, snap } from './helpers';

// 工具有結果之後，機甲要飛到 Output 處理：成功→VERIFIED OUTPUT、失敗→REJECTED；只依真實的結果事件，主機器人與子代理的怪獸都一樣。

const main = (m: FlowModel): FlowAlien => m.aliens.find(u => u.ownerKey === '')!;
const dist = (u: FlowAlien, p: { x: number; y: number }): number => Math.hypot(u.x - p.x, u.y - p.y);
const Real = { freeIdle: false };

/** 主機器人先打一個執行中的工具（打到站穩），再同步「結果回來了」。 */
function withResult(result: string): FlowModel {
  const m = new FlowModel(Real);
  m.sync(snap(0)); m.sync(snap(2, [call('a', 'Bash', ToolResult.Running)]));
  run(m, 3, 2);
  m.sync(snap(4, [call('a', 'Bash', result)]));
  return m;
}

describe('到 Output 處理結果', () => {
  it('成功的結果：先在方塊旁歡呼，再飛到 VERIFIED OUTPUT 面向圓環出拳處理，處理完回家', () => {
    const m = withResult(ToolResult.Ok);
    run(m, 0.5, 4);
    expect(main(m).pose).toBe('cheer');
    expect(main(m).deliverTarget).toBeNull();

    run(m, 1.9, 4); // 歡呼 0.8 秒、飛過去約 0.7 秒，現在是處理中
    const u = main(m);
    expect(u.deliverTarget).toBe('ok');
    expect(dist(u, alienOutSpot(false, 1, u.outSlot))).toBeLessThan(4);
    expect(u.pose).toBe('attack');
    expect(u.face).toBe(1);
    expect(u.aimX).toBeGreaterThan(0.9);

    run(m, 7, 4); // 處理完（約 1.6 秒）回家
    expect(main(m).deliverTarget).toBeNull();
    expect(dist(main(m), alienHome(null))).toBeLessThan(2);
  });

  it('失敗的結果改去 REJECTED', () => {
    const m = withResult(ToolResult.Failed);
    run(m, 2.4, 4);
    const u = main(m);
    expect(u.deliverTarget).toBe('fail');
    expect(dist(u, alienOutSpot(true, 1, u.outSlot))).toBeLessThan(4);
    expect(u.pose).toBe('attack');
  });

  it('處理時 Output 圓環（或 REJECTED）隨著出拳閃光', () => {
    for (const [result, flash] of [[ToolResult.Ok, 'outFlash'], [ToolResult.Failed, 'rejFlash']] as const) {
      const m = withResult(result);
      run(m, 1.9, 4);
      let max = 0;
      for (let i = 0; i < 30; i++) { m.tick(0.05, 0); max = Math.max(max, m[flash]); }
      expect(max).toBeGreaterThan(0.2);
    }
  });

  it('新的執行中工具一來就中斷處理，結果留著之後再送', () => {
    const m = withResult(ToolResult.Ok);
    run(m, 2.4, 4);
    expect(main(m).deliverTarget).toBe('ok');
    m.sync(snap(8, [call('a', 'Bash', ToolResult.Ok), call('b', 'Bash', ToolResult.Running, 7.9)]));
    run(m, 3, 8);
    const u = main(m);
    expect(u.deliverTarget).toBeNull(); // 中斷了
    expect(u.targetKey).not.toBeNull(); // 去打新的工具
    expect(u.pose).toBe('attack');
  });

  it('快速連續完成的結果合併成一趟；只要有一筆失敗就整趟算失敗', () => {
    const m = new FlowModel(Real);
    m.sync(snap(0));
    m.sync(snap(2, [call('a', 'Bash', ToolResult.Ok), call('b', 'Bash', ToolResult.Ok, 1.1), call('c', 'Bash', ToolResult.Failed, 1.2)]));
    run(m, 2.6, 2);
    expect(main(m).deliverTarget).toBe('fail');
  });

  it('處理成功的結果期間又來了失敗：先回到那個方塊旁受創，之後整趟改成送去 REJECTED（失敗不會弄丟）', () => {
    const m = withResult(ToolResult.Ok);
    run(m, 1.9, 4); // 處理成功的結果中
    expect(main(m).deliverTarget).toBe('ok');
    m.sync(snap(6, [call('a', 'Bash', ToolResult.Ok), call('b', 'Bash', ToolResult.Failed, 5.9)]));
    run(m, 0.3, 6);
    expect(main(m).deliverTarget).toBeNull(); // 新的結果有造訪，中斷了原本的處理
    expect(main(m).targetKey).not.toBeNull();

    let toRejected = false;
    for (let i = 0; i < 200 && !toRejected; i++) { m.tick(0.05, 0); toRejected = main(m).deliverTarget === 'fail'; }
    expect(toRejected).toBe(true); // 合併成失敗那一趟
  });

  it('一趟之後休息幾秒才會再出發', () => {
    const m = withResult(ToolResult.Ok);
    run(m, 4.5, 4); // 這一趟結束了（約 3.0 秒處理完），冷卻還剩 1.5 秒
    expect(main(m).deliverTarget).toBeNull();
    expect(main(m).deliverCool).toBeGreaterThan(1);

    m.sync(snap(5, [call('a', 'Bash', ToolResult.Ok), call('b', 'Bash', ToolResult.Ok, 4.9)])); // 又有新的結果
    run(m, 1.0, 5); // 冷卻中：不會立刻又出發
    expect(main(m).deliverTarget).toBeNull();
    run(m, 1.5, 5); // 冷卻結束，把等著的結果送出去
    expect(main(m).deliverTarget).toBe('ok');
  });

  it('開啟當下就有的結果、以及減少動態，都不會派任何人去', () => {
    const start = new FlowModel(Real);
    start.sync(snap(2, [call('a', 'Bash', ToolResult.Ok)]));
    run(start, 3, 2);
    expect(main(start).deliverTarget).toBeNull();

    const calm = new FlowModel(Real);
    calm.reduceMotion = true;
    calm.sync(snap(0)); calm.sync(snap(2, [call('a', 'Bash', ToolResult.Failed)]));
    run(calm, 4, 2);
    expect(calm.aliens.every(u => u.deliverTarget === null)).toBe(true);
  });

  it('子代理的怪獸也一樣：站在自己的那一格、離圓環的距離依自己的大小算', () => {
    const m = new FlowModel(Real);
    m.sync(snap(0));
    m.sync(snap(2, [call('g', 'Grep', ToolResult.Running, 1.9, { agentId: 'a1' })], [agent()]));
    run(m, 3, 2);
    m.sync(snap(4, [call('g', 'Grep', ToolResult.Ok, 1.9, { agentId: 'a1' })], [agent()]));
    run(m, 2.4, 4);

    const mon = m.aliens.find(u => u.ownerKey === 's1:a1')!;
    expect(mon.deliverTarget).toBe('ok');
    expect(mon.outSlot).not.toBe(main(m).outSlot); // 與主機器人站不同的格
    expect(dist(mon, alienOutSpot(false, 0.7, mon.outSlot))).toBeLessThan(4);
    expect(main(m).deliverTarget).toBeNull(); // 主機器人沒有結果，不用去
  });

  it('好幾位同時處理時站在不同高度，而且都在圓環／REJECTED 的左邊', () => {
    const ok = Array.from({ length: Layout.OutSlots }, (_, s) => alienOutSpot(false, 1, s));
    expect(new Set(ok.map(p => p.y)).size).toBe(Layout.OutSlots);
    for (const p of ok) expect(p.x).toBeLessThan(Layout.Out.x - Layout.OutR);
    for (const s of [0, 1, 2]) expect(alienOutSpot(true, 1, s).x).toBeLessThan(Layout.Rej.x - 46);
  });

  it('飛行速度有上限：長距離也是看得見地飛過去，不是瞬移', () => {
    const m = withResult(ToolResult.Ok);
    run(m, 0.85, 4); // 歡呼剛結束、剛起飛
    let max = 0;
    for (let i = 0; i < 40; i++) { m.tick(0.05, 0); max = Math.max(max, Math.hypot(main(m).vx, main(m).vy)); }
    expect(max).toBeLessThanOrEqual(900.001);
    expect(max).toBeGreaterThan(500);
  });
});
