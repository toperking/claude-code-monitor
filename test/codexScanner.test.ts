import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexScanner } from '../src/core/codexScanner';
import { SessionStatus, ToolResult } from '../src/core/types';
import { FlowModel } from '../src/core/model';
import { emptySnapshot } from '../src/core/types';

let home: string, file: string, now: number;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-codex-'));
  fs.mkdirSync(path.join(home, 'sessions', '2026'), { recursive: true });
  file = path.join(home, 'sessions', '2026', 'rollout.jsonl');
  now = Date.now();
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
const line = (type: string, payload: unknown, delta = 0): string => JSON.stringify({ timestamp: new Date(now + delta).toISOString(), type, payload }) + '\n';
const event = (type: string, turn_id = 'turn1', delta = 0): string => line('event_msg', { type, turn_id }, delta);
const call = (type = 'function_call', id = 'c1'): string => line('response_item', { type, call_id: id, name: 'exec_command', arguments: '{"cmd":"測試 build"}' });
const result = (output: unknown = 'Process exited with code 0', type = 'function_call_output'): string => line('response_item', { type, call_id: 'c1', output }, 2500);
const setup = (...lines: string[]): void => fs.writeFileSync(file, line('session_meta', { id: 's1' }) + line('turn_context', { model: 'gpt-test' }) + lines.join(''));

describe('Codex rollout scanner', () => {
  it('uses real task start/completion instead of recent mtime to report busy', async () => {
    setup(event('task_started'));
    const s = new CodexScanner(home); await s.refresh();
    expect(s.snapshotSessions(now)[0]).toMatchObject({ provider: 'Codex', model: 'Codex · gpt-test', status: SessionStatus.Responding });
    fs.appendFileSync(file, event('task_complete', 'turn1', 100)); await s.refresh();
    expect(s.snapshotSessions(now + 100)[0].status).toBe(SessionStatus.Idle);
    const m = new FlowModel(); m.sync({ ...emptySnapshot(now + 100), sessions: s.snapshotSessions(now + 100), recentToolCalls: s.snapshotCalls() });
    expect(m.stats.running).toBe(0); expect(m.stats.ok).toBe(0);
  });
  it.each([['function_call', 'function_call_output'], ['custom_tool_call', 'custom_tool_call_output']])('pairs %s by namespaced call id', async (input, output) => {
    setup(event('task_started'), call(input));
    const s = new CodexScanner(home); await s.refresh();
    expect(s.snapshotSessions(now)[0].status).toBe(SessionStatus.RunningTool);
    expect(s.snapshotCalls()[0]).toMatchObject({ toolUseId: 'codex:s1:c1', summary: '測試 build', provider: 'Codex' });
    fs.appendFileSync(file, result(undefined, output)); await s.refresh(); await s.refresh();
    expect(s.snapshotCalls()).toHaveLength(1);
    expect(s.snapshotCalls()[0]).toMatchObject({ result: ToolResult.Ok, durationSeconds: 2.5 });
  });
  it.each([{ isError: true }, '{"exit_code":2}', '{"metadata":{"exit_code":2}}', 'Process exited with code 1', 'Exit code: -1'])('recognizes explicit errors %j', async output => {
    setup(call(), result(output)); const s = new CodexScanner(home); await s.refresh();
    expect(s.snapshotCalls()[0].result).toBe(ToolResult.Failed);
  });
  it('does not classify arbitrary error words as execution failure', async () => {
    setup(call(), result('found text: error handling')); const s = new CodexScanner(home); await s.refresh();
    expect(s.snapshotCalls()[0].result).toBe(ToolResult.Ok);
  });
  it('preserves incomplete UTF8 lines until the writer finishes; tolerates bad JSON', async () => {
    setup('bad json\n'); const bytes = Buffer.from(call());
    const split = bytes.indexOf(Buffer.from('測')) + 1;
    fs.appendFileSync(file, bytes.subarray(0, split));
    const s = new CodexScanner(home); await s.refresh(); expect(s.snapshotCalls()).toHaveLength(0);
    fs.appendFileSync(file, bytes.subarray(split)); await s.refresh();
    expect(s.snapshotCalls()[0].summary).toBe('測試 build');
  });
  it('marks unreturned calls interrupted on abort, including aborts without a turn id', async () => {
    setup(event('task_started'), call(), line('event_msg', { type: 'turn_aborted' }, 100));
    const s = new CodexScanner(home); await s.refresh();
    expect(s.snapshotCalls()[0].result).toBe(ToolResult.Interrupted);
    expect(s.snapshotSessions(now + 100)[0].status).toBe(SessionStatus.Idle);
    const model = new FlowModel(); model.sync({ ...emptySnapshot(now + 100), sessions: s.snapshotSessions(now + 100), recentToolCalls: s.snapshotCalls() });
    expect(model.stats.running).toBe(0); expect(model.stats.ok).toBe(0);
  });
  it('does not let an older turn completion cancel a new turn', async () => {
    setup(event('task_started', 'old'), event('task_started', 'new'), call(), event('task_complete', 'old', 100));
    const s = new CodexScanner(home); await s.refresh();
    expect(s.snapshotSessions(now + 100)[0].status).toBe(SessionStatus.RunningTool);
    expect(s.snapshotCalls()[0].result).toBe(ToolResult.Running);
  });
  it('never invents timestamps for malformed events or a model-only context', async () => {
    setup(JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }) + '\n');
    const s = new CodexScanner(home); await s.refresh(); expect(s.snapshotSessions()).toEqual([]);
  });
  it('bounds stale sessions and discovers new files without restart', async () => {
    setup(event('task_started'), call()); const s = new CodexScanner(home, 0); await s.refresh();
    expect(s.snapshotSessions(now + 600_000)[0].status).toBe(SessionStatus.Ended);
    fs.writeFileSync(path.join(path.dirname(file), 'other.jsonl'), line('session_meta', { id: 's2' }) + call()); await s.refresh();
    expect(s.snapshotSessions(now)).toHaveLength(2);
    expect(new Set(s.snapshotCalls().map(c => c.toolUseId)).size).toBe(2);
  });
  it('does not modify local transcripts, and missing home is allowed', async () => {
    setup(call()); const original = fs.readFileSync(file); const stat = fs.statSync(file);
    const s = new CodexScanner(home); await s.refresh();
    expect(fs.readFileSync(file)).toEqual(original); expect(fs.statSync(file).mtimeMs).toBe(stat.mtimeMs);
    const missing = new CodexScanner(path.join(home, 'missing')); await missing.refresh();
    expect(missing.found).toBe(false); expect(missing.snapshotSessions()).toEqual([]);
  });
  it('feeds Codex tools into existing mech dispatch with no Claude usage changes', async () => {
    setup(event('task_started'), call(), call('function_call', 'c2'));
    const s = new CodexScanner(home); await s.refresh();
    const m = new FlowModel(); m.sync({ ...emptySnapshot(now), sessions: s.snapshotSessions(now), recentToolCalls: s.snapshotCalls() });
    expect(m.activeSessions).toBe(1); expect(m.stats.running).toBe(2);
    expect(m.pillList.some(p => p.name === 'exec_command')).toBe(true);
  });
});
