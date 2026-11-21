// 增量掃描 ~/.claude/projects 下的 *.jsonl（對應 C# 的 TranscriptScanner）：每個檔案只讀上次位移之後的完整行。
// 產出兩類資料：① 即時流程用的工具呼叫與 session 狀態 ② 近 5 小時／近 7 天的用量彙總。
// 完全唯讀：只開檔讀取，不寫入、不連網。

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AgentDto, LimitHitDto, MonitorSnapshot, SessionDto, SessionStatus, ToolCallDto, ToolResult, UsageWindowDto, ModelShareDto,
} from './types';
import { isRagWrite, ragActionOf } from './ragTools';

const MaxRecentCalls = 500;
const InitialWindowMs = 7 * 24 * 3600 * 1000;
/** 檔案在這段時間內有動過就算「還在動」：每一輪都會檢查它有沒有新內容。 */
const HotWindowMs = 30 * 60 * 1000;
const Synthetic = '<synthetic>'; // Claude Code 自己產生的訊息（如額度已滿提示），沒有真實用量
const UsageWindowDefs: { label: string; hours: number }[] = [{ label: '近 5 小時', hours: 5 }, { label: '近 7 天', hours: 168 }];

/** 把完整模型 ID（claude-sonnet-5-5）歸成家族名稱（Sonnet），與 /usage 的顯示方式一致。 */
export function modelFamily(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'Opus';
  if (m.includes('sonnet')) return 'Sonnet';
  if (m.includes('haiku')) return 'Haiku';
  return model.length === 0 ? '未知' : model;
}

interface MsgUsage { model: string; input: number; output: number; cacheWrite: number; cacheRead: number; time: number }

class SessionState {
  model = '';
  lastActivity = 0;
  readonly messages = new Map<string, MsgUsage>(); // 以 message.id 去重
  pending = 0;
  constructor(readonly id: string, readonly agentId: string) {}
}

interface CallRec {
  id: string; tool: string; summary: string; time: number;
  result: string; duration: number; session: SessionState | null;
}

const sk = (session: string, agent: string): string => session + '\u0000' + agent;
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export class TranscriptScanner {
  private readonly projectsDir: string;
  private readonly offsets = new Map<string, number>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly agentLinks = new Map<string, { tool: string; parentAgent: string }>();
  private readonly unresolved = new Map<string, CallRec>();
  private recent: CallRec[] = [];
  // 續接的 session 會把舊訊息重放到新檔：以全域集合去重，避免幽靈「執行中」與重複計算用量
  private readonly seenCalls = new Set<string>();
  private readonly msgOwner = new Map<string, SessionState>();

  /** 最近一次「撞到額度上限」。只有真的被拒絕時逐字稿才會記錄；沒撞過就是 null。 */
  lastLimitHit: LimitHitDto | null = null;

  /** 已知的逐字稿檔案與最近一次看到的大小／修改時間（避免每輪都 stat 幾百個沒在動的舊檔）。 */
  private readonly known = new Map<string, { mtime: number; size: number }>();
  private lastWalk = 0;

  /**
   * @param chunkBytes 每次最多讀多少位元組（預設 4 MB）。大檔分段讀，記憶體用量不會隨檔案大小成長。
   * @param rewalkMs   多久重新走訪一次資料夾找新檔案（預設 10 秒）；其餘輪次只看「最近還在動」的檔案。
   */
  constructor(readonly claudeHome: string, private readonly chunkBytes = 4 * 1024 * 1024, private readonly rewalkMs = 10_000) {
    this.projectsDir = path.join(claudeHome, 'projects');
  }

  /** 掃描新增的內容。非同步分段讀檔並讓出執行緒，免得第一次掃描大量逐字稿時卡住擴充功能主機。 */
  async refresh(): Promise<void> {
    if (!fs.existsSync(this.projectsDir)) return;
    const now = Date.now();
    const cutoff = now - InitialWindowMs;
    const hot = now - HotWindowMs;

    // 走訪整個資料夾很貴（幾百個檔案、一堆子資料夾）：每 rewalkMs 才做一次，找出新檔案；
    // 其他輪次只檢查「還沒讀完」或「最近 30 分鐘內有動過」的檔案。
    if (now - this.lastWalk >= this.rewalkMs || this.known.size === 0) {
      this.lastWalk = now;
      for (const file of walkJsonl(this.projectsDir)) if (!this.known.has(file)) this.known.set(file, { mtime: 0, size: -1 });
    }

    for (const [file, info] of this.known) {
      const offset = this.offsets.get(file) ?? 0;
      const idle = info.mtime > 0 && info.mtime < hot
        && (info.size === offset || (offset === 0 && info.mtime < cutoff)); // 讀完了（或太舊根本不讀）、而且好一陣子沒動：先不管它
      if (idle && now - this.lastWalk > 0 && now - this.lastWalk < this.rewalkMs) continue;
      try {
        const st = await fs.promises.stat(file);
        info.mtime = st.mtimeMs; info.size = st.size;
        if (offset === 0 && st.mtimeMs < cutoff) continue;
        if (st.size <= offset) continue;
        await this.readNew(file, offset);
      } catch { /* 寫入中、被刪掉或讀不到，下個週期再說 */ }
    }
    // 檔案讀取順序不等於時間順序：統一依時間排序後再截斷，確保保留的是最新的
    this.recent.sort((a, b) => b.time - a.time);
    if (this.recent.length > MaxRecentCalls) this.recent.length = MaxRecentCalls;
  }

  /** 從 offset 讀到檔案尾，每次最多 chunkBytes；只處理到最後一個換行為止，尾端沒寫完的半行留到下次（或下一段）。 */
  private async readNew(file: string, startOffset: number): Promise<void> {
    const dir = path.basename(path.dirname(file));
    const base = path.basename(file, '.jsonl');
    const fileAgent = dir === 'subagents' && base.startsWith('agent-') ? base.slice(6) : '';
    const touched = new Set<SessionState>();

    const fh = await fs.promises.open(file, 'r');
    try {
      const size = (await fh.stat()).size;
      let pos = startOffset;             // 下一次要從檔案的哪裡讀
      let carry: Buffer = Buffer.alloc(0); // 上一段尾端沒有換行結尾的半行
      let consumed = startOffset;        // 已經完整處理到哪裡（寫回 offsets 用）
      let n = 0;
      while (pos < size) {
        const len = Math.min(this.chunkBytes, size - pos);
        const chunk = Buffer.alloc(len);
        const { bytesRead } = await fh.read(chunk, 0, len, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        const data = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        const end = data.lastIndexOf(0x0a);
        if (end < 0) { carry = data; continue; } // 這一段整個都在同一行裡（超長的行）：接著讀下一段
        carry = Buffer.from(data.subarray(end + 1)); // 複製一份，才不會一直抓著整塊 chunk 的記憶體
        consumed = pos - carry.length;
        for (const line of data.subarray(0, end + 1).toString('utf8').split('\n')) {
          if (line.length === 0) continue;
          const st = this.parseLine(line, fileAgent);
          if (st) touched.add(st);
          if (++n % 2000 === 0) await new Promise<void>(r => setImmediate(r)); // 讓出執行緒
        }
      }
      if (consumed > startOffset) this.offsets.set(file, consumed);
    } finally {
      await fh.close();
    }
    for (const st of touched) recomputeModel(st);
  }

  private parseLine(line: string, fileAgent: string): SessionState | null {
    let root: unknown;
    try { root = JSON.parse(line); } catch { return null; }
    if (!isObj(root)) return null;
    this.tryReadLimitHit(root); // 與 session 無關，先讀
    const sid = root.sessionId;
    if (typeof sid !== 'string') return null;
    const msg = root.message;
    if (!isObj(msg)) return null;

    let agent = typeof root.agentId === 'string' ? root.agentId : fileAgent;
    if (agent.length === 0) agent = fileAgent;
    if (agent.length > 0 && !this.sessions.has(sk(sid, ''))) this.sessions.set(sk(sid, ''), new SessionState(sid, ''));
    let st = this.sessions.get(sk(sid, agent));
    if (!st) { st = new SessionState(sid, agent); this.sessions.set(sk(sid, agent), st); }

    // 沒有時間戳的行不可拿「現在」充數，否則舊 session 會被誤判為活躍
    const parsed = typeof root.timestamp === 'string' ? Date.parse(root.timestamp) : NaN;
    const hasTime = Number.isFinite(parsed);
    const time = hasTime ? parsed : st.lastActivity;
    if (hasTime && time > st.lastActivity) st.lastActivity = time;

    const content = msg.content;
    if (Array.isArray(content)) {
      const result = root.toolUseResult;
      if (isObj(result) && typeof result.agentId === 'string' && result.agentId.length > 0) {
        const ids = new Set<string>();
        for (const b of content)
          if (isObj(b) && b.type === 'tool_result' && typeof b.tool_use_id === 'string') ids.add(b.tool_use_id);
        if (ids.size === 1) this.agentLinks.set(sk(sid, result.agentId), { tool: [...ids][0], parentAgent: agent });
      }
      for (const block of content) this.handleBlock(block, st, time);
    }

    const u = msg.usage;
    const mid = msg.id;
    if (isObj(u) && typeof mid === 'string' && this.ownsMessage(mid, st)) {
      st.messages.set(mid, {
        model: typeof msg.model === 'string' ? msg.model : '',
        input: num(u, 'input_tokens'), output: num(u, 'output_tokens'),
        cacheWrite: num(u, 'cache_creation_input_tokens'), cacheRead: num(u, 'cache_read_input_tokens'), time,
      });
    }
    return st;
  }

  /** 同一個 message.id 只算給第一個看到它的 session（續接檔會重放舊訊息）。 */
  private ownsMessage(messageId: string, st: SessionState): boolean {
    const owner = this.msgOwner.get(messageId);
    if (!owner) { this.msgOwner.set(messageId, st); return true; }
    return owner === st;
  }

  private handleBlock(block: unknown, st: SessionState, time: number): void {
    if (!isObj(block)) return;
    if (block.type === 'tool_use') {
      const id = block.id;
      if (typeof id !== 'string' || this.seenCalls.has(id)) return;
      this.seenCalls.add(id);
      const rec: CallRec = {
        id, time, session: st, summary: summarize(block), tool: typeof block.name === 'string' ? block.name : '?',
        result: ToolResult.Running, duration: 0,
      };
      this.unresolved.set(id, rec);
      this.recent.push(rec);
      st.pending++;
    } else if (block.type === 'tool_result') {
      const rid = block.tool_use_id;
      if (typeof rid !== 'string') return;
      const call = this.unresolved.get(rid);
      if (!call) return;
      this.unresolved.delete(rid);
      call.result = block.is_error === true ? ToolResult.Failed : ToolResult.Ok;
      call.duration = Math.round((time - call.time) / 100) / 10;
      if (call.session) call.session.pending = Math.max(0, call.session.pending - 1);
    }
  }

  /**
   * 逐字稿的額度事件：{"apiError":"usage_limit_reached","quotaLimits":{"status":"rejected","resetsAt":<epoch秒>,"rateLimitType":"five_hour"}}。
   * 只在被拒絕時才有；沒有「已用百分比」這類欄位（那是 Anthropic 伺服器端資料）。
   */
  private tryReadLimitHit(root: Json): void {
    const q = root.quotaLimits;
    if (!isObj(q) || q.status !== 'rejected' || typeof q.resetsAt !== 'number') return;
    const hit = typeof root.timestamp === 'string' ? Date.parse(root.timestamp) : NaN;
    if (!Number.isFinite(hit)) return;
    const type = typeof q.rateLimitType === 'string' ? q.rateLimitType : '';
    if (this.lastLimitHit === null || hit > this.lastLimitHit.hitAt)
      this.lastLimitHit = { hitAt: hit, resetsAt: q.resetsAt * 1000, limitType: type };
  }

  // ── 快照 ──────────────────────────────────────────────────────────────

  snapshot(now = Date.now()): MonitorSnapshot {
    return {
      at: now,
      claudeHome: this.claudeHome,
      claudeHomeFound: fs.existsSync(this.claudeHome),
      sessions: this.snapshotSessions(now),
      recentToolCalls: this.snapshotCalls(),
      agents: this.snapshotAgents(now),
      usageWindows: this.snapshotUsage(now),
      lastLimitHit: this.lastLimitHit,
    };
  }

  /** 各時間窗的用量：模型家族占比（依 token 總量）與快取命中率（快取讀取 ÷ 全部輸入）。 */
  snapshotUsage(now: number): UsageWindowDto[] {
    return UsageWindowDefs.map(w => this.buildWindow(w.label, now - w.hours * 3600 * 1000));
  }

  private buildWindow(label: string, since: number): UsageWindowDto {
    let input = 0, cacheWrite = 0, cacheRead = 0, total = 0;
    const byFamily = new Map<string, number>();
    for (const s of this.sessions.values()) {
      for (const m of s.messages.values()) {
        const tokens = m.input + m.output + m.cacheWrite + m.cacheRead;
        if (m.time < since || tokens === 0 || m.model === Synthetic) continue;
        input += m.input; cacheWrite += m.cacheWrite; cacheRead += m.cacheRead; total += tokens;
        const family = modelFamily(m.model);
        byFamily.set(family, (byFamily.get(family) ?? 0) + tokens);
      }
    }
    const allInput = input + cacheWrite + cacheRead;
    const hit = allInput === 0 ? null : cacheRead / allInput;
    const models: ModelShareDto[] = [...byFamily.entries()].sort((a, b) => b[1] - a[1])
      .map(([model, tokens]) => ({ model, tokens, percent: total === 0 ? 0 : tokens * 100 / total }));
    return { label, totalTokens: total, cacheHitRate: hit, models };
  }

  snapshotSessions(now: number): SessionDto[] {
    return [...this.sessions.values()].filter(s => s.agentId.length === 0)
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .map(s => ({ sessionId: s.id, model: s.model, status: statusOf(s, now), lastActivity: s.lastActivity }));
  }

  snapshotAgents(now: number): AgentDto[] {
    return [...this.sessions.values()].filter(s => s.agentId.length > 0)
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .map(s => {
        const link = this.agentLinks.get(sk(s.id, s.agentId));
        return {
          sessionId: s.id, agentId: s.agentId, model: s.model, status: statusOf(s, now), lastActivity: s.lastActivity,
          parentToolUseId: link ? link.tool : null, parentAgentId: link ? link.parentAgent : '',
        };
      });
  }

  snapshotCalls(): ToolCallDto[] {
    return this.recent.map(c => ({
      toolUseId: c.id, sessionId: c.session?.id ?? '', time: c.time, tool: c.tool, summary: c.summary,
      result: c.result, durationSeconds: c.duration, agentId: c.session?.agentId ?? '',
    }));
  }
}

function* walkJsonl(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(p);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

function summarize(toolUse: Json): string {
  const input = toolUse.input;
  if (!isObj(input)) return '';
  // 本機 RAG 的寫入工具（索引、刪除、清理）：真的有沒有寫入由 dry_run 決定。摘要會被截斷到 120 字，
  // 所以把旗標放在「最前面」，才不會被截掉而把真的寫入誤顯示成試跑
  const tool = typeof toolUse.name === 'string' ? toolUse.name : '';
  const flag = isRagWrite(ragActionOf(tool)) && typeof input.dry_run === 'boolean' ? `dry_run=${input.dry_run} ` : '';
  return flag + summarizeCore(input);
}

function summarizeCore(input: Json): string {
  const clip = (s: string): string => {
    const t = s.replace(/\r\n|\r|\n/g, ' ');
    return t.length > 120 ? t.slice(0, 120) + '…' : t;
  };
  for (const key of ['skill', 'command', 'file_path', 'pattern', 'query', 'url', 'description', 'prompt']) {
    const v = input[key];
    if (typeof v === 'string') return clip(v);
  }
  // 沒有標準欄位（如 MCP 工具）：取第一個字串參數當摘要
  for (const [k, v] of Object.entries(input)) if (typeof v === 'string' && v.length > 0) return clip(`${k}=${v}`);
  return '';
}

const num = (e: Json, name: string): number => (typeof e[name] === 'number' ? (e[name] as number) : 0);

/** session 的「目前模型」= 最後一個有真實模型名稱的訊息；不讓「額度已滿」的合成訊息蓋掉它。 */
function recomputeModel(st: SessionState): void {
  for (const m of st.messages.values()) if (m.model.length > 0 && m.model !== Synthetic) st.model = m.model;
}

function statusOf(s: SessionState, now: number): string {
  const age = now - s.lastActivity;
  return age < 15_000 ? (s.pending > 0 ? SessionStatus.RunningTool : SessionStatus.Responding)
    : s.pending > 0 && age < 10 * 60_000 ? SessionStatus.Waiting
    : age < 5 * 60_000 ? SessionStatus.Idle
    : SessionStatus.Ended;
}
