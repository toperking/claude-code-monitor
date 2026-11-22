import { describe, expect, it } from 'vitest';
import { FlowModel } from '../src/core/model';
import { fakeCanvas, newRecorded } from './fakeCanvas';
import { snap, run } from './helpers';

describe('brain model node', () => {
  async function draw(ms: number, reduceMotion = false) {
    const { FlowRenderer } = await import('../src/webview/render');
    const snapshot = snap(2);
    snapshot.sessions[0].model = 'Codex · gpt-6.1-sol';
    const m = new FlowModel({ freeIdle: false });
    m.reduceMotion = reduceMotion;
    m.sync(snapshot); run(m, 2, 2);
    const rec = newRecorded();
    const r = new FlowRenderer(fakeCanvas(rec));
    const hub = r as unknown as { ms: number; drawHub(m: FlowModel): void };
    hub.ms = ms; hub.drawHub(m);
    return rec;
  }

  it('shows only the real model name and replaces the circular hub with cortical paths', async () => {
    const rec = await draw(800);
    expect(rec.texts).toEqual(['GPT-6.1 SOL']);
    expect(rec.fills.length).toBeGreaterThan(0);
    expect(rec.arcs.every(a => a.r < 10)).toBe(true); // Tiny neural points, no circular hub or rings.
  });

  it('neural junction pulses change over time and remain static with reduced motion', async () => {
    expect((await draw(800)).arcs).not.toEqual((await draw(1600)).arcs);
    expect((await draw(800, true)).arcs).toEqual((await draw(1600, true)).arcs);
  });
});
