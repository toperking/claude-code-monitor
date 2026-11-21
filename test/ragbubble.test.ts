import { describe, expect, it } from 'vitest';
import { BubbleQueue } from '../src/core/bubbles';
import { FlowModel, Palette, ragText } from '../src/core/model';
import { isRagWrite, ragActionOf } from '../src/core/ragTools';
import { ToolResult } from '../src/core/types';
import { fakeCanvas, newRecorded } from './fakeCanvas';
import { after, call, run, snap } from './helpers';

// RAG 泡泡：Claude Code 使用本機 RAG（MCP 工具）時，顯示做了什麼；索引類另外標示是試跑還是真的寫入。
// 與 C# 的 Tests/BubbleRagTests.cs 一一對應。

const S = 'mcp__local-rag__';
const rag = (id: string, action: string, summary: string, result: string = ToolResult.Ok, dur = 0.2, at = 1) =>
  call(id, S + action, result, at, { summary, durationSeconds: dur });
const bubblesAfter = (...calls: ReturnType<typeof rag>[]) => after(snap(2, calls)).bubbles.items;

describe('辨識', () => {
  it.each([
    ['mcp__local-rag__rag_search', 'rag_search'],
    ['mcp__my-own-name__rag_index', 'rag_index'], // 伺服器名稱不限
    ['mcp__x__rag_chunk', 'rag_chunk'],
    ['mcp__local-rag__rag_todo', 'rag_todo'],
    ['mcp__local-rag__rag_ingest_note', 'rag_ingest_note'],
    ['mcp__local-rag__rag_annotate', 'rag_annotate'],
    ['mcp__local-rag__rag_unknown', null], // 不是 RagMcp 的 12 個動作
    ['rag_search', null], // 不是 MCP 工具
    ['mcp__rag_search', null], // 少一段
    ['Grep', null],
    ['mcp__windows-mcp__Click', null],
  ])('%s → %s', (tool, action) => expect(ragActionOf(tool)).toBe(action));

  it('只有索引、刪除、清理是寫入動作', () => {
    for (const a of ['rag_index', 'rag_remove', 'rag_prune', 'rag_ingest_note']) expect(isRagWrite(a)).toBe(true);
    for (const a of ['rag_search', 'rag_status', null]) expect(isRagWrite(a)).toBe(false);
  });
});

describe('泡泡文字', () => {
  it('RAG 查詢：已經結束的呼叫也會彈出泡泡，顯示查詢句；指向 MCP 伺服器合併後的方塊', () => {
    const [b, ...others] = bubblesAfter(rag('a', 'rag_search', '怪獸機甲為什麼要加翅膀？'));
    expect(others).toHaveLength(0);
    expect(b.kind).toBe('rag');
    expect(b.text).toBe('RAG 查詢 ▸ 怪獸機甲為什麼要加翅膀？');
    expect(b.color).toBe(Palette.Rag);
    expect(b.anchorKey).toBe('mcp:local-rag');
  });

  it('太長的查詢句會縮短，泡泡才不會變很大', () => {
    const [b] = bubblesAfter(rag('a', 'rag_search', '字'.repeat(100)));
    expect(b.text.startsWith('RAG 查詢 ▸ ')).toBe(true);
    expect(b.text.endsWith('…')).toBe(true);
    expect(b.text.length).toBeLessThan(40);
  });

  it.each([
    ['rag_sources', '', 'RAG 列出來源'],
    ['rag_status', '', 'RAG 查看狀態'],
    ['rag_tables', '', 'RAG 查看資料表'],
    ['rag_chunks', 'source=project/docs/FLOW_REDESIGN.md', 'RAG 查看片段 ▸ FLOW_REDESIGN.md'],
    ['rag_chunk', 'ref=project/docs/FLOW_REDESIGN.md#42', 'RAG 讀取片段 ▸ FLOW_REDESIGN.md#42'],
    ['rag_chunk', 'ref=project\\docs\\A.md#3', 'RAG 讀取片段 ▸ A.md#3'], // 反斜線也認得
  ])('%s（%s）→ %s', (action, summary, text) => expect(bubblesAfter(rag('a', action, summary))[0].text).toBe(text));

  it.each([
    ['rag_index', 'dry_run=false root=project', 'RAG 索引 project · 寫入'],
    ['rag_index', 'dry_run=true root=project', 'RAG 索引 project · 試跑'],
    ['rag_index', 'root=project', 'RAG 索引 project · 試跑'], // 沒帶旗標＝伺服器預設的試跑
    ['rag_remove', 'dry_run=false source=project/docs/OLD.md', 'RAG 刪除 OLD.md · 刪除'],
    ['rag_remove', 'source=project/docs/OLD.md', 'RAG 刪除 OLD.md · 試跑'],
    ['rag_prune', 'dry_run=false root=project', 'RAG 清理 project · 刪除'],
    ['rag_prune', 'root=project', 'RAG 清理 project · 試跑'],
    ['rag_ingest_note', 'dry_run=false title=RAG現況', 'RAG 記錄筆記 ▸ RAG現況 · 寫入'],
    ['rag_ingest_note', 'title=RAG現況', 'RAG 記錄筆記 ▸ RAG現況 · 試跑'],
    ['rag_todo', 'limit=5', 'RAG 取待標註片段'],
    ['rag_annotate', 'items=3', 'RAG 寫標註'],
  ])('寫入類 %s（%s）標示試跑或真的改了 → %s', (action, summary, text) => expect(bubblesAfter(rag('a', action, summary))[0].text).toBe(text));

  it('摘要沒有任何細節時，仍然是合理的泡泡', () => {
    expect(bubblesAfter(rag('a', 'rag_search', ''))[0].text).toBe('RAG 查詢');
    expect(bubblesAfter(rag('a', 'rag_index', ''))[0].text).toBe('RAG 索引 · 試跑');
    expect(bubblesAfter(rag('a', 'rag_chunk', ''))[0].text).toBe('RAG 讀取片段');
  });

  it('ragText 對非 RAG 工具回傳 null', () => {
    expect(ragText(call('a', 'Bash', ToolResult.Ok, 1, { summary: 'ls' }))).toBeNull();
  });
});

describe('不該變成 RAG 泡泡的', () => {
  it('其他 MCP 工具與名稱相似的工具', () => {
    const items = bubblesAfter(
      call('a', 'mcp__windows-mcp__Click', ToolResult.Running, 1, { summary: 'x=1' }),
      call('b', 'mcp__local-rag__rag_unknown', ToolResult.Running, 1, { summary: 'q' }),
      call('c', 'rag_search', ToolResult.Running, 1, { summary: 'q' }),
    );
    expect(items.some(b => b.kind === 'rag')).toBe(false);
  });

  it('失敗的 RAG 呼叫顯示失敗泡泡，不是 RAG 泡泡', () => {
    const [b, ...rest] = bubblesAfter(rag('a', 'rag_index', 'dry_run=false root=project', ToolResult.Failed, 1.5));
    expect(rest).toHaveLength(0);
    expect(b.kind).toBe('failure');
    expect(b.text).toContain('local-rag');
  });

  it('開啟當下就有的舊呼叫、以及「減少動態」，都不彈泡泡', () => {
    const start = new FlowModel({ freeIdle: false });
    start.sync(snap(2, [rag('a', 'rag_search', 'q')]));
    expect(start.bubbles.items).toHaveLength(0);

    const calm = new FlowModel({ freeIdle: false });
    calm.reduceMotion = true;
    calm.sync(snap(0)); calm.sync(snap(2, [rag('a', 'rag_search', 'q')]));
    expect(calm.bubbles.items).toHaveLength(0);
  });
});

describe('佇列行為', () => {
  it('同一句查詢再來一次不會疊第二顆，不同的查詢各有一顆', () => {
    const m = after(snap(2, [rag('a', 'rag_search', '怪獸機甲')]));
    m.sync(snap(4, [rag('b', 'rag_search', '怪獸機甲'), rag('a', 'rag_search', '怪獸機甲')]));
    expect(m.bubbles.items).toHaveLength(1);

    m.sync(snap(5, [rag('c', 'rag_search', '分流'), rag('b', 'rag_search', '怪獸機甲'), rag('a', 'rag_search', '怪獸機甲')]));
    expect(m.bubbles.items.map(b => b.text)).toEqual(['RAG 查詢 ▸ 怪獸機甲', 'RAG 查詢 ▸ 分流']);
  });

  it('RAG 泡泡壽命 6 秒，瑣碎的「工具開始」擠不掉它', () => {
    const q = new BubbleQueue();
    q.add('rag', 'mcp:local-rag', 'RAG 查詢 ▸ A', Palette.Rag);
    q.add('rag', 'mcp:local-rag', 'RAG 索引 project · 試跑', Palette.Rag);
    q.add('rag', 'mcp:local-rag', 'RAG 查看狀態', Palette.Rag);
    q.add('toolStart', 'Bash', 'Bash ▸ ls', '#fff');

    expect(q.items).toHaveLength(3);
    expect(q.items.some(b => b.kind === 'toolStart')).toBe(false);
    for (const b of q.items) expect(b.life).toBe(BubbleQueue.RagLife);

    q.tick(BubbleQueue.RagLife + 0.1, () => true);
    expect(q.items).toHaveLength(0);
  });

  it('RAG 的顏色和其他泡泡的顏色不同', () => {
    const others = [Palette.Doc, Palette.Agent, Palette.Skill, Palette.Task, Palette.Ok, Palette.Fail, Palette.Warn];
    expect(others).not.toContain(Palette.Rag);
  });
});

describe('畫面', () => {
  it('RAG 泡泡真的用粉紅色畫出來，而且寫了對的字；沒有 RAG 呼叫的畫面完全沒有這個顏色', async () => {
    const { FlowRenderer } = await import('../src/webview/render');
    const pink = 'rgba(244,114,182,1)';
    const draw = (m: FlowModel) => {
      const rec = newRecorded();
      const r = new FlowRenderer(fakeCanvas(rec));
      r.resize(1400, 700, 1);
      r.render(m, 0);
      return rec;
    };

    // 用已完成、而且時間不重疊的呼叫：同時在跑的呼叫（不論掃描時是否已完成）會另外觸發「分流」泡泡，佔掉畫面最多 3 顆泡泡的名額
    const withRag = after(snap(2, [
      rag('a', 'rag_search', '怪獸機甲為什麼要加翅膀？', ToolResult.Ok, 0.2, 1.0),
      rag('b', 'rag_index', 'dry_run=false root=project', ToolResult.Ok, 0.2, 1.4),
      rag('c', 'rag_status', '', ToolResult.Ok, 0.2, 1.8),
    ]));
    run(withRag, 1.2, 2);
    expect(withRag.bubbles.items.filter(b => b.kind === 'rag')).toHaveLength(3);

    const rec = draw(withRag);
    expect(rec.strokes.filter(s => s === pink).length).toBeGreaterThanOrEqual(3);
    for (const t of ['RAG 查詢 ▸ 怪獸機甲為什麼要加翅膀？', 'RAG 索引 project · 寫入', 'RAG 查看狀態']) expect(rec.texts).toContain(t);

    const plain = after(snap(2, [call('a', 'Bash', ToolResult.Running, 1, { summary: 'ls' })]));
    run(plain, 1.2, 2);
    expect(draw(plain).strokes).not.toContain(pink);
  });
});
