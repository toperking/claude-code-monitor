import { describe, expect, it } from 'vitest';
import { FlowModel } from '../src/core/model';
import { providerSnapshot, snapshotProviders } from '../src/core/providerSnapshot';
import { flowSceneRows } from '../src/core/flowSceneLayout';
import { fakeCanvas, newRecorded } from './fakeCanvas';
import { call, run, snap, SessionStatus, ToolResult } from './helpers';

function mixed() {
  const s = snap(2, [call('claude-call', 'Bash', ToolResult.Failed)]);
  s.sessions.push(
    { sessionId: 'codex:cx', provider: 'Codex', model: 'Codex · gpt-5', status: SessionStatus.RunningTool, lastActivity: s.at },
    { sessionId: 'gx', provider: 'Gemini', model: 'gemini-test', status: SessionStatus.RunningTool, lastActivity: s.at },
  );
  // Call providers can be absent: use the parent session, including future providers.
  s.recentToolCalls.push(call('codex-call', 'Bash', ToolResult.Running, 2, { sessionId: 'codex:cx' }),
    call('gemini-call', 'Bash', ToolResult.Ok, 2, { sessionId: 'gx' }));
  s.agents.push({ sessionId: 'gx', agentId: 'child', model: 'gemini-test', status: SessionStatus.Responding,
    lastActivity: s.at, parentToolUseId: null, parentAgentId: '' });
  s.lastLimitHit = { hitAt: s.at, resetsAt: s.at + 1000, limitType: 'five_hour' };
  return s;
}

describe('independent provider flows', () => {
  it('discovers future providers and keeps agents and Claude quota in their own lanes', () => {
    const s = mixed();
    expect(snapshotProviders(s)).toEqual(['Claude', 'Codex', 'Gemini']);
    const gemini = providerSnapshot(s, 'Gemini');
    expect(gemini.sessions.map(x => x.sessionId)).toEqual(['gx']);
    expect(gemini.agents).toHaveLength(1);
    expect(gemini.recentToolCalls.map(c => c.toolUseId)).toEqual(['gemini-call']);
    expect(gemini.lastLimitHit).toBeNull();
    expect(providerSnapshot(s, 'Claude').lastLimitHit).toEqual(s.lastLimitHit);
    expect(s.recentToolCalls).toHaveLength(3);
  });

  it('same-name tools get independent counts, models, robots and animation targets', () => {
    const s = mixed();
    for (const [provider, id] of [['Claude', 'claude-call'], ['Codex', 'codex-call'], ['Gemini', 'gemini-call']]) {
      const m = new FlowModel({ provider, freeIdle: false });
      m.sync(s);
      run(m, 3, 2);
      expect(m.stats.total).toBe(1);
      expect(m.log[0].toolUseId).toBe(id);
      expect(m.pillList[0].recent.every(c => c.toolUseId === id)).toBe(true);
      expect(m.sessions).toHaveLength(1);
      expect(m.aliens.some(u => u.ownerKey === '')).toBe(true);
    }
  });

  it('Codex activity does not keep the Claude lane busy', () => {
    const s = mixed();
    s.sessions[0].status = SessionStatus.Ended;
    const claude = new FlowModel({ provider: 'Claude' });
    const codex = new FlowModel({ provider: 'Codex' });
    claude.sync(s); codex.sync(s);
    expect(claude.busy).toBe(false);
    expect(codex.busy).toBe(true);
    expect(claude.stats.fail).toBe(1);
    expect(codex.stats.fail).toBe(0);
  });

  it('routes a namespaced orphan Codex call without a session', () => {
    const s = snap(2, [call('orphan', 'Bash', ToolResult.Running, 2, { sessionId: 'codex:orphan' })]);
    expect(providerSnapshot(s, 'Codex').recentToolCalls).toHaveLength(1);
    expect(providerSnapshot(s, 'Claude').recentToolCalls).toHaveLength(0);
  });

  it('one renderer stacks all providers and hit testing resolves identical tool keys to the correct row', async () => {
    const { FlowRenderer } = await import('../src/webview/render');
    const models = ['Claude', 'Codex', 'Gemini'].map(provider => {
      const m = new FlowModel({ provider, freeIdle: false });
      m.sync(mixed()); run(m, 3, 2);
      return m;
    });
    const rec = newRecorded();
    const renderer = new FlowRenderer(fakeCanvas(rec));
    renderer.resize(1300, 900, 1);
    renderer.renderScene(models, 3000);
    const rows = flowSceneRows(models);
    expect(rows.map(r => r.model.providerLabel)).toEqual(['Claude', 'Codex', 'Gemini']);
    expect(rows[0].y + rows[0].height / 2).toBeLessThanOrEqual(rows[1].y - rows[1].height / 2);
    for (const row of rows) {
      const pill = row.model.pillList[0];
      const hit = (renderer as unknown as { hitScene(p: { x: number; y: number }): unknown }).hitScene({ x: 0, y: row.y + pill.y });
      expect(hit).toBe(pill);
      expect(rec.texts).toContain(row.model.providerLabel.toUpperCase());
    }
  });
});
