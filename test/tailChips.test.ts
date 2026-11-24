import { describe, expect, it } from 'vitest';
import {
  TailChipMax, TailFadeMs, TailFailLingerMs, TailOkLingerMs, tailChips, tailLabel,
} from '../src/core/tailChips';
import { ToolCallDto, ToolResult } from '../src/core/types';

const NOW = 1_000_000;
let seq = 0;
function call(result: string, startAgoSec: number, durationSeconds = 0, summary = 'x'): ToolCallDto {
  return {
    toolUseId: 't' + seq++, sessionId: 's', time: NOW - startAgoSec * 1000, tool: 'Bash',
    summary, result, durationSeconds, agentId: '',
  };
}

describe('tailLabel', () => {
  const mk = (tool: string, summary = ''): ToolCallDto => ({ ...call(ToolResult.Ok, 1, 1, summary), tool });
  it('檔案工具顯示動作與檔名，不顯示整條路徑', () => {
    expect(tailLabel(mk('Read', 'd:\\Desktop\\docs\\FLOW.md'))).toBe('讀取 FLOW.md');
    expect(tailLabel(mk('Edit', '/a/b/c.ts'))).toBe('編輯 c.ts');
  });
  it('MCP 工具顯示動作名，不顯示 mcp__ 前綴', () => {
    expect(tailLabel(mk('mcp__windows-mcp__Screenshot'))).toBe('Screenshot');
    expect(tailLabel(mk('mcp__local-rag__rag_search', 'FLOW'))).toBe('rag_search FLOW');
  });
  it('一般工具顯示摘要，沒有摘要就用工具名', () => {
    expect(tailLabel(mk('Bash', 'dotnet build'))).toBe('dotnet build');
    expect(tailLabel(mk('Bash', ''))).toBe('Bash');
  });
});

describe('tailChips', () => {
  it('沒有時鐘或沒有呼叫時什麼都不顯示', () => {
    expect(tailChips([call(ToolResult.Running, 1)], 0).chips).toHaveLength(0);
    expect(tailChips([], NOW).chips).toHaveLength(0);
  });

  it('執行中的呼叫一直顯示，秒數是已經跑了多久', () => {
    const r = tailChips([call(ToolResult.Running, 90)], NOW);
    expect(r.chips).toHaveLength(1);
    expect(r.chips[0].state).toBe('run');
    expect(r.chips[0].alpha).toBe(1);
    expect(r.chips[0].seconds).toBeCloseTo(90, 5);
  });

  it('剛成功的留幾秒就消失；失敗的留比較久', () => {
    const okFresh = call(ToolResult.Ok, 2, 1);                       // 結束於 1 秒前
    const okOld = call(ToolResult.Ok, 30, 1);                        // 結束很久了
    const failMid = call(ToolResult.Failed, 12, 1);                  // 結束於 11 秒前：失敗仍在
    expect(tailChips([okFresh], NOW).chips[0].state).toBe('ok');
    expect(tailChips([okOld], NOW).chips).toHaveLength(0);
    expect(tailChips([failMid], NOW).chips[0].state).toBe('fail');
    expect(TailFailLingerMs).toBeGreaterThan(TailOkLingerMs);
  });

  it('快消失時淡出，剛結束時完全不透明', () => {
    const fading = call(ToolResult.Ok, (TailOkLingerMs - TailFadeMs / 2) / 1000, 0);
    const a = tailChips([fading], NOW).chips[0].alpha;
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
    expect(tailChips([call(ToolResult.Ok, 1, 1)], NOW).chips[0].alpha).toBe(1);
  });

  it('未完成／已中止的呼叫不留標籤', () => {
    expect(tailChips([call(ToolResult.Interrupted, 1)], NOW).chips).toHaveLength(0);
  });

  it('超過上限只留最新幾張，其餘算進 more；由舊到新排列', () => {
    const calls = [5, 4, 3, 2, 1].map(s => call(ToolResult.Running, s, 0, 'c' + s)); // 最新在最前也無妨
    const r = tailChips(calls, NOW);
    expect(r.chips).toHaveLength(TailChipMax);
    expect(r.more).toBe(2);
    expect(r.chips.map(c => c.call.summary)).toEqual(['c3', 'c2', 'c1']);
  });
});
