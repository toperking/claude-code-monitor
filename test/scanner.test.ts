import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { modelFamily, TranscriptScanner } from '../src/core/scanner';
import { SessionStatus, ToolResult } from '../src/core/types';

const SID = '11111111-aaaa-bbbb-cccc-000000000001';
let home: string;
let seq = 0;

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const iso = (ms: number): string => new Date(ms).toISOString();
const projectFile = (name = SID + '.jsonl'): string => {
  const dir = path.join(home, 'projects', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
};
const subagentFile = (agent: string): string => {
  const dir = path.join(home, 'projects', 'demo', SID, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `agent-${agent}.jsonl`);
};
const usage = (i = 10, o = 20, cw = 0, cr = 500) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: cw, cache_read_input_tokens: cr });

const assistant = (at: number, content: unknown[], extra: Record<string, unknown> = {}, model = 'claude-sonnet-5-5', u = usage(), id?: string): string =>
  JSON.stringify({ sessionId: SID, timestamp: iso(at), ...extra, message: { id: id ?? 'm' + seq++, role: 'assistant', model, content, usage: u } }) + '\n';
const user = (at: number, content: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ sessionId: SID, timestamp: iso(at), ...extra, message: { role: 'user', content } }) + '\n';
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const toolResult = (id: string, isError = false) => ({ type: 'tool_result', tool_use_id: id, content: 'ok', ...(isError ? { is_error: true } : {}) });

const scan = async (): Promise<TranscriptScanner> => { const s = new TranscriptScanner(home); await s.refresh(); return s; };

describe('工具呼叫配對', () => {
  it('tool_use 先是「執行中」，tool_result 回來後變成成功並算出耗時', async () => {
    const now = Date.now();
    const f = projectFile();
    fs.writeFileSync(f, assistant(now - 5000, [toolUse('t1', 'Bash', { command: 'dotnet build' })]));
    const s = new TranscriptScanner(home);
    await s.refresh();
    expect(s.snapshotCalls()).toMatchObject([{ toolUseId: 't1', tool: 'Bash', summary: 'dotnet build', result: ToolResult.Running, agentId: '' }]);

    fs.appendFileSync(f, user(now - 2500, [toolResult('t1')]));
    await s.refresh();
    expect(s.snapshotCalls()[0]).toMatchObject({ result: ToolResult.Ok, durationSeconds: 2.5 });
  });

  it('is_error 的結果是失敗', async () => {
    const now = Date.now();
    fs.writeFileSync(projectFile(), assistant(now - 3000, [toolUse('t1', 'Read', { file_path: 'x' })]) + user(now - 1000, [toolResult('t1', true)]));
    expect((await scan()).snapshotCalls()[0].result).toBe(ToolResult.Failed);
  });

  it('沒有對應 tool_use 的 tool_result 被忽略', async () => {
    fs.writeFileSync(projectFile(), user(Date.now(), [toolResult('ghost')]));
    expect((await scan()).snapshotCalls()).toHaveLength(0);
  });
});

describe('增量讀取', () => {
  it('只讀上次位移之後的完整行；尾端沒寫完的半行留到下次', async () => {
    const now = Date.now();
    const f = projectFile();
    const line1 = assistant(now - 3000, [toolUse('t1', 'Bash', { command: 'a' })]);
    const line2 = assistant(now - 2000, [toolUse('t2', 'Bash', { command: 'b' })]);
    fs.writeFileSync(f, line1 + line2.slice(0, 40));                            // 第二行只寫了一半
    const s = new TranscriptScanner(home);
    await s.refresh();
    expect(s.snapshotCalls().map(c => c.toolUseId)).toEqual(['t1']);

    fs.appendFileSync(f, line2.slice(40));                                       // 補完
    await s.refresh();
    expect(s.snapshotCalls().map(c => c.toolUseId).sort()).toEqual(['t1', 't2']);
    await s.refresh();                                                           // 再掃一次不會重複
    expect(s.snapshotCalls()).toHaveLength(2);
  });

  it('壞掉的 JSON 行不影響其他行', async () => {
    const now = Date.now();
    fs.writeFileSync(projectFile(), 'not json\n{"sessionId":\n' + assistant(now - 1000, [toolUse('t1', 'Bash', { command: 'a' })]));
    expect((await scan()).snapshotCalls()).toHaveLength(1);
  });

  it('第一次看到、超過 7 天沒更新的舊檔直接跳過', async () => {
    const f = projectFile();
    fs.writeFileSync(f, assistant(Date.now() - 20 * 86400_000, [toolUse('old', 'Bash', { command: 'a' })]));
    const old = new Date(Date.now() - 20 * 86400_000);
    fs.utimesSync(f, old, old);
    expect((await scan()).snapshotCalls()).toHaveLength(0);
  });

  it('~/.claude 不存在：不丟例外，回報找不到', async () => {
    const s = new TranscriptScanner(path.join(home, 'nope'));
    await s.refresh();
    const snap = s.snapshot();
    expect(snap.claudeHomeFound).toBe(false);
    expect(snap.sessions).toEqual([]);
  });
});

describe('去重（續接的 session 會把舊訊息重放到新檔）', () => {
  it('同一個 tool_use id 只算一次', async () => {
    const now = Date.now();
    const line = assistant(now - 3000, [toolUse('dup', 'Bash', { command: 'a' })], {}, 'claude-sonnet-5-5', usage(), 'same-msg');
    fs.writeFileSync(projectFile('a.jsonl'), line);
    fs.writeFileSync(projectFile('b.jsonl'), line);
    expect((await scan()).snapshotCalls()).toHaveLength(1);
  });

  it('同一個 message.id 的用量只算一次', async () => {
    const now = Date.now();
    const line = assistant(now - 3000, [{ type: 'text', text: 'hi' }], {}, 'claude-sonnet-5-5', usage(10, 20, 0, 500), 'same-msg');
    fs.writeFileSync(projectFile('a.jsonl'), line);
    fs.writeFileSync(projectFile('b.jsonl'), line);
    expect((await scan()).snapshotUsage(now)[0].totalTokens).toBe(530);
  });
});

describe('Session 狀態', () => {
  const statusAt = async (ageMs: number, pending: boolean): Promise<string> => {
    const now = Date.now();
    const content = pending ? [toolUse('t1', 'Bash', { command: 'a' })] : [{ type: 'text', text: 'hi' }];
    fs.writeFileSync(projectFile(), assistant(now - ageMs, content));
    return (await scan()).snapshotSessions(now)[0].status;
  };

  it('15 秒內：沒有未完成的工具＝回應中，有＝執行工具中', async () => {
    expect(await statusAt(3000, false)).toBe(SessionStatus.Responding);
  });
  it('15 秒內有未完成的工具＝執行工具中', async () => {
    expect(await statusAt(3000, true)).toBe(SessionStatus.RunningTool);
  });
  it('超過 15 秒但 10 分鐘內仍有未完成的工具＝等待授權／執行中', async () => {
    expect(await statusAt(60_000, true)).toBe(SessionStatus.Waiting);
  });
  it('沒有未完成的工具：5 分鐘內閒置、之後已結束', async () => {
    expect(await statusAt(60_000, false)).toBe(SessionStatus.Idle);
    fs.rmSync(path.join(home, 'projects'), { recursive: true });
    expect(await statusAt(10 * 60_000, false)).toBe(SessionStatus.Ended);
  });
});

describe('子代理', () => {
  it('subagents/agent-*.jsonl 的呼叫歸給子代理，並從主 session 的 toolUseResult 找出是哪個工具啟動的', async () => {
    const now = Date.now();
    fs.writeFileSync(projectFile(),
      assistant(now - 9000, [toolUse('tu_task', 'Task', { description: 'search' })])
      + user(now - 1000, [toolResult('tu_task')], { toolUseResult: { agentId: 'a1' } }));
    fs.writeFileSync(subagentFile('a1'), assistant(now - 5000, [toolUse('tu_grep', 'Grep', { pattern: 'x' })], { agentId: 'a1' }));
    const s = await scan();

    const calls = s.snapshotCalls();
    expect(calls.find(c => c.toolUseId === 'tu_grep')).toMatchObject({ agentId: 'a1', result: ToolResult.Running });
    expect(calls.find(c => c.toolUseId === 'tu_task')!.agentId).toBe('');
    expect(s.snapshotAgents(now)).toMatchObject([{ sessionId: SID, agentId: 'a1', parentToolUseId: 'tu_task', parentAgentId: '' }]);
    expect(s.snapshotSessions(now)).toHaveLength(1);                             // 子代理不算在主 session 清單裡
  });

  it('找不到啟動它的工具時，parentToolUseId 是 null', async () => {
    fs.writeFileSync(subagentFile('zz'), assistant(Date.now() - 1000, [{ type: 'text', text: 'x' }]));
    expect((await scan()).snapshotAgents(Date.now())[0].parentToolUseId).toBeNull();
  });
});

describe('用量彙總', () => {
  it('近 5 小時與近 7 天分開算；模型依家族歸類並依 token 總量排序', async () => {
    const now = Date.now();
    fs.writeFileSync(projectFile(),
      assistant(now - 3600_000, [{ type: 'text', text: 'a' }], {}, 'claude-sonnet-5-5', usage(100, 100, 0, 800))         // 1000 tokens，1 小時前
      + assistant(now - 3600_000, [{ type: 'text', text: 'b' }], {}, 'claude-haiku-5-5', usage(50, 50, 0, 100))          // 200
      + assistant(now - 2 * 86400_000, [{ type: 'text', text: 'c' }], {}, 'claude-opus-5-5', usage(300, 100, 0, 600)));   // 1000，2 天前
    const [h5, d7] = (await scan()).snapshotUsage(now);
    expect(h5.label).toBe('近 5 小時');
    expect(h5.totalTokens).toBe(1200);
    expect(h5.models.map(m => m.model)).toEqual(['Sonnet', 'Haiku']);
    expect(h5.models[0].percent).toBeCloseTo(1000 / 1200 * 100, 5);
    expect(d7.label).toBe('近 7 天');
    expect(d7.totalTokens).toBe(2200);
    expect(d7.models.map(m => m.model)).toEqual(['Sonnet', 'Opus', 'Haiku']);
  });

  it('快取命中率 = 快取讀取 ÷（輸入 + 快取寫入 + 快取讀取）；沒有輸入時是 null', async () => {
    const now = Date.now();
    fs.writeFileSync(projectFile(), assistant(now - 1000, [{ type: 'text', text: 'a' }], {}, 'claude-sonnet-5-5', usage(100, 999, 100, 800)));
    expect((await scan()).snapshotUsage(now)[0].cacheHitRate).toBeCloseTo(0.8, 5);
    fs.rmSync(path.join(home, 'projects'), { recursive: true });
    expect((await scan()).snapshotUsage(now)[0].cacheHitRate).toBeNull();
  });

  it('合成訊息（<synthetic>）不算用量，也不蓋掉 session 的目前模型', async () => {
    const now = Date.now();
    fs.writeFileSync(projectFile(),
      assistant(now - 5000, [{ type: 'text', text: 'a' }], {}, 'claude-sonnet-5-5', usage(10, 10, 0, 100))
      + assistant(now - 1000, [{ type: 'text', text: 'limit' }], {}, '<synthetic>', usage(5, 5, 0, 5)));
    const s = await scan();
    expect(s.snapshotUsage(now)[0].totalTokens).toBe(120);
    expect(s.snapshotSessions(now)[0].model).toBe('claude-sonnet-5-5');
  });

  it('模型家族名稱', () => {
    expect([modelFamily('claude-opus-4'), modelFamily('Claude-SONNET-5'), modelFamily('claude-haiku-5-5'), modelFamily('gpt-x'), modelFamily('')])
      .toEqual(['Opus', 'Sonnet', 'Haiku', 'gpt-x', '未知']);
  });
});

describe('額度上限事件', () => {
  it('只有被拒絕（status=rejected）的才記錄；保留最新的一筆', async () => {
    const now = Date.now();
    const q = (at: number, status: string, resets: number, type: string) =>
      JSON.stringify({ sessionId: SID, timestamp: iso(at), apiError: 'usage_limit_reached', quotaLimits: { status, resetsAt: resets, rateLimitType: type } }) + '\n';
    const resets = Math.floor((now + 3600_000) / 1000);
    fs.writeFileSync(projectFile(), q(now - 9000, 'allowed', resets, 'five_hour') + q(now - 5000, 'rejected', resets - 100, 'five_hour') + q(now - 1000, 'rejected', resets, 'seven_day'));
    const hit = (await scan()).lastLimitHit!;
    expect(hit.limitType).toBe('seven_day');
    expect(hit.resetsAt).toBe(resets * 1000);
    expect(hit.hitAt).toBeCloseTo(now - 1000, -2);
  });

  it('沒有被拒絕過就是 null', async () => {
    fs.writeFileSync(projectFile(), assistant(Date.now(), [{ type: 'text', text: 'a' }]));
    expect((await scan()).lastLimitHit).toBeNull();
  });
});

describe('工具摘要', () => {
  const summaryOf = async (input: Record<string, unknown>): Promise<string> => {
    fs.rmSync(path.join(home, 'projects'), { recursive: true, force: true });
    fs.writeFileSync(projectFile(), assistant(Date.now() - 1000, [toolUse('s' + seq++, 'Tool', input)]));
    return (await scan()).snapshotCalls()[0].summary;
  };

  it('依優先順序取欄位：skill > command > file_path > pattern …', async () => {
    expect(await summaryOf({ file_path: 'f.cs', command: 'ls' })).toBe('ls');
    expect(await summaryOf({ pattern: 'p', file_path: 'f.cs' })).toBe('f.cs');
  });
  it('MCP 工具沒有標準欄位：取第一個字串參數，格式 名稱=值', async () => {
    expect(await summaryOf({ x: 3, selector: '#btn', other: 'b' })).toBe('selector=#btn');
    expect(await summaryOf({ n: 3 })).toBe('');
  });
  it('換行換成空白；超過 120 字加刪節號', async () => {
    expect(await summaryOf({ command: 'a\nb\r\nc' })).toBe('a b c');
    expect(await summaryOf({ command: 'x'.repeat(200) })).toBe('x'.repeat(120) + '…');
  });
});

describe('分段讀取與降低檔案系統負擔', () => {
  const many = (n: number, at: number, prefix = 'c'): string =>
    Array.from({ length: n }, (_, i) => assistant(at + i, [toolUse(prefix + i, 'Bash', { command: 'cmd ' + i + ' ' + '中'.repeat(10) })])).join('');

  it('用很小的分段（含跨段的半行、比分段還長的行）讀出來的結果，跟一次讀完完全一樣', async () => {
    const now = Date.now();
    const text = many(40, now - 60_000) + assistant(now - 1000, [{ type: 'text', text: 'x'.repeat(5000) }]) + many(5, now - 500, "z");
    const f = projectFile();
    fs.writeFileSync(f, text);
    const whole = new TranscriptScanner(home, 64 * 1024 * 1024);
    await whole.refresh();
    for (const chunk of [7, 64, 1000]) {
      const s = new TranscriptScanner(home, chunk);
      await s.refresh();
      expect(s.snapshotCalls().map(c => c.toolUseId).sort()).toEqual(whole.snapshotCalls().map(c => c.toolUseId).sort());
      expect(s.snapshotUsage(now)[0].totalTokens).toBe(whole.snapshotUsage(now)[0].totalTokens);
    }
    expect(whole.snapshotCalls()).toHaveLength(45);
  });

  it('分段讀取時，尾端沒寫完的半行留到下次；補完之後只多一筆', async () => {
    const now = Date.now();
    const f = projectFile();
    const last = assistant(now - 100, [toolUse('tail', 'Bash', { command: 'last' })]);
    fs.writeFileSync(f, many(10, now - 5000) + last.slice(0, 30));
    const s = new TranscriptScanner(home, 50);
    await s.refresh();
    expect(s.snapshotCalls()).toHaveLength(10);
    fs.appendFileSync(f, last.slice(30));
    await s.refresh();
    expect(s.snapshotCalls()).toHaveLength(11);
  });

  it('讀大檔時一次只配置一個分段的記憶體（不會把整個檔案讀進來）', async () => {
    const f = projectFile();
    fs.writeFileSync(f, many(3000, Date.now() - 60_000));                      // 約 1 MB
    const sizes: number[] = [];
    const orig = Buffer.alloc;
    const spy = (n: number, ...rest: unknown[]): Buffer => { sizes.push(n); return (orig as (n: number, ...r: unknown[]) => Buffer)(n, ...rest); };
    (Buffer as unknown as { alloc: unknown }).alloc = spy;
    try {
      const s = new TranscriptScanner(home, 64 * 1024);
      await s.refresh();
      expect(s.snapshotCalls().length).toBeGreaterThan(0);
    } finally {
      (Buffer as unknown as { alloc: unknown }).alloc = orig;
    }
    expect(Math.max(...sizes)).toBeLessThanOrEqual(64 * 1024);
  });

  it('沒在動的舊檔不會每一輪都被 stat；新檔案在重新走訪之後會被找到', async () => {
    const now = Date.now();
    const old = projectFile('old.jsonl');
    fs.writeFileSync(old, assistant(now - 3600_000, [toolUse('old1', 'Bash', { command: 'a' })]));
    const past = new Date(now - 2 * 3600_000);
    fs.utimesSync(old, past, past);                                            // 2 小時前就沒動過

    const s = new TranscriptScanner(home, 1024 * 1024, 60_000);                // 60 秒才重新走訪
    await s.refresh();
    expect(s.snapshotCalls().map(c => c.toolUseId)).toEqual(['old1']);

    const stat = vi.spyOn(fs.promises, 'stat');
    await s.refresh();
    await s.refresh();
    expect(stat.mock.calls.filter(c => String(c[0]).endsWith('old.jsonl'))).toHaveLength(0);

    fs.writeFileSync(projectFile('new.jsonl'), assistant(now - 100, [toolUse('new1', 'Bash', { command: 'b' })]));
    await s.refresh();                                                          // 還沒到重新走訪時間：看不到新檔
    expect(s.snapshotCalls().map(c => c.toolUseId)).toEqual(['old1']);
    const s2 = new TranscriptScanner(home, 1024 * 1024, 0);                     // 每輪都走訪：馬上看到
    await s2.refresh();
    expect(s2.snapshotCalls().map(c => c.toolUseId).sort()).toEqual(['new1', 'old1']);
    stat.mockRestore();
  });
});

describe('RAG 工具的摘要', () => {
  const summaryOf = async (tool: string, input: Record<string, unknown>): Promise<string> => {
    fs.writeFileSync(projectFile(), assistant(Date.now() - 2000, [toolUse('t1', tool, input)]));
    return (await scan()).snapshotCalls()[0].summary;
  };

  it.each([
    ['mcp__local-rag__rag_index', { root: 'project', dry_run: false }, 'dry_run=false root=project'],
    ['mcp__local-rag__rag_index', { root: 'project', dry_run: true }, 'dry_run=true root=project'],
    ['mcp__local-rag__rag_index', { dry_run: false, paths: ['docs'], root: 'project' }, 'dry_run=false root=project'], // 欄位順序不影響
    ['mcp__local-rag__rag_index', { root: 'project' }, 'root=project'], // 沒帶＝不寫旗標（預設試跑）
    ['mcp__local-rag__rag_remove', { source: 'project/docs/A.md', dry_run: false }, 'dry_run=false source=project/docs/A.md'],
    ['mcp__local-rag__rag_prune', { root: 'project', dry_run: true }, 'dry_run=true root=project'],
  ])('寫入工具把 dry_run 旗標放最前面：%s', async (tool, input, expected) => expect(await summaryOf(tool, input)).toBe(expected));

  it('旗標在其餘摘要被截斷時仍然保留（放後面會被截掉，把真的寫入誤顯示成試跑）', async () => {
    const s = await summaryOf('mcp__local-rag__rag_remove', { source: 'x'.repeat(300), dry_run: false });
    expect(s.startsWith('dry_run=false source=')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
  });

  it.each([
    ['mcp__local-rag__rag_search', { query: '怪獸機甲', top_k: 3 }, '怪獸機甲'],
    ['mcp__local-rag__rag_chunk', { ref: 'project/docs/A.md#3' }, 'ref=project/docs/A.md#3'],
    ['mcp__local-rag__rag_chunks', { limit: 5, source: 'project/docs/A.md' }, 'source=project/docs/A.md'],
    ['mcp__local-rag__rag_status', {}, ''],
  ])('查詢類工具用一般的摘要：%s', async (tool, input, expected) => expect(await summaryOf(tool, input)).toBe(expected));

  it.each([
    ['mcp__other__do_something', { dry_run: false, name: 'x' }, 'name=x'], // 不是 RAG 工具：不特別處理 dry_run
    ['Bash', { command: 'ls', dry_run: false }, 'ls'],
  ])('其他工具的摘要不變：%s', async (tool, input, expected) => expect(await summaryOf(tool, input)).toBe(expected));

  it('dry_run 不是布林值時忽略，不亂解讀', async () => {
    expect(await summaryOf('mcp__local-rag__rag_index', { root: 'project', dry_run: 'false' })).toBe('root=project');
  });
});
