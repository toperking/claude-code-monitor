import { isActive, MonitorSnapshot } from './types';

export type AiProvider = string;

const source = (provider: AiProvider | undefined, sessionId: string): AiProvider =>
  sessionId.startsWith('codex:') ? 'Codex' : provider?.trim() || 'Claude';

export function snapshotProviders(snapshot: MonitorSnapshot): string[] {
  return [...new Set([...snapshot.sessions, ...snapshot.recentToolCalls].map(s => source(s.provider, s.sessionId)))];
}

/** Keep each provider in the row it first occupied; active providers take priority on the first snapshot. */
export function updateProviderOrder(snapshot: MonitorSnapshot, appearanceOrder: string[]): void {
  const providers = snapshotProviders(snapshot);
  const active = providers.filter(provider => providerSnapshot(snapshot, provider).sessions.some(s => isActive(s.status)));
  for (const provider of [...active, ...providers]) {
    if (!appearanceOrder.includes(provider)) appearanceOrder.push(provider);
  }
}

/** Isolate events before they reach the animation state machine. */
export function providerSnapshot(snapshot: MonitorSnapshot, provider: AiProvider, model?: string): MonitorSnapshot {
  const sessions = new Map(snapshot.sessions.map(s => [s.sessionId, source(s.provider, s.sessionId)]));
  const sessionSource = (id: string): AiProvider => sessions.get(id) ?? source(undefined, id);
  const modelSessions = new Set(snapshot.sessions.filter(s => source(s.provider, s.sessionId) === provider && s.model === model).map(s => s.sessionId));
  return {
    ...snapshot,
    sessions: snapshot.sessions.filter(s => source(s.provider, s.sessionId) === provider && (model === undefined || s.model === model)),
    recentToolCalls: snapshot.recentToolCalls.filter(c =>
      (sessions.has(c.sessionId) ? sessionSource(c.sessionId) : source(c.provider, c.sessionId)) === provider
      && (model === undefined || modelSessions.has(c.sessionId))),
    agents: snapshot.agents.filter(a => sessionSource(a.sessionId) === provider && (model === undefined || modelSessions.has(a.sessionId))),
    usageWindows: provider === 'Claude' ? snapshot.usageWindows : [],
    lastLimitHit: provider === 'Claude' ? snapshot.lastLimitHit : null,
  };
}
