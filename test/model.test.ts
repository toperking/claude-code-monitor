import { describe, expect, it } from 'vitest';
import { ago, colorOf, docName, FlowModel, fileNameOf, formatModel, Layout, Palette, pillInfo } from '../src/core/model';
import { call, after, run, sec, snap, T0, agent } from './helpers';
import { SessionStatus, ToolResult } from '../src/core/types';

const idleSnap = (s: number, calls = [call('a', 'Bash', ToolResult.Ok, 1)], lastActivity = sec(1)) =>
  snap(s, calls, [], SessionStatus.Idle, lastActivity);

describe('文字與顏色', () => {
  it('MCP 工具依伺服器合併成一塊', () => {
    expect(pillInfo('mcp__windows-mcp__Click')).toEqual({ key: 'mcp:windows-mcp', name: 'windows-mcp' });
    expect(pillInfo('Bash')).toEqual({ key: 'Bash', name: 'Bash' });
  });
  it('模型名稱：claude-sonnet-5-5 → SONNET 5.5', () => {
    expect(formatModel('claude-sonnet-5-5')).toBe('SONNET 5.5');
    expect(formatModel('claude-opus-4')).toBe('OPUS 4');
    expect(formatModel(undefined)).toBe('');
    expect(formatModel('Codex · gpt-6.1-sol')).toBe('GPT-6.1 SOL');
    expect(formatModel('gpt-6.1-sol')).toBe('GPT-6.1 SOL');
    expect(formatModel('Codex · gpt-6.1')).toBe('GPT-6.1');
  });
  it('相對時間', () => {
    expect([ago(10), ago(120), ago(3 * 3600), ago(3 * 86400)]).toEqual(['剛剛', '2 分鐘前', '3 小時前', '3 天前']);
  });
  it('顏色：Skill／Task 固定，其餘依名稱穩定地雜湊成 #RRGGBB', () => {
    expect(colorOf('Skill')).toBe(Palette.Skill);
    expect(colorOf('Task')).toBe(Palette.Task);
    expect(colorOf('Bash')).toMatch(/^#[0-9A-F]{6}$/);
    expect(colorOf('Bash')).toBe(colorOf('Bash'));
    expect(colorOf('Bash')).not.toBe(colorOf('Edit'));
  });
  it('檔名：兩種分隔字元、尾端刪節號、非檔案工具', () => {
    const c = (tool: string, summary: string) => call('x', tool, ToolResult.Ok, 1, { summary });
    expect(fileNameOf(c('Read', 'C:\\dir\\a.md'))).toBe('a.md');
    expect(fileNameOf(c('Read', '/home/u/a.md'))).toBe('a.md');
    expect(fileNameOf(c('Read', 'a.md…'))).toBe('a.md');
    expect(fileNameOf(c('Bash', 'a.md'))).toBeNull();
    expect(fileNameOf(c('Read', ''))).toBeNull();
    expect(docName(c('Read', 'C:\\x\\SKILL.MD'))).toBe('SKILL.MD');
    expect(docName(c('Read', 'C:\\x\\Program.cs'))).toBeNull();
  });
});

describe('同步與統計', () => {
  it('統計成功／失敗／執行中，並依種類成方塊', () => {
    const m = after(snap(2, [
      call('a', 'Bash', ToolResult.Ok), call('b', 'Bash', ToolResult.Failed), call('c', 'Read', ToolResult.Running),
    ]));
    expect(m.stats).toEqual({ total: 3, ok: 1, fail: 1, running: 1 });
    expect(m.pillList.map(p => p.key).sort()).toEqual(['Bash', 'Read']);
    expect(m.pillList.find(p => p.key === 'Bash')!.count).toBe(2);
    expect(m.busy).toBe(true);
  });

  it('超過統計窗口（30 分鐘）的舊呼叫不算，但還在執行中的永遠算', () => {
    const m = new FlowModel({ freeIdle: false });
    m.sync(snap(0));
    m.sync(snap(3600, [call('old', 'Bash', ToolResult.Ok, 1), call('run', 'Read', ToolResult.Running, 1)]));
    expect(m.stats.total).toBe(1);
    expect(m.pillList.map(p => p.key)).toEqual(['Read']);
  });

  it('每個方塊只留最近 5 筆，最新的在最前面', () => {
    const calls = Array.from({ length: 8 }, (_, i) => call('c' + i, 'Bash', ToolResult.Ok, 8 - i)); // 快照是新→舊
    const m = after(snap(10, calls));
    expect(m.pillList[0].recent).toHaveLength(Layout.ExpandedRows);
    expect(m.pillList[0].recent[0].toolUseId).toBe('c0');
  });

  it('LIVE／IDLE 文字', () => {
    const live = after(snap(2));
    expect(live.liveText).toBe('● LIVE');
    const idle = new FlowModel({ freeIdle: false });
    idle.sync(idleSnap(200, [], sec(1)));
    expect(idle.isLive).toBe(false);
    expect(idle.liveText).toBe('● IDLE · 最後活動 3 分鐘前');
    const never = new FlowModel({ freeIdle: false });
    never.sync({ ...snap(0), sessions: [] });
    expect(never.liveText).toBe('● IDLE');
  });

  it('最多 14 個方塊（每個群組）', () => {
    const calls = Array.from({ length: 20 }, (_, i) => call('c' + i, 'Tool' + i, ToolResult.Ok, 1));
    const m = after(snap(2, calls));
    expect(m.pillList).toHaveLength(Layout.MaxRows);
  });
});

describe('粒子', () => {
  it('開啟當下就存在的事件不演動畫', () => {
    const m = new FlowModel({ freeIdle: false });
    m.sync(snap(2, [call('a', 'Bash', ToolResult.Running)]));
    expect(m.particles).toHaveLength(0);
    expect(m.bubbles.items).toHaveLength(0);
  });

  it('新事件：執行中只有進入粒子，已完成還有輸出粒子，失敗是 rejected', () => {
    const m = after(snap(2, [call('a', 'Bash', ToolResult.Running), call('b', 'Read', ToolResult.Ok), call('c', 'Edit', ToolResult.Failed)]));
    const kinds = m.particles.map(p => p.kind).sort();
    expect(kinds).toEqual(['in', 'in', 'in', 'out', 'rejected']);
  });

  it('執行中 → 完成：補上輸出粒子；不再重複進入粒子', () => {
    const m = after(snap(2, [call('a', 'Bash', ToolResult.Running)]));
    run(m, 2);                                                                 // 粒子飛完
    expect(m.particles).toHaveLength(0);
    m.sync(snap(4, [call('a', 'Bash', ToolResult.Ok)]));
    expect(m.particles.map(p => p.kind)).toEqual(['out']);
  });

  it('超過 15 秒的舊事件不產生粒子', () => {
    const m = after(snap(60, [call('old', 'Bash', ToolResult.Ok, 1)]));
    expect(m.particles).toHaveLength(0);
  });

  it('粒子抵達後讓方塊閃光、輸出圓環閃光，之後移除', () => {
    const m = after(snap(2, [call('a', 'Bash', ToolResult.Ok)]));
    run(m, 1.2);
    expect(m.particles).toHaveLength(0);
    expect(m.pillList[0].flash).toBeGreaterThan(0);
    expect(m.outFlash).toBeGreaterThan(0);
  });

  it('減少動態：不產生粒子、泡泡與機器人', () => {
    const m = new FlowModel({ freeIdle: false });
    m.reduceMotion = true;
    m.sync(snap(0));
    m.sync(snap(2, [call('a', 'Bash', ToolResult.Failed)], [agent()]));
    run(m, 1);
    expect(m.particles).toHaveLength(0);
    expect(m.bubbles.items).toHaveLength(0);
    expect(m.aliens.every(u => u.alpha < 0.001)).toBe(true);
  });
});

describe('依序淡出：方塊 → AI → output', () => {
  const faded = (ageSeconds: number): FlowModel => {
    const m = new FlowModel({ freeIdle: false });
    m.sync(snap(0, [call('a', 'Bash', ToolResult.Ok, 1)]));
    run(m, 4, 1);                                           // AI 還在忙：先讓可見度緩動到 1
    m.sync(idleSnap(100));
    m.tick(0.05, sec(1) + ageSeconds * 1000);
    return m;
  };

  it('緩衝期內（15 秒）全部維持 1', () => {
    const m = faded(10);
    for (const v of [m.pillList[0].fade, m.source, m.sink]) expect(v).toBeCloseTo(1, 3);
  });

  it('先淡方塊（15–21 秒），這時 AI 與 output 還是 1', () => {
    const m = faded(18);
    expect(m.pillList[0].fade).toBeCloseTo(0.5, 2);
    expect(m.source).toBeCloseTo(1, 3);
    expect(m.sink).toBeCloseTo(1, 3);
  });

  it('方塊淡完後才淡 AI（21–27 秒），output 還是 1', () => {
    const m = faded(24);
    expect(m.pillList[0].fade).toBe(0);
    expect(m.source).toBeCloseTo(0.5, 2);
    expect(m.sink).toBeCloseTo(1, 3);
  });

  it('AI 淡完後才淡 output（27–33 秒）', () => {
    const m = faded(30);
    expect(m.source).toBe(0);
    expect(m.sink).toBeCloseTo(0.5, 2);
    expect(faded(40).sink).toBe(0);
  });

  it('AI 回來時全部緩動回 1', () => {
    const m = faded(40);
    m.sync(snap(101, [call('a', 'Bash', ToolResult.Ok, 1), call('b', 'Read', ToolResult.Running, 100)]));
    run(m, 3, 101);
    expect(m.source).toBeGreaterThan(0.99);
    expect(m.sink).toBeGreaterThan(0.99);
    expect(m.pillList.every(p => p.fade > 0.99)).toBe(true);
  });
});

describe('泡泡', () => {
  it('工具開始：顯示名稱與摘要；失敗：顯示耗時', () => {
    const m = after(snap(2, [call('a', 'Bash', ToolResult.Running, 1, { summary: 'dotnet build' })]));
    expect(m.bubbles.items.map(b => b.text)).toEqual(['Bash ▸ dotnet build']);
    const f = after(snap(2, [call('a', 'Bash', ToolResult.Failed, 1, { durationSeconds: 2.5 })]));
    expect(f.bubbles.items[0]).toMatchObject({ kind: 'failure', text: '✕ Bash 失敗 · 2.5s' });
  });

  it('讀寫 .md 文件：只顯示檔名與動作，即使呼叫已經結束', () => {
    const m = after(snap(2, [call('a', 'Read', ToolResult.Ok, 1, { summary: 'd:\\x\\docs\\FLOW.md' })]));
    expect(m.bubbles.items[0]).toMatchObject({ kind: 'doc', text: '文件 FLOW.md · 讀取', color: Palette.Doc });
    const verbs = ['Edit', 'MultiEdit', 'Write'].map(t =>
      after(snap(2, [call('a', t, ToolResult.Ok, 1, { summary: 'C:/p/CLAUDE.md' })])).bubbles.items[0].text);
    expect(verbs).toEqual(['文件 CLAUDE.md · 編輯', '文件 CLAUDE.md · 編輯', '文件 CLAUDE.md · 寫入']);
  });

  it('Bash 的命令剛好提到 .md 不算文件；一般檔案的工具開始顯示檔名', () => {
    const b = after(snap(2, [call('a', 'Bash', ToolResult.Running, 1, { summary: 'cat README.md' })]));
    expect(b.bubbles.items[0].kind).toBe('toolStart');
    const e = after(snap(2, [call('a', 'Edit', ToolResult.Running, 1, { summary: 'd:\\p\\Core\\FlowModel.cs' })]));
    expect(e.bubbles.items[0].text).toBe('Edit ▸ FlowModel.cs');
    const quiet = after(snap(2, [call('a', 'Read', ToolResult.Ok, 1, { summary: 'C:\\x\\Program.cs' })]));
    expect(quiet.bubbles.items).toHaveLength(0);                              // 成功且很快結束的一般檔案：不彈
  });

  it('子代理新出現：彈一次；開啟當下就有的不彈', () => {
    const m = after(snap(2, [], [agent('abcdef123')]));
    expect(m.bubbles.items[0]).toMatchObject({ kind: 'agent', text: '子代理 ABCDEF 啟動 · SONNET 5.5' });
    const start = new FlowModel({ freeIdle: false });
    start.sync(snap(2, [], [agent()]));
    expect(start.bubbles.items).toHaveLength(0);
  });

  it('AI 狀態轉換：閒置→執行、執行→閒置各彈一次；開啟當下的狀態不彈', () => {
    const m = new FlowModel({ freeIdle: false });
    m.sync(snap(0));
    m.sync(idleSnap(100, []));
    expect(m.bubbles.items[0].text).toBe('已閒置 15 秒，開始淡出');
    m.sync(snap(101));
    expect(m.bubbles.items.map(b => b.text)).toContain('AI 開始執行 · SONNET 5.5');
    const first = new FlowModel({ freeIdle: false });
    first.sync(idleSnap(100, []));
    expect(first.bubbles.items).toHaveLength(0);
  });

  it('額度上限：比先前更新的才彈，開啟當下既有的不彈', () => {
    const hit = (at: number) => ({ hitAt: sec(at), resetsAt: new Date(2026, 10, 20, 17, 30).getTime(), limitType: 'five_hour' });
    const start = new FlowModel({ freeIdle: false });
    start.sync({ ...snap(2), lastLimitHit: hit(1) });
    expect(start.bubbles.items).toHaveLength(0);
    start.sync({ ...snap(3), lastLimitHit: hit(1) });
    expect(start.bubbles.items).toHaveLength(0);                              // 同一筆不重複彈
    start.sync({ ...snap(4), lastLimitHit: hit(3) });
    expect(start.bubbles.items[0]).toMatchObject({ kind: 'limit', text: '已達 5 小時額度上限 · 17:30 重置' });
  });
});

describe('子代理與版面', () => {
  it('子代理的工具各自成一群，不與主 session 的方塊混在一起', () => {
    const m = after(snap(2, [call('a', 'Bash', ToolResult.Running), call('b', 'Grep', ToolResult.Running, 1.9, { agentId: 'a1' })], [agent()]));
    expect(m.pillList.map(p => p.key)).toEqual(['Bash', 's1:a1/Grep']);
    expect(m.agents).toHaveLength(1);
  });

  it('方塊置中成一排，列距 52；兩群之間至少隔 GroupGap', () => {
    const m = after(snap(2, [call('a', 'A', ToolResult.Ok), call('b', 'B', ToolResult.Ok), call('c', 'C', ToolResult.Ok)]));
    run(m, 1);
    const ys = m.pillList.map(p => p.y);
    expect(ys[1] - ys[0]).toBeCloseTo(Layout.RowH, 1);
    expect(ys[0] + ys[2]).toBeCloseTo(0, 1);                                   // 對稱置中
    const g = after(snap(2, [call('a', 'A', ToolResult.Ok), call('b', 'B', ToolResult.Ok, 1, { agentId: 'a1' })], [agent()]));
    run(g, 1);
    const [main, sub] = g.pillList;
    expect(sub.y - Layout.PillH / 2 - (main.y + Layout.PillH / 2)).toBeGreaterThanOrEqual(Layout.GroupGap - 0.5);
  });

  it('點方塊展開／收起：只往右長（左緣固定）；hitPill 命中標題列', () => {
    const m = after(snap(2, [call('a', 'A', ToolResult.Ok)]));
    run(m, 0.5);
    const p = m.pillList[0];
    const left = p.left;
    expect(m.hitPill(0, p.y)).toBe(p);
    expect(m.hitPill(Layout.Hub.x, p.y)).toBeNull();
    p.expanded = true;
    run(m, 1);
    expect(p.w).toBeCloseTo(Layout.ExpandedW, 0);
    expect(p.h).toBeGreaterThan(Layout.PillH + 10);
    expect(p.left).toBe(left);
    p.expanded = false;
    run(m, 2);
    expect(p.w).toBeCloseTo(Layout.PillW, 0);
  });

  it('淡到看不見的方塊不能點', () => {
    const m = after(snap(2, [call('a', 'A', ToolResult.Ok)]));
    run(m, 0.5);
    m.pillList[0].fade = 0.1;
    expect(m.hitPill(0, m.pillList[0].y)).toBeNull();
  });
});

describe('時間', () => {
  it('T0 是本地時間 2026-11-20 12:00', () => {
    expect(new Date(T0).getHours()).toBe(12);
  });
});

describe('畫面負擔：什麼時候需要連續重畫（animating）', () => {
  it('AI 在忙時需要；全部淡掉、機器人消失、沒有粒子和泡泡之後是靜止的', () => {
    const m = new FlowModel({ freeIdle: false });
    m.sync(snap(0, [call('a', 'Bash', ToolResult.Ok, 1)]));
    run(m, 4, 1);
    expect(m.animating).toBe(true);                                            // AI 在忙

    m.sync(idleSnap(100));
    m.tick(0.05, sec(1) + 40_000);                                             // 閒置 40 秒：方塊、AI、output 都淡完
    expect(m.animating).toBe(true);                                            // 機器人還沒完全消失
    for (let i = 0; i < 400; i++) m.tick(0.05, sec(1) + 40_000);
    expect(m.animating).toBe(false);                                           // 靜止：畫面不需要每秒畫幾十次
  });

  it('粒子或泡泡還在時需要；AI 回來也馬上需要', () => {
    const m = new FlowModel({ freeIdle: false });
    m.sync(snap(0));
    m.sync(idleSnap(100, []));
    for (let i = 0; i < 600; i++) m.tick(0.05, sec(1) + 60_000);
    expect(m.animating).toBe(false);
    m.sync(snap(101, [call('a', 'Bash', ToolResult.Running, 100)]));
    expect(m.animating).toBe(true);
  });
});
