// Codex rollout JSONL is an observed local format, not a network API.
// Read complete lines only; never modify transcripts or execute their contents.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SessionDto, SessionStatus, ToolCallDto, ToolResult } from './types';

type Json = Record<string, unknown>;
const obj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string => typeof v === 'string' ? v : '';
interface State { id: string; model: string; last: number; turns: Set<string>; calls: Map<string, ToolCallDto> }
interface Cursor { offset: number; session: string }
const WindowMs = 7 * 86400_000;

export class CodexScanner {
  private readonly files = new Map<string, Cursor>();
  private readonly sessions = new Map<string, State>();
  private lastWalk = 0;
  constructor(readonly home: string, private readonly rewalkMs = 10_000) {}
  get found(): boolean { return fs.existsSync(path.join(this.home, 'sessions')); }

  async refresh(): Promise<void> {
    const now = Date.now();
    if (now - this.lastWalk >= this.rewalkMs || this.files.size === 0) {
      this.lastWalk = now;
      for (const file of walk(path.join(this.home, 'sessions'))) {
        if (!this.files.has(file)) this.files.set(file, { offset: 0, session: fileId(file) });
      }
    }
    for (const [file, cursor] of this.files) {
      try {
        const stat = await fs.promises.stat(file);
        if (stat.mtimeMs < now - WindowMs && cursor.offset === 0) continue;
        if (stat.size < cursor.offset) cursor.offset = 0;
        if (stat.size === cursor.offset) continue;
        const handle = await fs.promises.open(file, 'r');
        try {
          let pos = cursor.offset, carry: Buffer = Buffer.alloc(0), dropping = false;
          while (pos < stat.size) {
            const chunk = Buffer.alloc(Math.min(1024 * 1024, stat.size - pos));
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, pos);
            if (!bytesRead) break;
            pos += bytesRead;
            const data: Buffer = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
            let start = 0, end: number;
            while ((end = data.indexOf(10, start)) >= 0) {
              if (!dropping) this.parse(data.subarray(start, end).toString('utf8'), cursor);
              dropping = false;
              start = end + 1;
              cursor.offset = pos - data.length + start;
            }
            carry = data.subarray(start);
            if (carry.length > 8 * 1024 * 1024) { carry = Buffer.alloc(0); dropping = true; }
            await new Promise<void>(resolve => setImmediate(resolve));
          }
        } finally { await handle.close(); }
      } catch { /* missing, locked or incomplete file: retry next scan */ }
    }
  }

  private parse(line: string, cursor: Cursor): void {
    let root: Json;
    try { const value: unknown = JSON.parse(line); if (!obj(value)) return; root = value; } catch { return; }
    const p = root.payload;
    const time = Date.parse(text(root.timestamp));
    if (!obj(p) || !Number.isFinite(time)) return;
    if (root.type === 'session_meta' && text(p.id)) cursor.session = text(p.id);
    const id = 'codex:' + cursor.session;
    let s = this.sessions.get(id);
    if (!s) { s = { id, model: '', last: 0, turns: new Set(), calls: new Map() }; this.sessions.set(id, s); }
    // A turn_context changes the model but does not itself start a task.
    if (root.type === 'turn_context') { if (text(p.model)) s.model = text(p.model); return; }
    if (root.type === 'event_msg') {
      if (p.type === 'task_started') s.turns.add(text(p.turn_id) || 'legacy');
      else if (p.type === 'task_complete' || p.type === 'turn_aborted') {
        const turn = text(p.turn_id) || text(p.root_turn_id);
        if (turn) s.turns.delete(turn); else s.turns.clear();
        // Do not let a delayed completion for an older turn cancel a newer one.
        if (s.turns.size === 0) for (const c of s.calls.values()) if (c.result === ToolResult.Running) {
          c.result = ToolResult.Interrupted;
          c.durationSeconds = Math.max(0, (time - c.time) / 1000);
        }
      } else if (!['agent_message', 'agent_reasoning', 'user_message'].includes(text(p.type))) return;
      s.last = Math.max(s.last, time);
      return;
    }
    if (root.type !== 'response_item') return;
    const callId = text(p.call_id);
    if (!callId) return;
    const key = id + ':' + callId;
    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      if (s.calls.has(key)) return;
      const input = text(p.arguments) || text(p.input);
      s.calls.set(key, { toolUseId: key, sessionId: id, agentId: '', provider: 'Codex', time,
        tool: text(p.name) || 'Codex tool', summary: summary(input), result: ToolResult.Running, durationSeconds: 0 });
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const c = s.calls.get(key);
      if (!c || c.result !== ToolResult.Running) return;
      c.result = failed(p.output) ? ToolResult.Failed : ToolResult.Ok;
      c.durationSeconds = Math.max(0, (time - c.time) / 1000);
    } else return;
    s.last = Math.max(s.last, time);
  }

  snapshotSessions(now = Date.now()): SessionDto[] {
    return [...this.sessions.values()].filter(s => s.last > 0).map(s => {
      const pending = [...s.calls.values()].some(c => c.result === ToolResult.Running);
      const age = now - s.last;
      const status = age >= 600_000 ? SessionStatus.Ended
        : pending ? (age < 15_000 ? SessionStatus.RunningTool : SessionStatus.Waiting)
        : s.turns.size > 0 ? SessionStatus.Responding
        : age < 300_000 ? SessionStatus.Idle : SessionStatus.Ended;
      return { sessionId: s.id, model: 'Codex · ' + (s.model || '未知模型'), provider: 'Codex' as const,
        status, lastActivity: s.last };
    }).sort((a, b) => b.lastActivity - a.lastActivity);
  }
  snapshotCalls(): ToolCallDto[] {
    return [...this.sessions.values()].flatMap(s => [...s.calls.values()]).sort((a, b) => b.time - a.time).slice(0, 500);
  }
}

function* walk(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(file);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield file;
  }
}
function fileId(file: string): string {
  return path.basename(file).match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i)?.[1] ?? path.basename(file, '.jsonl');
}
function summary(raw: string): string {
  try {
    const p: unknown = JSON.parse(raw);
    if (obj(p)) for (const k of ['cmd', 'command', 'query', 'file_path', 'path', 'description']) {
      if (typeof p[k] === 'string') return text(p[k]).replace(/\s+/g, ' ').slice(0, 120);
    }
  } catch { /* custom tool input is plain text */ }
  return raw.replace(/\s+/g, ' ').slice(0, 120);
}
function failed(output: unknown): boolean {
  let p: unknown = output;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { /* text output */ } }
  if (obj(p) && (p.isError === true || p.is_error === true || (typeof p.exit_code === 'number' && p.exit_code !== 0))) return true;
  if (obj(p) && obj(p.metadata) && typeof p.metadata.exit_code === 'number' && p.metadata.exit_code !== 0) return true;
  return typeof output === 'string' && /(?:Process exited with code|Exit code:)\s*-?[1-9]\d*\b/.test(output);
}
