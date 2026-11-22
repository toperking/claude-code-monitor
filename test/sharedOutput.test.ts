import { describe, expect, it } from 'vitest';
import { alienOutSpot, FlowModel, Layout, routeOut, routeRejected } from '../src/core/model';
import { flowSceneRows, sharedOutputY } from '../src/core/flowSceneLayout';
import { emptySnapshot, SessionStatus, ToolResult } from '../src/core/types';
import { BrainOutline } from '../src/webview/brainGlyph';
import { ArmorPaths } from '../src/webview/armorGlyph';
import { fakeCanvas, newRecorded } from './fakeCanvas';
import { agent, call, run, sec } from './helpers';

function scene() {
  const s = emptySnapshot(sec(2));
  s.sessions = ['Claude', 'Codex', 'Gemini'].map((provider, i) => ({
    provider, sessionId: i === 1 ? 'codex:s2' : 's' + (i + 1),
    model: i === 1 ? 'Codex · gpt-6.1-sol' : 'claude-sonnet-5-5', status: SessionStatus.Idle, lastActivity: sec(2),
  }));
  s.agents = [agent()];
  s.recentToolCalls = s.sessions.map((session, i) => call('result' + i, 'Bash', i === 1 ? ToolResult.Failed : ToolResult.Ok, 2, { sessionId: session.sessionId, provider: session.provider }));
  const models = s.sessions.map(session => {
    const m = new FlowModel({ provider: session.provider, freeIdle: false });
    m.sync(emptySnapshot(sec(0))); m.sync(s);
    return m;
  });
  const rows = flowSceneRows(models);
  rows.forEach((row, i) => { row.model.outputOffsetY = sharedOutputY(rows) - row.y; row.model.outputSlotOffset = i; });
  return { models, rows };
}

describe('one shared armored output for the whole wallpaper', () => {
  it('draws exactly one gauntlet and one boot plus brains for both main AIs and subagents', async () => {
    const { FlowRenderer } = await import('../src/webview/render');
    const { models } = scene();
    models.forEach(m => run(m, 3, 2));
    const rec = newRecorded();
    const renderer = new FlowRenderer(fakeCanvas(rec));
    renderer.resize(1400, 1200, 1); renderer.renderScene(models, 900);
    expect(rec.fills.filter(f => f.path.svgSource === ArmorPaths.Fist)).toHaveLength(1);
    expect(rec.fills.filter(f => f.path.svgSource === ArmorPaths.Boot)).toHaveLength(1);
    expect(rec.fills.filter(f => f.path.svgSource === BrainOutline)).toHaveLength(4);
    expect(rec.texts.filter(t => t.startsWith('成功 '))).toEqual(['成功 2']);
    expect(rec.texts.filter(t => t.startsWith('失敗 '))).toEqual(['失敗 1']);
    expect(rec.texts).not.toContain('VERIFIED OUTPUT');
    expect(rec.texts).not.toContain('REJECTED');
  });

  it('every provider route ends at the same world coordinates', () => {
    const { models, rows } = scene();
    models.forEach(m => run(m, 1, 2));
    for (const row of rows) for (const pill of row.model.pillList) {
      const out = routeOut(pill, row.model.outputOffsetY)[3];
      const rejected = routeRejected(pill, row.model.outputOffsetY)[3];
      expect(out.x).toBe(Layout.Out.x - Layout.OutR);
      expect(out.y + row.y).toBe(Layout.Out.y + sharedOutputY(rows));
      expect(rejected.y + row.y).toBe(Layout.Rej.y + sharedOutputY(rows));
    }
  });

  it('armor energy moves over time and stays still with reduced motion', async () => {
    const { FlowRenderer } = await import('../src/webview/render');
    const { models } = scene();
    function draw(ms: number, reduced: boolean) {
      models.forEach(m => { m.reduceMotion = reduced; });
      const rec = newRecorded();
      const r = new FlowRenderer(fakeCanvas(rec)) as unknown as { ms: number; drawOutputs(models: FlowModel[]): void };
      r.ms = ms; r.drawOutputs(models);
      return rec.arcs;
    }
    expect(draw(500, false)).not.toEqual(draw(1500, false));
    expect(draw(500, true)).toEqual(draw(1500, true));
  });

  it('robots from different provider rows arrive at the shared gauntlet or boot', () => {
    const { rows } = scene();
    for (const row of rows) {
      const m = row.model;
      let docked = false;
      for (let i = 0; i < 150; i++) {
        m.tick(.05, sec(2));
        const main = m.aliens.find(u => u.ownerKey === '')!;
        if (main.deliverTarget === null || main.pose !== 'attack') continue;
        const expected = alienOutSpot(main.deliverTarget === 'fail', main.baseScale, (main.outSlot + m.outputSlotOffset) % Layout.OutSlots);
        if (Math.hypot(main.x - expected.x, main.y + row.y - sharedOutputY(rows) - expected.y) < 15) { docked = true; break; }
      }
      expect(docked).toBe(true);
    }
  });
});


describe('shared output alignment', () => {
  it('centers the hand and foot on Codex when Claude is hidden', () => {
    const { models } = scene();
    models.forEach(m => run(m, 1, 2));
    models[0].source = 0; models[0].sink = 0;
    const rows = flowSceneRows(models);
    const y = sharedOutputY(rows);
    expect(y + (Layout.Out.y + Layout.Rej.y) / 2).toBe(rows[1].y);
  });
  it('centers the pair between the first and last brain with three providers', () => {
    const { models } = scene();
    models.forEach(m => run(m, 1, 2));
    const rows = flowSceneRows(models);
    expect(sharedOutputY(rows) + (Layout.Out.y + Layout.Rej.y) / 2).toBe((rows[0].y + rows[2].y) / 2);
  });
  it('keeps the first brain alignment with two providers', () => {
    const { models } = scene();
    models.forEach(m => run(m, 1, 2));
    const rows = flowSceneRows(models.slice(0, 2));
    expect(sharedOutputY(rows) + (Layout.Out.y + Layout.Rej.y) / 2).toBe(rows[0].y);
  });
  it('centers between the middle two brains with four providers', () => {
    const { models } = scene();
    const rows = [-540, -180, 180, 540].map(y => ({ model: models[0], y, height: 360 }));
    expect(sharedOutputY(rows) + 44).toBe(0);
  });
});
