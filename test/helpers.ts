import { FlowModel, FlowOptions } from '../src/core/model';
import { AgentDto, MonitorSnapshot, SessionStatus, ToolCallDto, ToolResult } from '../src/core/types';

export const T0 = new Date(2026, 10, 20, 12, 0, 0).getTime();
export const sec = (s: number): number => T0 + s * 1000;

export function call(id: string, tool: string, result: string, at = 1, extra: Partial<ToolCallDto> = {}): ToolCallDto {
  return { toolUseId: id, sessionId: 's1', time: sec(at), tool, summary: 'x', result, durationSeconds: 0.2, agentId: '', ...extra };
}

export function agent(id = 'a1', status: string = SessionStatus.RunningTool): AgentDto {
  return { sessionId: 's1', agentId: id, model: 'claude-sonnet-5-5', status, lastActivity: sec(2), parentToolUseId: 'toolu_x', parentAgentId: '' };
}

export function snap(s: number, calls: ToolCallDto[] = [], agents: AgentDto[] = [], status: string = SessionStatus.RunningTool, lastActivity?: number): MonitorSnapshot {
  return {
    at: sec(s), claudeHome: 'C:\\h', claudeHomeFound: true,
    sessions: [{ sessionId: 's1', model: 'claude-sonnet-5-5', status, lastActivity: lastActivity ?? sec(s) }],
    recentToolCalls: calls, agents, usageWindows: [], lastLimitHit: null,
  };
}

/** 讓模型連續跑 seconds 秒（每幀 0.05 秒），「現在」固定在 atSec。 */
export function run(m: FlowModel, seconds: number, atSec = 2): void {
  for (let t = 0; t < seconds - 1e-9; t += 0.05) m.tick(0.05, sec(atSec));
}

/** 先同步一次沒有事件的快照（之後的才算新事件），再同步 next。 */
export function after(next: MonitorSnapshot, options: Partial<FlowOptions> = {}): FlowModel {
  const m = new FlowModel({ freeIdle: false, ...options });
  m.sync(snap(0));
  m.sync(next);
  return m;
}

/** 固定種子的亂數（mulberry32），測試才可重現。 */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export { ToolResult, SessionStatus };
