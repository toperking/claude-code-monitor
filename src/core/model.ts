// 即時流程的「狀態與時間軸」（對應 C# 的 Core/Flow/FlowModel.cs）：
// 左＝活躍 session，中＝AI 主節點，一排＝工具種類方塊，右＝成功輸出／失敗。
// 這裡只有資料與動畫數值（位置、淡出、粒子、機器人的動作），完全不畫圖；繪製由 webview/render.ts 負責。
// 只反映逐字稿中真實觀測到的事件；不以計時器虛構進度或粒子。
//（機器人的「自由活動」是使用者明確放寬的隨機裝飾，不代表任何事件；可用 freeIdle 關掉。）

import { BubbleAnchors, BubbleQueue } from './bubbles';
import { AiProvider, providerSnapshot } from './providerSnapshot';
import { isRagWrite, ragActionOf } from './ragTools';
import {
  AgentDto, LimitHitDto, MonitorSnapshot, SessionDto, ToolCallDto, ToolResult, isActive,
} from './types';

export type ParticleKind = 'in' | 'out' | 'rejected';

export class FlowParticle {
  /** 沿曲線前進的進度 0–1。 */
  t = 0;
  constructor(readonly kind: ParticleKind, readonly pillKey: string, readonly color: string) {}
}

export interface Pt { x: number; y: number }

// ── 版面常數 ─────────────────────────────────────────────────────────────
export const Layout = {
  AgentX: -260, AgentW: 68, AgentH: 84,
  MaxRows: 14,
  // 列距 52（方塊 32 + 間距 20）；主 session 與各子代理的方塊群之間再多留 48，免得展開一塊就擠到鄰居
  RowH: 52, PillW: 176, PillH: 32, GroupGap: 48,
  ExpandedW: 320, ExpandedRows: 5, ExpandedRowH: 18, ExpandedPad: 12,
  ChipX: -650, ChipW: 140, ChipH: 28,
  Hub: { x: -380, y: 0 } as Pt,
  HubR: 44,
  Out: { x: 520, y: -30 } as Pt,
  OutR: 54,
  Rej: { x: 520, y: 118 } as Pt,
  /** 機器人的「每單位幾個像素」：機器人以約 30 單位高的單位座標繪製，乘上它（再乘各自的 scale）才是畫面大小。主機器人約 85 像素高。 */
  AlienUnit: 2.85,
  /** 在 Output 處理時可以站幾格（上下錯開）。 */
  OutSlots: 5,
  /** 同一個方塊上有好幾位機甲時，每往後一位往左退多少像素（乘上自己的大小）。 */
  SquadSpacing: 64,
};
/** 增援最多幾位（隊長之外）：一隊最多 1 + 4 隻同時出動。 */
export const MaxEscorts = 4;
/** 增援做完事之後留幾秒才淡出，與增援相對隊長的大小。 */
export const EscortLinger = 1.2;
export const EscortScale = 0.8;
/**
 * 判斷「同一批並行」時，後一個呼叫的開始時間與前面呼叫的結束時間最多相隔多少毫秒仍算同一批。
 * 實測同一回合的工具是一個接一個很快地執行，開始時間會錯開、區間不一定重疊（間隔約 0.2 秒內，時間又只記到 0.1 秒）；
 * 不同回合之間要等模型回應，通常超過 1 秒，所以取 500 毫秒。
 */
export const BurstSlackMs = 500;
/** 出拳時拳頭尖端離身體中心多遠（單位）：側面攻擊時近側手伸到最長的位置。 */
const AlienReachUnits = 18.1;

export const Palette = {
  Doc: '#5eead4',
  /** 本機 RAG 泡泡（粉紅）：與文件（青綠）、子代理（藍）、技能（紫）、任務（橘）區隔。 */
  Rag: '#f472b6',
  Ok: '#4cd98a', Fail: '#ff5a6a', Agent: '#7cc4ff', Skill: '#c792ff', Task: '#ffa657',
  Warn: '#e8b84a', Dim: '#5b6572', Text: '#e6e9ee', Sub: '#8b95a3',
};

/** 一種工具（MCP 依伺服器合併）的方塊。 */
export class FlowPill {
  // 版面（世界座標）：y 永遠是「標題列中心」，連線與粒子都接在這裡
  y = 0;
  targetY = 0;
  w = Layout.PillW;
  h = Layout.PillH;
  /** 淡出可見度 0–1（沒有 AI 時依序降到 0）。 */
  fade = 1;
  /** 新出現時的淡入 0–1。 */
  intro = 0;
  /** 「執行中」亮度，緩動（不是布林開關）。 */
  runLevel = 0;
  /** 連續執行了多久（秒）。 */
  runSeconds = 0;
  flash = 0;
  count = 0;
  ok = 0;
  fail = 0;
  running = 0;
  /** 最近幾筆呼叫，最新的在最前面。 */
  recent: ToolCallDto[] = [];
  expanded = false;
  justBorn = true;
  constructor(
    readonly key: string,
    readonly name: string,
    readonly color: string,
    readonly order: number,
    readonly bornAt: number,
    readonly agent: FlowAgent | null,
  ) {}
  /** 左緣固定：展開時只往右長，才不會壓向左邊的子代理節點與連線。 */
  get left(): number { return -Layout.PillW / 2; }
  get right(): number { return this.left + this.w; }
}

export class FlowAgent {
  y = 0;
  fade = 0;
  justBorn = true;
  constructor(readonly key: string, public info: AgentDto, readonly order: number) {}
}

/** 機器人的動作。stand＝待命；sit＝AI 已停下來、坐下休息；fly＝移動中；attack＝對著執行中的工具出拳；cheer／hurt＝工具成功／失敗後的反應；wave＝揮手。 */
export type AlienPose = 'stand' | 'sit' | 'fly' | 'attack' | 'cheer' | 'hurt' | 'wave';

/** 沒有工具在跑、AI 還在忙時，機器人「自己決定」做的事（隨機挑選，不代表任何事件）。none＝不在自由活動。 */
export type AlienIdle = 'none' | 'rest' | 'wave' | 'shadow' | 'patrol' | 'sitDown';
const IdleOrder: AlienIdle[] = ['none', 'rest', 'wave', 'shadow', 'patrol', 'sitDown'];

/**
 * 機器人＝「AI 現在在做什麼」的游標。每個 AI 主節點與每個子代理節點各一位，平常待在自己的節點旁，
 * 有真實的工具呼叫時飛到那個方塊的左邊；位置由彈簧計算（會有一點點過衝），畫面只負責畫。
 */
export class FlowAlien {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  /** 目前停靠／前往的方塊；null＝回到自己的節點旁。 */
  targetKey: string | null = null;
  /** 出現／消失的進度 0–1（子代理的機器人從主機器人分出去時由小變大）。 */
  intro = 0;
  alpha = 0;
  /** 飛行時依水平速度傾斜（弧度）；眼睛也朝這個方向偏。 */
  tilt = 0;
  /** 懸停時上下微幅漂浮（世界座標）。 */
  bob = 0;
  /** 左右飛行方向 −1…1（飛行時身體往這邊傾倒、領頭那隻手舉起）。 */
  lean = 0;
  /** 推進器強度 0–1：由真實的移動速度算出。 */
  thrust = 0;
  pose: AlienPose = 'stand';
  /** 進入目前動作後經過的秒數。 */
  poseTime = 0;
  wSit = 0; wFly = 0; wAttack = 0; wCheer = 0; wHurt = 0; wWave = 0;
  idleAct: AlienIdle = 'none';
  /** 到目前為止挑過幾次自由活動（每挑一次加一）。 */
  idlePicks = 0;
  idleLeft = 0;
  patrolX = 0;
  patrolY = 0;
  shadowX = 0;
  shadowY = 1;
  waveSide = 1;
  /** 攻擊時拳頭的伸縮 0–1（出拳—收回循環，約 0.7 秒一次）。 */
  punch = 0;
  /** 另一隻手的出拳 0–1：與 punch 差半個週期（punch + punchB 永遠＝1），一左一右輪流出拳。 */
  punchB = 0;
  /** 攻擊時面向哪一邊：1＝右、−1＝左（依瞄準方向決定，攻擊期間固定）。 */
  face = 1;
  /** 朝向目標方塊的單位向量（攻擊時出拳的方向）。 */
  aimX = 0;
  aimY = 1;
  /** 正在把結果送去哪裡處理：'ok'＝VERIFIED OUTPUT（成功）、'fail'＝REJECTED（失敗）、null＝沒有。 */
  deliverTarget: 'ok' | 'fail' | null = null;
  /** 在 Output 處理還要多久（秒）；到站才開始倒數。 */
  deliverLeft = 0;
  /** 上一趟處理完之後的冷卻（秒）：冷卻中不會再出發，避免一直來回飛。 */
  deliverCool = 0;
  alive = true;
  /** 增援的光暈顏色（取自它正在打的工具方塊）；null＝用預設色。 */
  tint: string | null = null;
  /** 負責的那一筆執行中呼叫（toolUseId）；null＝沒有。 */
  callId: string | null = null;
  work: FlowPill | null = null;
  /** 同一個方塊上有好幾位時的排位（0＝最靠近方塊）。 */
  rank = 0;
  /** 增援做完事之後還留多久（秒）才淡出。 */
  linger = 0;
  /**
   * ownerKey：'' ＝主 AI；子代理是它的 key；分流增援是「隊伍#編號」。
   * groupKey：所屬隊伍（''＝主 AI 超級機器人，否則是子代理的怪獸機甲）。escortIndex：0＝隊長，1 以上＝增援。
   */
  constructor(readonly ownerKey: string, readonly baseScale: number, readonly seed: number,
    readonly groupKey: string = ownerKey, readonly escortIndex = 0) {}
  get scale(): number { return this.baseScale * (0.4 + 0.6 * this.intro); }
  get isMonster(): boolean { return this.groupKey.length > 0; }
  /** 在 Output 處理時站哪一格（0–4，上下錯開）：每位依自己的相位分配，同時處理時盡量不疊在一起。 */
  get outSlot(): number { return (Math.floor(this.seed) + 2) % Layout.OutSlots; }
}

/** 機器人的停靠點：AI 主節點與子代理節點的右上角（正上方留給說明泡泡）；機器人很大，要離圓環與節點遠一點。 */
export function alienHome(agent: FlowAgent | null): Pt {
  return agent === null
    ? { x: Layout.Hub.x + 42, y: Layout.Hub.y - Layout.HubR - 52 }
    : { x: Layout.AgentX + 104, y: agent.y - 55 };
}

/**
 * 方塊左側、與標題列同高：機器人這麼大，放在方塊上方會壓到相鄰的方塊，放左邊則只會蓋到連線；
 * 離方塊左緣＝拳頭伸到最長的距離＋20，所以大機器人與小的子代理機器人（baseScale 0.7）都剛好打得到方塊左緣。
 */
export function alienSpot(p: FlowPill, baseScale = 1): Pt {
  return { x: p.left - AlienReachUnits * Layout.AlienUnit * baseScale - 20, y: p.y };
}

/**
 * 處理結果的停靠點：成功的送到 VERIFIED OUTPUT 圓環的左邊、失敗的送到 REJECTED 方塊的左邊，面向它出拳。
 * 同時有好幾位在處理時依 slot（0–4）上下錯開，不疊在一起。
 */
export function alienOutSpot(fail: boolean, baseScale: number, slot: number): Pt {
  const reach = AlienReachUnits * Layout.AlienUnit * baseScale + 20;
  const dy = (slot - 2) * (fail ? 12 : 26);
  return fail ? { x: Layout.Rej.x - 46 - reach, y: Layout.Rej.y + dy } : { x: Layout.Out.x - Layout.OutR - reach, y: Layout.Out.y + dy };
}
/** 處理時瞄準的點：圓環／方塊的左緣。 */
export function outAim(fail: boolean, slot: number): Pt {
  return fail ? { x: Layout.Rej.x - 46, y: Layout.Rej.y + (slot - 2) * 12 } : { x: Layout.Out.x - Layout.OutR * 0.92, y: Layout.Out.y + (slot - 2) * 26 };
}

export interface FlowStats { total: number; ok: number; fail: number; running: number }

export interface FlowOptions {
  provider?: AiProvider;
  modelKey?: string;
  /** 統計窗口（分鐘）。 */
  windowMinutes: number;
  /** 最後一次活動後先維持多久（秒）才開始淡出。 */
  lingerSeconds: number;
  /** 方塊之間，每隔多久換下一個開始淡出（秒）。 */
  stepSeconds: number;
  /** 每一組淡出所需時間（秒）。 */
  fadeSeconds: number;
  /** 只有這麼新的事件才會產生粒子（秒）。 */
  freshSeconds: number;
  /** 機器人沒事做時是否自己隨機活動。關掉就只依真實事件動作。 */
  freeIdle: boolean;
  /** 自由活動用的亂數來源（0–1）；測試可以給固定種子。 */
  random: () => number;
}

export const defaultOptions = (): FlowOptions => ({
  windowMinutes: 30, lingerSeconds: 15, stepSeconds: 4, fadeSeconds: 6, freshSeconds: 15, freeIdle: true, random: Math.random,
});

const FlashPeak = 0.6;
const FlashDecay = 0.9;
/** 機器人在方塊旁至少停留的時間（秒）：呼叫開始時、與結果回來之後。 */
export const AlienDwellStart = 1.2;
export const AlienDwellEnd = 0.8;
/** 到 Output 處理的時間（秒），與處理完之後的冷卻。 */
export const DeliverSeconds = 1.6;
export const DeliverCooldown = 3;
const MaxFlySpeed = 900; // 每秒最多飛幾像素：長距離（例如飛到 Output）也要看得出在飛，不是瞬移
const SpringK = 38;
const SpringC = 9; // 阻尼比約 0.73：到站時有一點點過衝，像有重量

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export class FlowModel {
  private readonly o: FlowOptions;
  private pills = new Map<string, FlowPill>();
  private agentMap = new Map<string, FlowAgent>();
  private calls = new Map<string, { pill: string; result: string }>();
  private particlesList: FlowParticle[] = [];
  private aliensMap = new Map<string, FlowAlien>();
  private visits = new Map<string, { pill: string; left: number; outcome: string }>();
  /** 擁有者 → 還沒送去 Output 處理的結果（成功／失敗；只要有一筆失敗就算失敗）。 */
  private pendingOut = new Map<string, string>();
  private alienLevelValue = 0;
  private alienSeq = 0;
  /** 上一次同步時同時執行中的工具數（分流泡泡用）。 */
  private parallel = 0;
  /**
   * 並行但「掃描到時已經完成」的快工具：仍要出動一下機甲。key＝toolUseId；
   * owner＝所屬隊伍（''＝主 AI）、time＝呼叫開始時間（毫秒）、left＝還要出動幾秒。
   */
  private ghosts = new Map<string, { owner: string; time: number; left: number }>();
  private ordered: FlowPill[] = [];
  private sessionsList: SessionDto[] = [];
  private orderSeq = 0;
  private first = true;
  private clock = 0;
  private lastActivity: number | null = null;
  private limitSeen: number | null = null;

  /** 使用者偏好「減少動態」時不產生粒子、泡泡與機器人。 */
  reduceMotion = false;
  readonly bubbles = new BubbleQueue();

  agents: FlowAgent[] = [];
  log: ToolCallDto[] = [];
  stats: FlowStats = { total: 0, ok: 0, fail: 0, running: 0 };
  activeSessions = 0;
  modelText = '';
  /** 有 AI 在執行的證據：有 session 處於活躍狀態，或有工具呼叫尚未回傳。 */
  busy = false;
  outFlash = 0;
  rejFlash = 0;
  /** 整排方塊目前的總高度（決定縮放）。 */
  columnHeight = 0;
  /** AI（左邊的 session 與主節點）的可見度 0–1。 */
  source = 0;
  /** output（輸出圓環、REJECTED、摘要卡、日誌、頂部數字）的可見度 0–1。 */
  sink = 0;
  isLive = true;
  liveText = '● LIVE';

  constructor(options?: Partial<FlowOptions>) {
    this.o = { ...defaultOptions(), ...options };
  }

  get windowMinutes(): number { return this.o.windowMinutes; }
  get providerLabel(): string { return this.o.provider ?? 'AI'; }
  get modelKey(): string | undefined { return this.o.modelKey; }
  bindModel(model: string): void {
    if (this.o.modelKey !== undefined && this.o.modelKey !== model) throw new Error('A brain cannot switch models');
    this.o.modelKey = model;
  }
  outputOffsetY = 0;
  outputSlotOffset = 0;
  get freeIdle(): boolean { return this.o.freeIdle; }
  set freeIdle(v: boolean) { this.o.freeIdle = v; }
  get pillList(): readonly FlowPill[] { return this.ordered; }
  get particles(): readonly FlowParticle[] { return this.particlesList; }
  get sessions(): readonly SessionDto[] { return this.sessionsList; }
  get aliens(): FlowAlien[] { return [...this.aliensMap.values()]; }
  /** 機器人整體可見度（AI 在執行才出現，閒置時淡出）。 */
  get alienLevel(): number { return this.alienLevelValue; }

  /**
   * 畫面是否還需要連續重畫：有 AI 在忙（或還在 LIVE 緩衝期）、還沒淡完、還有粒子或泡泡、機器人還沒消失。
   * 全部淡掉之後畫面是靜止的（只剩「目前沒有 AI 在執行」），不需要每秒畫幾十次。
   */
  get animating(): boolean {
    return this.busy || this.isLive || this.source > 0.002 || this.sink > 0.002 || this.alienLevelValue > 0.002
      || this.particlesList.length > 0 || this.bubbles.items.length > 0 || this.ordered.some(p => p.fade > 0.01);
  }

  /** 距離「最後一次真實活動」多久（秒）。有 AI 在執行視為 0；從未有過活動為無限大。 */
  idleAge(now: number): number {
    return this.busy ? 0 : this.lastActivity !== null ? Math.max(0, (now - this.lastActivity) / 1000) : Infinity;
  }

  // ── 資料同步 ───────────────────────────────────────────────────────────
  sync(d: MonitorSnapshot): void {
    if (this.o.provider) d = providerSnapshot(d, this.o.provider, this.o.modelKey);
    const now = d.at;
    const windowMs = this.o.windowMinutes * 60_000;
    const inWin = d.recentToolCalls.filter(c => c.result === ToolResult.Running || now - c.time < windowMs);
    const live = new Set<string>([
      ...inWin.map(c => c.sessionId),
      ...d.agents.filter(a => isActive(a.status)).map(a => a.sessionId),
    ]);

    this.busy = d.sessions.some(s => isActive(s.status)) || d.agents.some(s => isActive(s.status))
      || inWin.some(c => c.result === ToolResult.Running);
    const stamps = [
      ...d.sessions.map(s => s.lastActivity), ...d.agents.map(s => s.lastActivity), ...inWin.map(c => c.time),
    ].filter(t => t > 0);
    this.lastActivity = stamps.length > 0 ? Math.max(...stamps) : null;
    this.sessionsList = d.sessions.filter(s => isActive(s.status) || live.has(s.sessionId)).slice(0, 4);
    const lead = d.sessions.find(s => isActive(s.status)) ?? d.sessions[0];
    this.modelText = lead ? formatModel(lead.model) : this.o.modelKey ? formatModel(this.o.modelKey) : '';

    const visibleAgents = d.agents.filter(a => isActive(a.status)
      || inWin.some(c => c.sessionId === a.sessionId && c.agentId === a.agentId));
    const agentKeys = new Set(visibleAgents.map(a => agentKey(a.sessionId, a.agentId)));
    for (const key of [...this.agentMap.keys()]) if (!agentKeys.has(key)) this.agentMap.delete(key);
    for (const a of visibleAgents) {
      const key = agentKey(a.sessionId, a.agentId);
      const node = this.agentMap.get(key);
      if (node) node.info = a;
      else {
        this.agentMap.set(key, new FlowAgent(key, a, this.orderSeq++));
        if (!this.first && !this.reduceMotion) // 開啟當下既有的子代理不彈；執行中才新出現的才彈
          this.bubbles.add('agent', key, agentText(a), Palette.Task);
      }
    }
    this.agents = [...this.agentMap.values()].sort((a, b) => a.order - b.order);

    for (const p of this.pills.values()) {
      p.count = p.ok = p.fail = p.running = 0;
      p.recent = [];
    }
    let total = 0, ok = 0, fail = 0, running = 0;
    const ids = new Set<string>();
    const newlyDone: { c: ToolCallDto; owner: string }[] = []; // 這一輪才第一次看到、而且已經完成的快工具

    for (const c of [...inWin].reverse()) { // 舊 → 新
      ids.add(c.toolUseId);
      let { key, name } = pillInfo(c.tool);
      const owner = this.agentMap.get(agentKey(c.sessionId, c.agentId)) ?? null;
      if (owner) key = owner.key + '/' + key;
      total++;
      if (c.result === ToolResult.Ok) ok++;
      else if (c.result === ToolResult.Failed) fail++;
      else if (c.result === ToolResult.Running) running++;
      let p = this.pills.get(key) ?? null;
      if (!p) p = this.makePill(key, name, owner);
      if (!p) continue;
      p.count++;
      p.recent.unshift(c); // 舊 → 新迴圈，所以插到最前面讓最新的在最前
      if (p.recent.length > Layout.ExpandedRows) p.recent.pop();
      const done = c.result !== ToolResult.Running;
      if (c.result === ToolResult.Ok) p.ok++;
      else if (c.result === ToolResult.Failed) p.fail++;
      else if (c.result === ToolResult.Running) p.running++;

      if (c.result === ToolResult.Interrupted) {
        this.calls.set(c.toolUseId, { pill: p.key, result: c.result });
        continue;
      }

      const rec = this.calls.get(c.toolUseId);
      if (!rec) {
        this.calls.set(c.toolUseId, { pill: p.key, result: c.result });
        // 只有「剛發生」的事件才產生粒子與泡泡；從窗口外轉回顯示的舊呼叫不演動畫
        const fresh = (now - c.time) / 1000 < this.o.freshSeconds;
        if (!this.first && !this.reduceMotion && fresh) {
          this.visit(owner, p, AlienDwellStart, c.result); // 機器人飛過去（最新一筆優先）
          if (done) { this.pend(owner, c.result); newlyDone.push({ c, owner: owner?.key ?? '' }); }
          this.particlesList.push(new FlowParticle('in', p.key, p.color)); // 主節點 → 工具
          if (done) this.emitOut(p, c.result);
          const doc = docName(c);
          const rag = ragText(c);
          if (c.result === ToolResult.Failed) this.bubbles.add('failure', p.key, failureText(c, p.name), Palette.Fail);
          // 本機 RAG 的工具：同樣不論是否已結束都要顯示（查詢通常一下就完成，等「執行中」會錯過）
          else if (rag !== null) this.bubbles.add('rag', p.key, rag, Palette.Rag);
          // .md 文件：不論這次呼叫是否已經結束都要讓人看到是哪一個檔案（讀文件通常一下子就完成，等「執行中」會錯過）
          else if (doc !== null) this.bubbles.add('doc', p.key, docText(c, doc), Palette.Doc);
          else if (!done) this.bubbles.add('toolStart', p.key, toolStartText(c, p.name), p.color, p.name);
        }
      } else if (rec.result === ToolResult.Running && done) {
        this.calls.set(c.toolUseId, { pill: rec.pill, result: c.result });
        if (!this.reduceMotion) {
          const holder = [...this.aliensMap.values()].find(u => u.escortIndex > 0 && u.callId === c.toolUseId); // 增援負責的呼叫：結果由它自己送去 Output
          if (holder) this.pendKey(holder.ownerKey, c.result);
          else { this.visit(owner, p, AlienDwellEnd, c.result); this.pend(owner, c.result); } // 結果回來後再停一下才飛回去
          this.emitOut(p, c.result); // 工具 → 輸出／失敗
          if (c.result === ToolResult.Failed) this.bubbles.add('failure', p.key, failureText(c, p.name), Palette.Fail);
        }
      }
    }
    for (const [k, v] of [...this.pills]) if (v.count === 0) this.pills.delete(k); // 窗外的種類移除
    for (const id of [...this.calls.keys()]) if (!ids.has(id)) this.calls.delete(id);
    this.ordered = [...this.pills.values()].sort((a, b) => ((a.agent?.order ?? -1) - (b.agent?.order ?? -1)) || (a.order - b.order));
    const announced = this.registerBursts(newlyDone, inWin);

    this.stats = { total, ok, fail, running };
    this.log = inWin.slice(0, 3);
    this.activeSessions = new Set([
      ...d.sessions.filter(s => isActive(s.status)).map(s => s.sessionId),
      ...d.agents.filter(a => isActive(a.status)).map(a => a.sessionId),
    ]).size;

    const age = this.idleAge(now);
    const wasLive = this.isLive;
    this.isLive = age <= this.o.lingerSeconds;
    this.liveText = this.isLive ? '● LIVE' : !Number.isFinite(age) ? '● IDLE' : `● IDLE · 最後活動 ${ago(age)}`;

    // 狀態轉換的泡泡：只在「狀態真的改變」的那一刻彈一次；開啟程式當下的既有狀態不彈
    if (!this.first && !this.reduceMotion) {
      if (!wasLive && this.isLive)
        this.bubbles.add('status', BubbleAnchors.Hub, 'AI 開始執行' + (this.modelText.length > 0 ? ' · ' + this.modelText : ''), Palette.Agent);
      else if (wasLive && !this.isLive)
        this.bubbles.add('status', BubbleAnchors.Hub, `已閒置 ${this.o.lingerSeconds} 秒，開始淡出`, Palette.Warn);
    }

    // 分流：同時執行的工具從不到 2 個變成 2 個以上的那一刻彈一次（隊伍同時出動）
    if (!this.first && !this.reduceMotion && this.parallel < 2 && running >= 2 && !announced)
      this.bubbles.add('status', BubbleAnchors.Hub, `分流 ×${running} · 機甲出動`, Palette.Agent);
    this.parallel = running;

    // 額度上限：逐字稿裡出現「比先前看過的更新」的被拒絕事件才彈
    const hit = d.lastLimitHit;
    if (hit) {
      if (!this.first && !this.reduceMotion && (this.limitSeen === null || hit.hitAt > this.limitSeen))
        this.bubbles.add('limit', BubbleAnchors.Rejected, limitText(hit), Palette.Fail);
      if (this.limitSeen === null || hit.hitAt > this.limitSeen) this.limitSeen = hit.hitAt;
    }
    this.first = false;
  }

  private makePill(key: string, name: string, owner: FlowAgent | null): FlowPill | null {
    let n = 0;
    for (const p of this.pills.values()) if (p.agent === owner) n++;
    if (n >= Layout.MaxRows) return null;
    const p = new FlowPill(key, name, colorOf(owner === null ? key : key.slice(owner.key.length + 1)), this.orderSeq++, this.clock, owner);
    this.pills.set(key, p);
    return p;
  }

  private emitOut(p: FlowPill, result: string): void {
    this.particlesList.push(new FlowParticle(result === ToolResult.Failed ? 'rejected' : 'out', p.key,
      result === ToolResult.Failed ? Palette.Fail : Palette.Ok));
  }

  private visit(owner: FlowAgent | null, p: FlowPill, seconds: number, outcome: string): void {
    this.visits.set(owner?.key ?? '', { pill: p.key, left: seconds, outcome });
  }

  /** 記下一筆「還沒送去 Output」的結果；快速連續完成的合併成一趟，只要有一筆失敗就整趟算失敗。 */
  private pend(owner: FlowAgent | null, result: string): void { this.pendKey(owner?.key ?? '', result); }

  private pendKey(key: string, result: string): void {
    if (result === ToolResult.Running) return;
    const failed = result === ToolResult.Failed || this.pendingOut.get(key) === ToolResult.Failed;
    this.pendingOut.set(key, failed ? ToolResult.Failed : ToolResult.Ok);
  }

  // ── 機器人 ─────────────────────────────────────────────────────────────
  private tickAliens(dt: number): void {
    // 名單：主機器人一位；每個子代理節點一位（從主機器人目前的位置分出去）
    if (!this.aliensMap.has('')) {
      const h = alienHome(null);
      const a = new FlowAlien('', 1, this.alienSeq++);
      a.x = h.x; a.y = h.y; a.intro = 1;
      this.aliensMap.set('', a);
    }
    for (const a of this.agents) {
      if (!this.aliensMap.has(a.key)) {
        const main = this.aliensMap.get('')!;
        const s = new FlowAlien(a.key, 0.7, this.alienSeq++);
        s.x = main.x; s.y = main.y;
        this.aliensMap.set(a.key, s);
      }
    }
    for (const u of this.aliensMap.values()) if (u.escortIndex === 0) u.alive = u.ownerKey.length === 0 || this.agentMap.has(u.ownerKey);
    this.assignSquads(dt);

    for (const [k, v] of [...this.visits]) {
      if (v.left - dt <= 0) this.visits.delete(k);
      else this.visits.set(k, { ...v, left: v.left - dt });
    }

    // 整體可見度：AI 在執行（或還在 LIVE 的緩衝期內）才出現；閒置就淡出。減少動態時完全不出現。
    const want = !this.reduceMotion && (this.busy || this.isLive) ? 1 : 0;
    this.alienLevelValue += (want - this.alienLevelValue) * Math.min(1, dt * 1.5);

    for (const u of [...this.aliensMap.values()]) {
      const agent = this.agentMap.get(u.groupKey) ?? null;
      // 目標：自己負責的那一筆執行中呼叫所在的方塊（assignSquads 分配好了）；隊長沒有的話，才看剛發生的呼叫；都沒有就回自己的節點旁
      let target: FlowPill | null = u.work;
      let outcome: string = ToolResult.Running;
      if (target === null && u.escortIndex === 0) {
        const v = this.visits.get(u.ownerKey);
        const vp = v ? this.pills.get(v.pill) : undefined;
        if (v && vp) { target = vp; outcome = v.outcome; }
      }
      u.targetKey = target?.key ?? null;
      if (u.escortIndex > 0 && target !== null) u.tint = target.color;

      // 送結果去 Output 處理：手上沒有工具要打、而且有結果等著送（成功→VERIFIED OUTPUT、失敗→REJECTED）就出發；
      // 有新的工具要打就中斷（結果還留著，之後再送）。處理完之後冷卻一陣子，避免連續的小工具讓機甲一直來回飛。
      if (u.deliverCool > 0) u.deliverCool -= dt;
      const pend = this.pendingOut.get(u.ownerKey);
      if (target !== null) u.deliverTarget = null;
      else if (u.deliverTarget === null && u.deliverCool <= 0 && u.alive && !this.reduceMotion && pend !== undefined) {
        u.deliverTarget = pend === ToolResult.Failed ? 'fail' : 'ok';
        u.deliverLeft = DeliverSeconds;
      }
      const slot = (u.outSlot + this.outputSlotOffset) % Layout.OutSlots;

      // 自由活動：只在「AI 還在忙、沒有工具在跑」時才自己挑事情做；真實事件（有工具、AI 停下來）一來就中斷
      if (this.o.freeIdle && u.escortIndex === 0 && target === null && u.deliverTarget === null && this.busy && u.alive && !this.reduceMotion) {
        u.idleLeft -= dt;
        if (u.idleLeft <= 0) this.pickIdle(u);
      } else if (u.idleAct !== 'none') {
        u.idleAct = 'none'; u.idleLeft = 0; u.patrolX = u.patrolY = 0;
      }

      let goal: Pt;
      if (target !== null) { const s = alienSpot(target, u.baseScale); goal = { x: s.x - u.rank * Layout.SquadSpacing * u.baseScale, y: s.y }; } // 同一個方塊上的隊員往左排開
      else if (u.deliverTarget !== null) { goal = alienOutSpot(u.deliverTarget === 'fail', u.baseScale, slot); goal = { x: goal.x, y: goal.y + this.outputOffsetY }; }
      else if (u.alive || agent !== null) { const h = alienHome(agent); goal = { x: h.x + u.patrolX + u.escortIndex * 52, y: h.y + u.patrolY }; }
      else goal = { x: u.x, y: u.y };

      // 彈簧：加速度 = k × 距離 − c × 速度
      u.vx += (SpringK * (goal.x - u.x) - SpringC * u.vx) * dt;
      u.vy += (SpringK * (goal.y - u.y) - SpringC * u.vy) * dt;
      const sp = Math.sqrt(u.vx * u.vx + u.vy * u.vy); // 速度上限
      if (sp > MaxFlySpeed) { u.vx *= MaxFlySpeed / sp; u.vy *= MaxFlySpeed / sp; }
      u.x += u.vx * dt; u.y += u.vy * dt;

      const speed = Math.sqrt(u.vx * u.vx + u.vy * u.vy);
      u.tilt = clamp(u.vx / 500, -0.3, 0.3);
      u.thrust = clamp(speed / 200, 0, 1);
      u.lean = clamp(u.vx / 150, -1, 1);

      // 動作：全部來自真實狀態——有執行中的工具＝出拳；結果回來＝成功歡呼／失敗受創；在移動＝飛行；
      // 停在節點旁：AI 還在忙＝站著待命，AI 已經停下來（閒置緩衝期）＝坐下。
      const docked = target !== null && Math.hypot(goal.x - u.x, goal.y - u.y) < 14 && speed < 60;
      const deliverDocked = u.deliverTarget !== null && Math.hypot(goal.x - u.x, goal.y - u.y) < 14 && speed < 60;
      let pose: AlienPose;
      if (docked) pose = target!.running > 0 ? 'attack' : outcome === ToolResult.Failed ? 'hurt' : 'cheer';
      else if (deliverDocked) pose = 'attack'; // 到了 Output：面向它出拳處理
      else if (speed > 45) pose = 'fly';
      else if (target === null && !this.busy) pose = 'sit'; // AI 真的停下來了
      else if (u.idleAct === 'wave') pose = 'wave'; // 以下三種是隨機的自由活動
      else if (u.idleAct === 'shadow') pose = 'attack';
      else if (u.idleAct === 'sitDown') pose = 'sit';
      else pose = 'stand';
      if (pose !== u.pose) { u.pose = pose; u.poseTime = 0; } else u.poseTime += dt;
      const ease = (cur: number, on: boolean): number => cur + ((on ? 1 : 0) - cur) * Math.min(1, dt * 8);
      u.wSit = ease(u.wSit, pose === 'sit');
      u.wFly = ease(u.wFly, pose === 'fly');
      u.wAttack = ease(u.wAttack, pose === 'attack');
      u.wCheer = ease(u.wCheer, pose === 'cheer');
      u.wHurt = ease(u.wHurt, pose === 'hurt');
      u.wWave = ease(u.wWave, pose === 'wave');
      u.punch = pose === 'attack' ? 0.5 - 0.5 * Math.cos(u.poseTime * 2 * Math.PI / 0.7) : 0;
      u.punchB = pose === 'attack' ? 1 - u.punch : 0;
      if (target !== null) { // 瞄準方塊左緣的標題列
        const ax = target.left - u.x, ay = target.y - u.y;
        const len = Math.sqrt(ax * ax + ay * ay);
        if (len > 1) { u.aimX = ax / len; u.aimY = ay / len; }
      } else if (u.deliverTarget !== null) { // 處理結果：瞄準圓環／REJECTED 的左緣
        const aim = outAim(u.deliverTarget === 'fail', slot);
        aim.y += this.outputOffsetY;
        const ax = aim.x - u.x, ay = aim.y - u.y;
        const len = Math.sqrt(ax * ax + ay * ay);
        if (len > 1) { u.aimX = ax / len; u.aimY = ay / len; }
      } else if (u.idleAct === 'shadow') { u.aimX = u.shadowX; u.aimY = u.shadowY; } // 對空出拳：朝隨機選好的方向
      if (pose === 'attack') u.face = u.aimX >= 0 ? 1 : -1; // 攻擊時側身面向目標

      if (deliverDocked) { // 在 Output 處理中：倒數；Output 隨著出拳閃光；時間到就回去
        const flash = FlashPeak * 0.8 * Math.max(u.punch, u.punchB);
        if (u.deliverTarget === 'fail') this.rejFlash = Math.max(this.rejFlash, flash); else this.outFlash = Math.max(this.outFlash, flash);
        u.deliverLeft -= dt;
        if (u.deliverLeft <= 0) {
          // 只清掉「這一趟送的那種」結果；處理期間又來了失敗就留著，下一趟再送
          const p2 = this.pendingOut.get(u.ownerKey);
          if (p2 !== undefined && (p2 === ToolResult.Failed) === (u.deliverTarget === 'fail')) this.pendingOut.delete(u.ownerKey);
          u.deliverTarget = null;
          u.deliverCool = DeliverCooldown;
        }
      }

      u.bob = Math.sin(this.clock * 2.4 + u.seed * 1.7) * 2.2 * (1 - 0.7 * u.wSit)
        - u.wCheer * Math.abs(Math.sin(u.poseTime * 9)) * 4; // 坐下時幾乎不晃；歡呼時小跳
      u.intro = u.alive ? Math.min(1, u.intro + dt * 2.5) : Math.max(0, u.intro - dt * 3);
      u.alpha = this.alienLevelValue * this.source * u.intro;
      if (!u.alive && u.intro <= 0.01) { this.aliensMap.delete(u.ownerKey); if (u.escortIndex > 0) this.pendingOut.delete(u.ownerKey); }
    }
  }

  /**
   * 並行的快工具（例如一次 Read 三個檔案）：掃描到的時候通常已經完成，只看「執行中」會派不出機甲。
   * 這裡把「這一輪才第一次看到、已完成」的呼叫，和同一隊的其他呼叫依時間排序：區間重疊、或前一個結束後
   * BurstSlackMs 之內就開始下一個，算同一批；同一批有 2 個以上就登記成「出動中」，assignSquads 會替每一筆派一隻機甲短暫出動。
   * 隔了一段時間才開始的下一個（例如要等模型回應的下一回合）不算。
   * 回傳是否已經彈出「分流」泡泡（呼叫端就不再為同一批彈第二顆）。
   */
  private registerBursts(done: { c: ToolCallDto; owner: string }[], all: ToolCallDto[]): boolean {
    if (done.length === 0 || this.reduceMotion) return false;
    let announced = false;
    const ownerOf = (c: ToolCallDto): string => this.agentMap.get(agentKey(c.sessionId, c.agentId))?.key ?? '';
    for (const owner of new Set(done.map(d => d.owner))) {
      const fresh = new Set(done.filter(d => d.owner === owner).map(d => d.c.toolUseId));
      const pool = all.filter(c => ownerOf(c) === owner && (fresh.has(c.toolUseId) || c.result === ToolResult.Running))
        .sort((a, b) => a.time - b.time);
      let cluster: ToolCallDto[] = [];
      let end = -Infinity;
      const flush = (): void => {
        const quick = cluster.filter(c => fresh.has(c.toolUseId));
        if (cluster.length >= 2 && quick.length > 0) {
          for (const c of quick) if (!this.ghosts.has(c.toolUseId)) this.ghosts.set(c.toolUseId, { owner, time: c.time, left: AlienDwellStart });
          this.bubbles.add('status', BubbleAnchors.Hub, `分流 ×${cluster.length} · 機甲出動`, Palette.Agent);
          announced = true;
        }
        cluster = []; end = -Infinity;
      };
      for (const c of pool) {
        if (cluster.length > 0 && c.time > end + BurstSlackMs) flush();
        cluster.push(c);
        end = Math.max(end, c.result === ToolResult.Running ? Infinity : c.time + c.durationSeconds * 1000);
      }
      flush();
    }
    return announced;
  }

  /**
   * 分流：每個隊（主 AI／各子代理）每一筆「執行中」的呼叫都分配一隻機甲——隊長優先、不夠再派增援（有上限）。
   * 分配是穩定的：已經在打某筆呼叫的繼續打它，新來的呼叫才分給空手的，所以機甲不會互相換位。
   */
  private assignSquads(dt: number): void {
    for (const [id, gh] of [...this.ghosts]) { gh.left -= dt; if (gh.left <= 0) this.ghosts.delete(id); } // 並行快工具的出動時間到了
    for (const e of this.aliensMap.values()) if (e.escortIndex > 0 && !this.aliensMap.has(e.groupKey)) e.alive = false; // 隊長不在了：增援跟著收隊

    for (const leader of [...this.aliensMap.values()].filter(u => u.escortIndex === 0)) {
      const g = leader.ownerKey;
      const members = [...this.aliensMap.values()].filter(u => u.groupKey === g).sort((a, b) => a.escortIndex - b.escortIndex);
      const real: { toolUseId: string; time: number }[] = this.ordered.filter(p => (p.agent?.key ?? '') === g)
        .flatMap(p => p.recent.filter(c => c.result === ToolResult.Running));
      const quick = [...this.ghosts].filter(([, gh]) => gh.owner === g).map(([id, gh]) => ({ toolUseId: id, time: gh.time }));
      const running = [...real, ...quick].sort((a, b) => b.time - a.time);
      const ids = new Set(running.map(c => c.toolUseId));
      for (const m of members) if (m.callId !== null && !ids.has(m.callId)) m.callId = null;
      const held = new Set(members.filter(m => m.callId !== null).map(m => m.callId));

      for (const c of running) {
        if (held.has(c.toolUseId)) continue;
        let free = members.find(m => m.callId === null && m.alive) ?? null;
        if (free === null && !this.reduceMotion && leader.alive && members.length < 1 + MaxEscorts) {
          let idx = 1;
          while (members.some(m => m.escortIndex === idx)) idx++;
          free = new FlowAlien(g + '#' + idx, leader.baseScale * EscortScale, this.alienSeq++, g, idx);
          free.x = leader.x; free.y = leader.y; free.linger = EscortLinger;
          this.aliensMap.set(free.ownerKey, free);
          members.push(free);
        }
        if (free === null) break; // 上限到了：其餘的呼叫沒有專屬機甲
        free.callId = c.toolUseId;
      }

      for (const m of members) {
        const rec = m.callId !== null ? this.calls.get(m.callId) : undefined;
        m.work = rec ? this.pills.get(rec.pill) ?? null : null;
      }
      const ranks = new Map<string, number>();
      for (const m of members) {
        if (m.work === null) continue;
        const r = ranks.get(m.work.key) ?? 0; // members 已依 escortIndex 排好
        m.rank = r;
        ranks.set(m.work.key, r + 1);
      }

      for (const e of members) { // 增援：有事做（打工具、送結果）就留著，做完再留一下就淡出
        if (e.escortIndex === 0) continue;
        const busy = e.work !== null || e.deliverTarget !== null || this.pendingOut.has(e.ownerKey);
        if (busy) e.linger = EscortLinger; else e.linger -= dt;
        e.alive = leader.alive && e.linger > 0;
      }
    }
  }

  /** 隨機挑下一件自由活動與持續時間。權重：待命 3、揮手 1、對空出拳 1.5、巡邏 1.5、坐下 2；不會連續兩次一樣。 */
  private pickIdle(u: FlowAlien): void {
    const r = this.o.random;
    const roll = r() * 9;
    let act: AlienIdle = roll < 3 ? 'rest' : roll < 4 ? 'wave' : roll < 5.5 ? 'shadow' : roll < 7 ? 'patrol' : 'sitDown';
    if (act === u.idleAct) act = act === 'sitDown' ? 'rest' : IdleOrder[IdleOrder.indexOf(act) + 1]; // 跟上一件一樣就改成下一件
    const secs = act === 'rest' ? 2 + 3 * r()
      : act === 'wave' ? 1.6 + 0.8 * r()
      : act === 'shadow' ? 2 + 1.5 * r()
      : act === 'patrol' ? 3 + r()
      : 3 + 3 * r();
    this.setIdle(u, act, secs);
  }

  private setIdle(u: FlowAlien, act: AlienIdle, seconds: number): void {
    const r = this.o.random;
    u.idleAct = act; u.idleLeft = seconds; u.idlePicks++;
    u.patrolX = u.patrolY = 0;
    if (act === 'patrol') { // 繞著待命點小範圍亂飛（最遠約 45 像素）
      const angle = r() * 2 * Math.PI, radius = 18 + 27 * r();
      u.patrolX = Math.cos(angle) * radius; u.patrolY = Math.sin(angle) * radius * 0.6;
    } else if (act === 'shadow') { // 雙拳朝左或右下方（離垂直 10°–35°，不會讓一隻手橫過身體）出拳
      const side = r() < 0.5 ? -1 : 1, a = (10 + 25 * r()) * Math.PI / 180;
      u.shadowX = side * Math.sin(a); u.shadowY = Math.cos(a);
    } else if (act === 'wave') u.waveSide = r() < 0.5 ? -1 : 1;
  }

  /** 測試用：強制某個擁有者的機器人立刻做某件自由活動。 */
  forceIdle(ownerKey: string, act: AlienIdle, seconds: number): void {
    this.setIdle(this.aliensMap.get(ownerKey)!, act, seconds);
  }

  // ── 時間軸（每一幀）─────────────────────────────────────────────────────
  tick(dtRaw: number, now: number): void {
    const dt = clamp(dtRaw, 0, 0.05);
    this.clock += dt;
    this.bubbles.tick(dt, k => BubbleAnchors.isFixed(k) || this.pills.has(k) || this.agentMap.has(k));
    const list = this.ordered;

    // 方塊依首次出現順序排成一排並置中；各自高度不同（展開的較高），位置與尺寸都平滑移動
    const gap = Layout.RowH - Layout.PillH;
    const ease = Math.min(1, dt * 8);
    for (const p of list) {
      const wT = p.expanded ? Layout.ExpandedW : Layout.PillW;
      const hT = p.expanded ? Layout.PillH + Layout.ExpandedPad + Math.max(1, p.recent.length) * Layout.ExpandedRowH : Layout.PillH;
      if (p.justBorn) { p.w = wT; p.h = hT; } // 剛出現：直接就位，不從 0 長出來
      p.w += (wT - p.w) * ease; p.h += (hT - p.h) * ease;
    }
    const groups: { agent: FlowAgent | null; pills: FlowPill[] }[] = [];
    const mainPills = list.filter(p => p.agent === null);
    if (mainPills.length > 0) groups.push({ agent: null, pills: mainPills });
    for (const a of this.agents) groups.push({ agent: a, pills: list.filter(p => p.agent === a) });
    const sumH = (pills: FlowPill[]): number => pills.reduce((s, p) => s + p.h, 0);
    const heightOf = (g: { agent: FlowAgent | null; pills: FlowPill[] }): number =>
      Math.max(g.agent === null ? 0 : 72, sumH(g.pills) + Math.max(0, g.pills.length - 1) * gap);
    const total = groups.reduce((s, g) => s + heightOf(g), 0) + Math.max(0, groups.length - 1) * Layout.GroupGap;
    this.columnHeight = total;
    let top = -total / 2;
    for (const group of groups) {
      const height = heightOf(group);
      if (group.agent) {
        const target = top + height / 2;
        group.agent.y = group.agent.justBorn ? target : group.agent.y + (target - group.agent.y) * Math.min(1, dt * 6);
        group.agent.justBorn = false;
      }
      let rowTop = top + (height - sumH(group.pills) - Math.max(0, group.pills.length - 1) * gap) / 2;
      for (const p of group.pills) {
        p.targetY = rowTop + Layout.PillH / 2;
        if (p.justBorn) p.y = p.targetY;
        p.y += (p.targetY - p.y) * Math.min(1, dt * 6);
        rowTop += p.h + gap;
        if (p.flash > 0) p.flash = Math.max(0, p.flash - dt * FlashDecay);
        // 「執行中」的亮度用緩動（慢升慢降），不要直接開關：AI 連續執行很多很快的工具時，布林值會讓發光一開一關
        p.runLevel += ((p.running > 0 ? 1 : 0) - p.runLevel) * Math.min(1, dt * 2);
        p.runSeconds = p.running > 0 ? p.runSeconds + dt : 0;
        p.intro = clamp((this.clock - p.bornAt) / 0.35, 0, 1);
        p.justBorn = false;
      }
      top += height + Layout.GroupGap;
    }

    // ── 依序淡出（技能／工具方塊 → AI → output）─────────────────────────
    // 有 AI 在執行 → 全部 1。否則每一組在自己的起點之後，用 fadeSeconds 線性降到 0；變亮（AI 回來）用緩動，變暗照時間走。
    //   ① 第 i 個方塊（由上而下，i 從 0 起）：起點 = linger + i×step
    //   ② AI（左邊的 session 與主節點）：起點 = 最後一個方塊淡完之後（沒有方塊時 = linger）
    //   ③ output：起點 = AI 淡完之後
    const age = this.idleAge(now);
    const fadeTo = (cur: number, target: number): number => (target >= cur ? cur + (target - cur) * Math.min(1, dt * 6) : target);
    const level = (start: number): number => (age <= start ? 1 : clamp(1 - (age - start) / this.o.fadeSeconds, 0, 1));
    const aiStart = this.o.lingerSeconds + (list.length > 0 ? (list.length - 1) * this.o.stepSeconds + this.o.fadeSeconds : 0);
    for (let i = 0; i < list.length; i++) list[i].fade = fadeTo(list[i].fade, level(this.o.lingerSeconds + i * this.o.stepSeconds));
    this.source = fadeTo(this.source, level(aiStart));
    this.sink = fadeTo(this.sink, level(aiStart + this.o.fadeSeconds));
    for (const a of this.agents) a.fade = this.source;
    this.tickAliens(dt);

    for (const pt of this.particlesList) pt.t += dt * 0.95;
    for (let i = this.particlesList.length - 1; i >= 0; i--) {
      const pt = this.particlesList[i];
      if (pt.t < 1) continue;
      // 事件抵達的閃光：強度與衰減都放柔
      const p = this.pills.get(pt.pillKey);
      if (pt.kind === 'in' && p) p.flash = FlashPeak;
      else if (pt.kind === 'out') this.outFlash = FlashPeak;
      else if (pt.kind === 'rejected') this.rejFlash = FlashPeak;
      this.particlesList.splice(i, 1);
    }
    this.outFlash = Math.max(0, this.outFlash - dt * FlashDecay);
    this.rejFlash = Math.max(0, this.rejFlash - dt * FlashDecay);
  }

  /** 命中測試（世界座標）：淡到看不見的不能點。 */
  hitPill(wx: number, wy: number): FlowPill | null {
    for (const p of this.ordered)
      if (p.fade >= 0.3 && wx >= p.left && wx <= p.right && wy >= p.y - Layout.PillH / 2 && wy <= p.y - Layout.PillH / 2 + p.h) return p;
    return null;
  }

  chipY(i: number): number { return (i - (this.sessionsList.length - 1) / 2) * 44; }
}

// ── 幾何：與繪製、粒子共用 ─────────────────────────────────────────────────
export function route(a: Pt, b: Pt): [Pt, Pt, Pt, Pt] {
  const dx = (b.x - a.x) * 0.5;
  return [a, { x: a.x + dx, y: a.y }, { x: b.x - dx, y: b.y }, b];
}

export function cubic(c: [Pt, Pt, Pt, Pt], t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * c[0].x + 3 * u * u * t * c[1].x + 3 * u * t * t * c[2].x + t * t * t * c[3].x,
    y: u * u * u * c[0].y + 3 * u * u * t * c[1].y + 3 * u * t * t * c[2].y + t * t * t * c[3].y,
  };
}

// 連接點取「標題列中心」與方塊目前寬度，展開時連線會跟著移動
export const routeIn = (p: FlowPill): [Pt, Pt, Pt, Pt] => route(p.agent
  ? { x: Layout.AgentX + Layout.AgentW / 2, y: p.agent.y }
  : { x: Layout.Hub.x + Layout.HubR, y: Layout.Hub.y }, { x: p.left, y: p.y });
export const routeOut = (p: FlowPill, outputOffsetY = 0): [Pt, Pt, Pt, Pt] => route({ x: p.right, y: p.y }, { x: Layout.Out.x - Layout.OutR, y: Layout.Out.y + outputOffsetY });
export const routeRejected = (p: FlowPill, outputOffsetY = 0): [Pt, Pt, Pt, Pt] => route({ x: p.right, y: p.y }, { x: Layout.Rej.x - 46, y: Layout.Rej.y + outputOffsetY });

// ── 文字與顏色 ─────────────────────────────────────────────────────────────
export const agentKey = (sessionId: string, agentId: string): string => sessionId + ':' + agentId;

/** "mcp__windows-mcp__Click" → 依伺服器合併成一塊 "windows-mcp"。 */
export function pillInfo(tool: string): { key: string; name: string } {
  const p = tool.split('__');
  return p[0] === 'mcp' && p.length >= 3 ? { key: 'mcp:' + p[1], name: p[1] } : { key: tool, name: tool };
}

export function colorOf(key: string): string {
  if (key === 'Skill') return Palette.Skill;
  if (key === 'Task' || key === 'Agent') return Palette.Task;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
  return hslToHex(Math.abs(h) % 360, 0.85, 0.64);
}

/** "claude-sonnet-5-5" → "SONNET 5.5" */
export function formatModel(m: string | null | undefined): string {
  let s = (m ?? '').trim().replace(/^(?:codex|claude|openai|gemini)\s*[·:|]\s*/i, '');
  if (/^gpt-/i.test(s)) return ('GPT-' + s.slice(4).replaceAll('-', ' ')).toUpperCase();
  s = s.replace(/^claude-/i, '');
  s = s.replace(/-(\d)-(\d)/g, ' $1.$2').replaceAll('-', ' ');
  return s.toUpperCase();
}

export function ago(seconds: number): string {
  const m = Math.floor(seconds / 60);
  if (m < 1) return '剛剛';
  if (m < 60) return m + ' 分鐘前';
  const h = Math.floor(m / 60);
  return h < 48 ? h + ' 小時前' : Math.floor(h / 24) + ' 天前';
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const sec = Math.floor(h / 60);
  const [r, g, b] = sec === 0 ? [c, x, 0] : sec === 1 ? [x, c, 0] : sec === 2 ? [0, c, x] : sec === 3 ? [0, x, c] : sec === 4 ? [x, 0, c] : [c, 0, x];
  const hex = (v: number): string => Math.round((v + m) * 255).toString(16).toUpperCase().padStart(2, '0');
  return '#' + hex(r) + hex(g) + hex(b);
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
/** 本地時間 HH:mm */
export const hhmm = (ms: number): string => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
/** 本地時間 HH:mm:ss */
export const hhmmss = (ms: number): string => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
/** 最多一位小數、去掉尾端 0（對應 C# 的 "0.#"）。 */
export const num1 = (x: number): string => String(Math.round(x * 10) / 10);

// ── 泡泡文字：只用事件裡真實存在的欄位（工具名、摘要、耗時、代理 ID、模型）─────────
const short = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function limitText(hit: LimitHitDto): string {
  return `已達 ${hit.limitType === 'five_hour' ? '5 小時額度上限' : hit.limitType + ' 上限'} · ${hhmm(hit.resetsAt)} 重置`;
}

// 檔案類工具：摘要（summary）就是檔案路徑。Bash 之類的命令裡剛好出現 "xxx.md" 不算「碰到那個檔案」
const FileTools = new Set(['Read', 'Edit', 'Write', 'MultiEdit']);

/** 檔案工具所碰的檔名（不含資料夾）；不是檔案工具或沒有路徑回傳 null。同時接受 \ 與 / 兩種分隔字元。 */
export function fileNameOf(c: ToolCallDto): string | null {
  if (!FileTools.has(c.tool)) return null;
  const path = c.summary.trim().replace(/…+$/, '');
  if (path.length === 0) return null;
  const name = path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1);
  return name.length > 0 ? name : null;
}

/** 是 .md（或 .markdown）文件時回傳檔名，否則 null。 */
export function docName(c: ToolCallDto): string | null {
  const n = fileNameOf(c);
  return n !== null && /\.(md|markdown)$/i.test(n) ? n : null;
}

function docText(c: ToolCallDto, name: string): string {
  const verb = c.tool === 'Read' ? '讀取' : c.tool === 'Write' ? '寫入' : '編輯';
  return `文件 ${short(name, 34)} · ${verb}`;
}

/**
 * 本機 RAG 工具的泡泡文字；不是 RAG 工具回傳 null。文字只用事件裡真實存在的欄位：
 * 動作（工具名稱）、摘要（查詢句、來源、根目錄代號），以及寫入類工具的 dry_run 旗標（沒帶＝伺服器預設的試跑）。
 */
export function ragText(c: ToolCallDto): string | null {
  const action = ragActionOf(c.tool);
  if (action === null) return null;

  // 寫入類：摘要開頭是 "dry_run=false " 這種旗標（掃描器放在最前面）
  let summary = c.summary.trim();
  let wrote = false;
  if (isRagWrite(action)) {
    const m = /^dry_run=(true|false)\s*/.exec(summary);
    if (m) { wrote = m[1] === 'false'; summary = summary.slice(m[0].length); }
  }
  const value = summary.includes('=') && action !== 'rag_search' ? summary.slice(summary.indexOf('=') + 1) : summary; // "source=docs/A.md" → "docs/A.md"
  const lastName = value.slice(Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/')) + 1); // 只留檔名（含 #序號）

  switch (action) {
    case 'rag_search': return value.length > 0 ? `RAG 查詢 ▸ ${short(value, 26)}` : 'RAG 查詢';
    case 'rag_sources': return 'RAG 列出來源';
    case 'rag_status': return 'RAG 查看狀態';
    case 'rag_tables': return 'RAG 查看資料表';
    case 'rag_chunks': return lastName.length > 0 ? `RAG 查看片段 ▸ ${short(lastName, 24)}` : 'RAG 查看片段';
    case 'rag_chunk': return lastName.length > 0 ? `RAG 讀取片段 ▸ ${short(lastName, 26)}` : 'RAG 讀取片段';
    case 'rag_index': return `RAG 索引${value.length > 0 ? ' ' + short(value, 18) : ''} · ${wrote ? '寫入' : '試跑'}`;
    case 'rag_remove': return `RAG 刪除${lastName.length > 0 ? ' ' + short(lastName, 20) : ''} · ${wrote ? '刪除' : '試跑'}`;
    case 'rag_ingest_note': return `RAG 記錄筆記${value.length > 0 ? ' ▸ ' + short(value, 18) : ''} · ${wrote ? '寫入' : '試跑'}`;
    case 'rag_todo': return 'RAG 取待標註片段';
    case 'rag_annotate': return 'RAG 寫標註';
    default: return `RAG 清理${value.length > 0 ? ' ' + short(value, 18) : ''} · ${wrote ? '刪除' : '試跑'}`;
  }
}

function toolStartText(c: ToolCallDto, name: string): string {
  // 檔案工具顯示「檔名」而不是路徑開頭（真實路徑很長，截前 30 字只會看到 d:\Desktop\…）
  const file = fileNameOf(c);
  if (file !== null) return `${name} ▸ ${short(file, 30)}`;
  const parts = c.tool.split('__');
  const sub = parts[0] === 'mcp' && parts.length >= 3 ? parts.slice(2).join('__') : '';
  const detail = (sub.length > 0 ? sub + ' ' : '') + c.summary;
  return detail.trim().length > 0 ? `${name} ▸ ${short(detail.trim(), 30)}` : name;
}

function failureText(c: ToolCallDto, name: string): string {
  return `✕ ${name} 失敗` + (c.durationSeconds > 0 ? ` · ${num1(c.durationSeconds)}s` : '');
}

function agentText(a: AgentDto): string {
  const id = a.agentId.length > 6 ? a.agentId.slice(0, 6) : a.agentId;
  const model = formatModel(a.model);
  return `子代理 ${id.toUpperCase()} 啟動` + (model.length > 0 ? ` · ${model}` : '');
}
