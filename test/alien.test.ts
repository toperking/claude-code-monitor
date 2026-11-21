import { describe, expect, it } from 'vitest';
import { alienHome, alienSpot, FlowAlien, FlowModel, Layout } from '../src/core/model';
import { SessionStatus, ToolResult } from '../src/core/types';
import { after, agent, call, run, sec, seeded, snap } from './helpers';

const dist = (u: FlowAlien, p: { x: number; y: number }): number => Math.hypot(u.x - p.x, u.y - p.y);
const main = (m: FlowModel): FlowAlien => m.aliens.find(u => u.ownerKey === '')!;
const running = (id = 'a', tool = 'Bash') => call(id, tool, ToolResult.Running);

describe('機器人：只依真實事件移動', () => {
  it('沒事時停在 AI 中樞旁，站著待命', () => {
    const m = after(snap(2));
    run(m, 3);
    const u = main(m);
    expect(u.targetKey).toBeNull();
    expect(dist(u, alienHome(null))).toBeLessThan(1);
    expect(u.alpha).toBeGreaterThan(0.9);
    expect(u.pose).toBe('stand');
  });

  it('有執行中的工具：飛到那個方塊的左邊，到站後出拳', () => {
    const m = after(snap(2, [running()]));
    for (let i = 0; i < 8; i++) m.tick(0.05, sec(2));
    expect(main(m).pose).toBe('fly');                                          // 還在路上
    expect(main(m).wAttack).toBeLessThan(0.5);

    run(m, 3);
    const u = main(m);
    const pill = m.pillList[0];
    expect(u.targetKey).toBe(pill.key);
    expect(dist(u, alienSpot(pill))).toBeLessThan(4);
    expect(u.pose).toBe('attack');
    expect(u.wAttack).toBeGreaterThan(0.97);
    expect(u.face).toBe(1);                                                    // 方塊在右邊：側身面向右
  });

  it('飛行是平滑的，不是瞬移', () => {
    const m = after(snap(2, [running()]));
    const home = alienHome(null);
    m.tick(0.05, sec(2));
    const moved = Math.hypot(main(m).x - home.x, main(m).y - home.y);
    expect(moved).toBeGreaterThan(0.1);
    expect(moved).toBeLessThan(60);
  });

  it('結果回來後停一下才飛回去；已經完成的呼叫也會短暫造訪', () => {
    const m = after(snap(2, [running()]));
    run(m, 3);
    m.sync(snap(4, [call('a', 'Bash', ToolResult.Ok)]));
    run(m, 0.4, 4);
    expect(main(m).targetKey).not.toBeNull();
    run(m, 9, 4); // 還要飛去 Output 處理一趟、再飛回來（見 delivery.test.ts）
    expect(main(m).targetKey).toBeNull();
    expect(dist(main(m), alienHome(null))).toBeLessThan(2);

    const fast = after(snap(2, [call('a', 'Read', ToolResult.Ok)]));
    fast.tick(0.05, sec(2));
    expect(main(fast).targetKey).toBe('Read');
    run(fast, 4);
    expect(main(fast).targetKey).toBeNull();
  });

  it('同時有多個執行中的工具：最新的那個贏', () => {
    const m = after(snap(2, [call('b', 'Edit', ToolResult.Running, 1.8), call('a', 'Bash', ToolResult.Running, 1.0)]));
    run(m, 3);
    expect(main(m).targetKey).toBe('Edit');
  });

  it('開啟當下的既有呼叫不造訪（除非還在執行）', () => {
    const m = new FlowModel({ freeIdle: false });
    m.sync(snap(2, [call('a', 'Read', ToolResult.Ok)]));
    m.tick(0.05, sec(2));
    expect(main(m).targetKey).toBeNull();
  });

  it('成功就歡呼、失敗就受創，反應結束回去站著', () => {
    const ok = after(snap(2, [running()]));
    run(ok, 3);
    ok.sync(snap(4, [call('a', 'Bash', ToolResult.Ok)]));
    run(ok, 0.3, 4);
    expect(main(ok).pose).toBe('cheer');

    const bad = after(snap(2, [running()]));
    run(bad, 3);
    bad.sync(snap(4, [call('a', 'Bash', ToolResult.Failed)]));
    run(bad, 0.3, 4);
    expect(main(bad).pose).toBe('hurt');
    run(bad, 9, 4); // 反應結束、送去 REJECTED 處理完之後，回去站著
    expect(main(bad).pose).toBe('stand');
  });

  it('動作權重是緩動的，不會瞬間切換', () => {
    const m = after(snap(2, [running()]));
    run(m, 3);
    m.sync(snap(4, [call('a', 'Bash', ToolResult.Ok)]));
    m.tick(0.05, sec(4));
    expect(main(m).wCheer).toBeLessThan(0.6);
    expect(main(m).wAttack).toBeGreaterThan(0.3);
  });

  it('攻擊時雙手輪流出拳：兩手加起來永遠是 1，而且各自完整伸縮；瞄準方塊左緣', () => {
    const m = after(snap(2, [running()]));
    run(m, 3);
    let min = 1, max = 0, minB = 1, maxB = 0;
    for (let i = 0; i < 40; i++) {
      m.tick(0.05, sec(2));
      const { punch: p, punchB: pb } = main(m);
      min = Math.min(min, p); max = Math.max(max, p); minB = Math.min(minB, pb); maxB = Math.max(maxB, pb);
      expect(p + pb).toBeCloseTo(1, 3);
    }
    expect(min).toBeLessThan(0.1); expect(max).toBeGreaterThan(0.9);
    expect(minB).toBeLessThan(0.1); expect(maxB).toBeGreaterThan(0.9);
    const u = main(m);
    expect(u.aimX).toBeGreaterThan(0.95);
    expect(Math.abs(u.aimY)).toBeLessThan(0.3);
  });

  it('推進器：剛起飛很強，停穩後幾乎沒有', () => {
    const m = after(snap(2, [running()]));
    for (let i = 0; i < 6; i++) m.tick(0.05, sec(2));
    expect(main(m).thrust).toBeGreaterThan(0.5);
    run(m, 5);
    expect(main(m).thrust).toBeLessThan(0.05);
  });

  it('AI 已經停下來（閒置緩衝期內）：坐下，而且還看得見', () => {
    const m = new FlowModel({ freeIdle: false });
    m.sync(snap(0));
    m.sync(snap(3, [], [], SessionStatus.Idle, sec(2)));
    run(m, 3, 3);
    const u = main(m);
    expect(u.pose).toBe('sit');
    expect(u.wSit).toBeGreaterThan(0.9);
    expect(u.alpha).toBeGreaterThan(0.5);
  });

  it('AI 閒置很久之後機器人淡出', () => {
    const m = after(snap(2, [running()]));
    run(m, 3);
    expect(main(m).alpha).toBeGreaterThan(0.5);
    m.sync(snap(100, [], [], SessionStatus.Idle, sec(0)));
    run(m, 6, 100);
    expect(main(m).alpha).toBeLessThan(0.02);
  });
});

describe('機器人：子代理', () => {
  it('子代理出現時從主機器人分出一位小的，之後停在自己的節點旁', () => {
    const m = after(snap(2, [], [agent()]));
    m.tick(0.05, sec(2));
    const sub = m.aliens.find(u => u.ownerKey === 's1:a1')!;
    expect(dist(sub, { x: main(m).x, y: main(m).y })).toBeLessThan(30);
    expect(sub.scale).toBeLessThan(0.5);
    run(m, 3);
    expect(dist(sub, alienHome(m.agents[0]))).toBeLessThan(3);
    expect(sub.scale).toBeGreaterThan(0.68);
    expect(sub.scale).toBeLessThan(0.72);
    expect(m.aliens).toHaveLength(2);
  });

  it('子代理的工具只派子代理的機器人去', () => {
    const m = after(snap(2, [call('a', 'Grep', ToolResult.Running, 1.9, { agentId: 'a1' })], [agent()]));
    run(m, 3);
    expect(m.aliens.find(u => u.ownerKey === 's1:a1')!.targetKey).toBe('s1:a1/Grep');
    expect(main(m).targetKey).toBeNull();
  });

  it('子代理消失後，它的機器人淡出並移除', () => {
    const m = after(snap(2, [], [agent()]));
    run(m, 3);
    m.sync(snap(4));
    run(m, 2, 4);
    expect(m.aliens).toHaveLength(1);
  });

  it('大小機器人的停靠點都剛好讓拳頭碰到方塊左緣（距離依各自大小）', () => {
    const m = after(snap(2, [running()]));
    run(m, 0.5);
    const p = m.pillList[0];
    const big = p.left - alienSpot(p, 1).x, small = p.left - alienSpot(p, 0.7).x;
    expect(big).toBeGreaterThan(small);
    expect(big - 20).toBeCloseTo((small - 20) / 0.7, 5);
    expect(Layout.AlienUnit).toBeGreaterThan(2);
  });
});

describe('機器人：減少動態', () => {
  it('完全不出現', () => {
    const m = new FlowModel({ freeIdle: false });
    m.reduceMotion = true;
    m.sync(snap(0));
    m.sync(snap(2, [running()], [agent()]));
    run(m, 3);
    expect(m.aliens.every(u => u.alpha < 0.001)).toBe(true);
    expect(m.alienLevel).toBe(0);
  });
});

// ── 自由活動（使用者放寬：隨機決定，不代表事件）────────────────────────────

describe('機器人：自由活動', () => {
  const busy = (s: number, calls = [] as ReturnType<typeof call>[]) => snap(s, calls);
  const model = (seed: number, free = true): FlowModel => {
    const m = new FlowModel({ freeIdle: free, random: seeded(seed) });
    m.sync(busy(0)); m.sync(busy(2));
    m.tick(0.05, sec(2));                                                      // 機器人在第一幀才會建立
    return m;
  };
  const record = (m: FlowModel, seconds: number, atSec = 2) => {
    const log: { t: number; pose: string; idle: string; picks: number }[] = [];
    for (let t = 0; t < seconds; t += 0.05) {
      m.tick(0.05, sec(atSec));
      const u = main(m);
      log.push({ t, pose: u.pose, idle: u.idleAct, picks: u.idlePicks });
    }
    return log;
  };

  it('沒事做時自己挑各種動作；歡呼與受創只屬於真實的工具結果', () => {
    const poses = new Set(record(model(7), 120).map(x => x.pose));
    expect(poses.size).toBeGreaterThanOrEqual(4);
    for (const p of ['wave', 'attack', 'sit']) expect(poses.has(p)).toBe(true);
    expect(poses.has('cheer')).toBe(false);
    expect(poses.has('hurt')).toBe(false);
  });

  it('每件事至少持續一陣子，而且不會連續兩次一樣', () => {
    const log = record(model(11), 180);
    const runs: { idle: string; start: number; end: number; pick: number }[] = [];
    for (const { t, idle, picks } of log) {
      const last = runs[runs.length - 1];
      if (last && last.pick === picks) last.end = t;
      else runs.push({ idle, start: t, end: t, pick: picks });
    }
    const inner = runs.slice(1, -1);
    expect(inner.length).toBeGreaterThan(15);
    for (const r of inner) expect(r.end - r.start).toBeGreaterThanOrEqual(1.4);
    for (let i = 1; i < runs.length; i++) expect(runs[i].idle).not.toBe(runs[i - 1].idle);
  });

  it('巡邏不會離待命點太遠', () => {
    const m = model(3);
    const home = alienHome(null);
    let far = 0, off = 0;
    for (let t = 0; t < 240; t += 0.05) {
      m.tick(0.05, sec(2));
      const u = main(m);
      far = Math.max(far, Math.hypot(u.x - home.x, u.y - home.y));
      off = Math.max(off, Math.hypot(u.patrolX, u.patrolY));
    }
    expect(off).toBeGreaterThan(10);
    expect(off).toBeLessThanOrEqual(45.01);
    expect(far).toBeLessThan(60);
  });

  it('真實的工具呼叫一來就中斷正在做的事', () => {
    const m = model(5);
    m.forceIdle('', 'wave', 100);
    record(m, 1);
    expect(main(m).pose).toBe('wave');
    expect(main(m).wWave).toBeGreaterThan(0.9);
    m.sync(busy(3, [call('a', 'Bash', ToolResult.Running, 2.8)]));
    record(m, 3, 3);
    const u = main(m);
    expect(u.idleAct).toBe('none');
    expect(u.targetKey).not.toBeNull();
    expect(u.pose).toBe('attack');
    expect(u.wWave).toBeLessThan(0.05);
    expect(u.patrolX).toBe(0);
  });

  it('AI 真的停下來時只坐著，不亂玩', () => {
    const m = new FlowModel({ random: seeded(1) });
    m.sync(busy(0));
    m.sync(snap(3, [], [], SessionStatus.Idle, sec(2)));
    const log = record(m, 30, 3);
    for (const x of log.slice(40)) expect(x.pose).toBe('sit');
    for (const x of log) expect(x.idle).toBe('none');
  });

  it('關掉自由活動：沒事時只站著', () => {
    for (const x of record(model(7, false), 60)) expect(x.pose).toBe('stand');
  });

  it('同樣的種子給出同樣的順序', () => {
    const seq = (seed: number) => record(model(seed), 60).map(x => x.idle).join(',');
    expect(seq(42)).toBe(seq(42));
    expect(seq(42)).not.toBe(seq(43));
  });

  it('對空出拳：沒有目標、雙拳輪流出、朝左下或右下；機器人轉身面向出拳的方向', () => {
    const faces = new Set<number>();
    for (let seed = 1; seed <= 16; seed++) {
      const m = model(seed);
      m.forceIdle('', 'shadow', 100);
      record(m, 0.5);
      const u = main(m);
      expect(u.face).toBe(u.aimX >= 0 ? 1 : -1);
      faces.add(u.face);
    }
    expect(faces.size).toBe(2);

    const m = model(5);
    m.forceIdle('', 'shadow', 100);
    let min = 1, max = 0;
    for (let i = 0; i < 60; i++) { m.tick(0.05, sec(2)); min = Math.min(min, main(m).punch); max = Math.max(max, main(m).punch); }
    const u = main(m);
    expect(u.pose).toBe('attack');
    expect(u.targetKey).toBeNull();
    expect(min).toBeLessThan(0.1); expect(max).toBeGreaterThan(0.9);
    expect(u.aimY).toBeGreaterThan(0.8); expect(Math.abs(u.aimX)).toBeGreaterThan(0.15);
  });
});
