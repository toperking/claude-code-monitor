// 資料型別（對應 C# 的 Core/Models）。時間一律用「毫秒時間戳」（Date.now() 的那種），0 代表沒有。

/** Session 狀態字串的單一來源（掃描器與畫面判斷「有沒有 AI 在執行」共用）。 */
export const SessionStatus = {
  Responding: '回應中',
  RunningTool: '執行工具中',
  Waiting: '等待授權/執行中',
  Idle: '閒置',
  Ended: '已結束',
} as const;

export const isActive = (s: string): boolean =>
  s === SessionStatus.Responding || s === SessionStatus.RunningTool || s === SessionStatus.Waiting;

export const ToolResult = { Running: '執行中', Ok: '成功', Failed: '失敗' } as const;

export interface SessionDto {
  sessionId: string;
  model: string;
  status: string;
  lastActivity: number;
}

export interface ToolCallDto {
  toolUseId: string;
  sessionId: string;
  time: number;
  tool: string;
  summary: string;
  result: string;
  durationSeconds: number;
  /** 空字串＝主 session 自己的呼叫；否則是子代理 ID。 */
  agentId: string;
}

export interface AgentDto {
  sessionId: string;
  agentId: string;
  model: string;
  status: string;
  lastActivity: number;
  parentToolUseId: string | null;
  parentAgentId: string;
}

/** 某個模型家族（Sonnet／Haiku／Opus）在區間內占的 token 比例（0–100）。 */
export interface ModelShareDto {
  model: string;
  tokens: number;
  percent: number;
}

/** 某個時間窗內的用量彙總。cacheHitRate 為 null 代表區間內沒有任何輸入。 */
export interface UsageWindowDto {
  label: string;
  totalTokens: number;
  cacheHitRate: number | null;
  models: ModelShareDto[];
}

/** 逐字稿裡真的記錄到的「撞到額度上限」事件（只有被拒絕時才會有，平常不記）。 */
export interface LimitHitDto {
  hitAt: number;
  resetsAt: number;
  limitType: string;
}

export interface MonitorSnapshot {
  at: number;
  claudeHome: string;
  claudeHomeFound: boolean;
  sessions: SessionDto[];
  recentToolCalls: ToolCallDto[];
  agents: AgentDto[];
  usageWindows: UsageWindowDto[];
  lastLimitHit: LimitHitDto | null;
}

/** 組一個空的快照（測試與畫面初始狀態用）。 */
export function emptySnapshot(at = Date.now()): MonitorSnapshot {
  return {
    at, claudeHome: '', claudeHomeFound: true, sessions: [], recentToolCalls: [], agents: [], usageWindows: [], lastLimitHit: null,
  };
}
