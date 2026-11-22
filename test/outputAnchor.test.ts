import { describe, expect, it } from 'vitest';
import { FlowModel } from '../src/core/model';
import { flowSceneRows, OutputAnchor, sharedOutputY } from '../src/core/flowSceneLayout';
import { emptySnapshot, SessionStatus } from '../src/core/types';
import { fakeCanvas, newRecorded } from './fakeCanvas';
import { sec } from './helpers';

const frame = 1 / 30;

function run(anchor: OutputAnchor, target: number, seconds: number): number[] {
  const ys: number[] = [];
  for (let t = 0; t < seconds; t += frame) ys.push(anchor.update(target, frame));
  return ys;
}

describe('手／腳整組慢慢滑到新位置，不是跳過去', () => {
  it('第一次直接就位，不會從 0 滑進來', () => {
    const a = new OutputAnchor();
    expect(a.update(-300, frame)).toBe(-300);
    expect(a.isMoving(-300)).toBe(false);
  });

  it('目標換位置時，一幀只走一小段（不是瞬間到位）', () => {
    const a = new OutputAnchor();
    a.update(0, frame);
    const y = a.update(-600, frame);
    expect(y).toBeLessThan(0);
    expect(y).toBeGreaterThan(-600);
    expect(Math.abs(y)).toBeLessThanOrEqual(OutputAnchor.MaxSpeed * frame + 1e-9); // 限速
    expect(a.isMoving(-600)).toBe(true);
  });

  it('一路單調靠近、不會過頭，最後剛好停在目標', () => {
    const a = new OutputAnchor();
    a.update(0, frame);
    const ys = run(a, -600, 8);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeLessThanOrEqual(ys[i - 1] + 1e-9); // 往下走只會更小
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(-600 - 1e-9); // 沒有過頭
    expect(ys.at(-1)).toBe(-600);
    expect(a.isMoving(-600)).toBe(false);
  });

  it('距離很遠時要花得到「看得出在移動」的時間，不是一兩幀', () => {
    const a = new OutputAnchor();
    a.update(0, frame);
    const ys = run(a, -600, 8);
    const arrive = ys.findIndex(y => y === -600) * frame;
    expect(arrive).toBeGreaterThan(1);   // 至少超過一秒
    expect(arrive).toBeLessThan(6);      // 也不會慢到像卡住
  });

  it('往上走（目標變大）一樣平順', () => {
    const a = new OutputAnchor();
    a.update(-600, frame);
    const ys = run(a, 200, 8);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1] - 1e-9);
    expect(ys[0]).toBeLessThan(-600 + OutputAnchor.MaxSpeed * frame + 1e-9);
    expect(ys.at(-1)).toBe(200);
  });

  it('久沒畫（閒置一秒一張）後的第一張，不會因為時間差一次走完', () => {
    const a = new OutputAnchor();
    a.update(0, frame);
    const y = a.update(-600, 1); // dt = 1 秒
    expect(Math.abs(y)).toBeLessThanOrEqual(OutputAnchor.MaxSpeed * OutputAnchor.MaxStep + 1e-9);
    expect(y).toBeGreaterThan(-600);
  });

  it('dt 為 0 或負數時不動；目標沒變就一直不動', () => {
    const a = new OutputAnchor();
    a.update(-100, frame);
    expect(a.update(-400, 0)).toBe(-100);
    expect(a.update(-400, -1)).toBe(-100);
    const b = new OutputAnchor();
    b.update(50, frame);
    expect(run(b, 50, 1).every(y => y === 50)).toBe(true);
  });

  it('減少動態（snap）時直接就位，不做滑動', () => {
    const a = new OutputAnchor();
    a.update(0, frame);
    expect(a.update(-600, frame, true)).toBe(-600);
    expect(a.isMoving(-600)).toBe(false);
  });

  it('畫面真的把手／腳整組平移到「目前位置」，連線偏移也一致；沒給就用目標位置', async () => {
    const { FlowRenderer } = await import('../src/webview/render');
    const s = emptySnapshot(sec(2));
    s.sessions = [{ provider: 'Claude', sessionId: 's1', model: 'claude-sonnet-5-5', status: SessionStatus.Idle, lastActivity: sec(2) }];
    const model = new FlowModel({ provider: 'Claude', freeIdle: false });
    model.sync(emptySnapshot(sec(0))); model.sync(s);

    const translates: [number, number][] = [];
    const canvas = fakeCanvas(newRecorded());
    (canvas.getContext('2d') as unknown as { translate: (x: number, y: number) => void }).translate = (x, y) => { translates.push([x, y]); };
    const renderer = new FlowRenderer(canvas);
    renderer.resize(1400, 1200, 1);

    const row = flowSceneRows([model])[0];
    renderer.renderScene([model], 900, row.y - 44 + 137);          // 滑動途中的位置（離目標 137）
    expect(translates).toContainEqual([0, row.y - 44 + 137]);
    expect(model.outputOffsetY).toBe(-44 + 137);

    translates.length = 0;
    renderer.renderScene([model], 900);                             // 沒給：用目標位置
    expect(translates).toContainEqual([0, sharedOutputY(flowSceneRows([model]))]);
  });

  it('滑動途中目標又變了，會從目前位置轉向新目標，不會先跳回去', () => {
    const a = new OutputAnchor();
    a.update(0, frame);
    run(a, -600, 0.5);
    const mid = a.y;
    expect(mid).toBeLessThan(0);
    expect(mid).toBeGreaterThan(-600);
    const next = a.update(-100, frame);
    expect(Math.abs(next - mid)).toBeLessThanOrEqual(OutputAnchor.MaxSpeed * frame + 1e-9);
  });
});
