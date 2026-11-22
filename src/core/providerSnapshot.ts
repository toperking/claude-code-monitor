import { MonitorSnapshot } from './types';

export type AiProvider = string;

const source = (provider: AiProvider | undefined, sessionId: string): AiProvider =>
  sessionId.startsWith('codex:') ? 'Codex' : provider?.trim() || 'Claude';

export function snapshotProviders(snapshot: MonitorSnapshot): string[] {
  return [...new Set([...snapshot.sessions, ...snapshot.recentToolCalls].map(s => source(s.provider, s.sessionId)))];
}

/** Isolate events before they reach the animation state machine. */
export function providerSnapshot(snapshot: MonitorSnapshot, provider: AiProvider): MonitorSnapshot {
  const sessions = new Map(snapshot.sessions.map(s => [s.sessionId, source(s.provider, s.sessionId)]));
  const sessionSource = (id: string): AiProvider => sessions.get(id) ?? source(undefined, id);
  return {
    ...snapshot,
    sessions: snapshot.sessions.filter(s => source(s.provider, s.sessionId) === provider),
    recentToolCalls: snapshot.recentToolCalls.filter(c =>
      (sessions.has(c.sessionId) ? sessionSource(c.sessionId) : source(c.provider, c.sessionId)) === provider),
    agents: snapshot.agents.filter(a => sessionSource(a.sessionId) === provider),
    usageWindows: provider === 'Claude' ? snapshot.usageWindows : [],
    lastLimitHit: provider === 'Claude' ? snapshot.lastLimitHit : null,
  };
}
