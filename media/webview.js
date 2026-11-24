"use strict";
(() => {
  // src/core/bubbles.ts
  var BubbleAnchors = {
    /** AI 主節點。 */
    Hub: "@hub",
    /** 右側的 REJECTED 方塊。 */
    Rejected: "@rejected",
    isFixed: (key) => key === "@hub" || key === "@rejected"
  };
  var FlowBubble = class {
    constructor(kind, anchorKey, text, color, life, mergeName) {
      this.kind = kind;
      this.anchorKey = anchorKey;
      this.color = color;
      this.life = life;
      this.mergeName = mergeName;
      this.text = text;
    }
    text;
    age = 0;
    /** 密集事件被合併成一顆時的次數。 */
    count = 1;
    /** 可見度 0–1：前面淡入、後面淡出，中間維持 1。 */
    alpha(fadeSeconds) {
      return Math.min(1, Math.max(0, Math.min(this.age / fadeSeconds, (this.life - this.age) / fadeSeconds)));
    }
  };
  var BubbleQueue = class _BubbleQueue {
    static MaxVisible = 3;
    static FadeSeconds = 0.4;
    static ToolStartLife = 4;
    static FailureLife = 8;
    static AgentLife = 6;
    static StatusLife = 5;
    static LimitLife = 10;
    static DocLife = 6;
    static RagLife = 6;
    /** 同一個方塊在這段時間內再次開始工具，就合併進既有的泡泡。 */
    static MergeWindowSeconds = 3;
    _items = [];
    /** 關掉就不再產生新泡泡（已經在畫面上的會自然淡出）。 */
    enabled = true;
    get items() {
      return this._items;
    }
    add(kind, anchorKey, text, color, mergeName = "") {
      if (!this.enabled) return;
      if (kind === "toolStart") {
        const same = [...this._items].reverse().find((b) => b.kind === "toolStart" && b.anchorKey === anchorKey && b.age < _BubbleQueue.MergeWindowSeconds);
        if (same) {
          same.count++;
          same.text = `${mergeName.length > 0 ? mergeName : same.mergeName} \xD7${same.count}`;
          same.age = Math.min(same.age, _BubbleQueue.FadeSeconds);
          return;
        }
      }
      if (kind === "doc" || kind === "rag") {
        const same = this._items.find((b) => b.kind === kind && b.anchorKey === anchorKey && b.text === text);
        if (same) {
          same.age = Math.min(same.age, _BubbleQueue.FadeSeconds);
          return;
        }
      }
      if (this._items.length >= _BubbleQueue.MaxVisible) {
        let victim;
        for (const b of this._items) if (b.kind === "toolStart" && (!victim || b.age > victim.age)) victim = b;
        if (victim) this._items.splice(this._items.indexOf(victim), 1);
        else if (kind === "toolStart") return;
        else this._items.splice(0, 1);
      }
      const life = kind === "failure" ? _BubbleQueue.FailureLife : kind === "agent" ? _BubbleQueue.AgentLife : kind === "status" ? _BubbleQueue.StatusLife : kind === "limit" ? _BubbleQueue.LimitLife : kind === "doc" ? _BubbleQueue.DocLife : kind === "rag" ? _BubbleQueue.RagLife : _BubbleQueue.ToolStartLife;
      this._items.push(new FlowBubble(kind, anchorKey, text, color, life, mergeName));
    }
    /** 推進時間；壽命到了、或指向的方塊／子代理已經不在了就移除。 */
    tick(dt, anchorExists) {
      for (const b of this._items) b.age += dt;
      this._items = this._items.filter((b) => !(b.age >= b.life || !anchorExists(b.anchorKey)));
    }
  };

  // src/core/types.ts
  var SessionStatus = {
    Responding: "\u56DE\u61C9\u4E2D",
    RunningTool: "\u57F7\u884C\u5DE5\u5177\u4E2D",
    Waiting: "\u7B49\u5F85\u6388\u6B0A/\u57F7\u884C\u4E2D",
    Idle: "\u9592\u7F6E",
    Ended: "\u5DF2\u7D50\u675F"
  };
  var isActive = (s) => s === SessionStatus.Responding || s === SessionStatus.RunningTool || s === SessionStatus.Waiting;
  var ToolResult = { Running: "\u57F7\u884C\u4E2D", Ok: "\u6210\u529F", Failed: "\u5931\u6557", Interrupted: "\u672A\u5B8C\u6210/\u5DF2\u4E2D\u6B62" };

  // src/core/providerSnapshot.ts
  var source = (provider, sessionId) => sessionId.startsWith("codex:") ? "Codex" : provider?.trim() || "Claude";
  var sessionProvider = (session) => source(session.provider, session.sessionId);
  function snapshotProviders(snapshot) {
    return [...new Set([...snapshot.sessions, ...snapshot.recentToolCalls].map((s) => source(s.provider, s.sessionId)))];
  }
  function providerSnapshot(snapshot, provider, model2) {
    const sessions = new Map(snapshot.sessions.map((s) => [s.sessionId, source(s.provider, s.sessionId)]));
    const sessionSource = (id) => sessions.get(id) ?? source(void 0, id);
    const modelSessions = new Set(snapshot.sessions.filter((s) => source(s.provider, s.sessionId) === provider && s.model === model2).map((s) => s.sessionId));
    return {
      ...snapshot,
      sessions: snapshot.sessions.filter((s) => source(s.provider, s.sessionId) === provider && (model2 === void 0 || s.model === model2)),
      recentToolCalls: snapshot.recentToolCalls.filter((c) => (sessions.has(c.sessionId) ? sessionSource(c.sessionId) : source(c.provider, c.sessionId)) === provider && (model2 === void 0 || modelSessions.has(c.sessionId))),
      agents: snapshot.agents.filter((a) => sessionSource(a.sessionId) === provider && (model2 === void 0 || modelSessions.has(a.sessionId))),
      usageWindows: provider === "Claude" ? snapshot.usageWindows : [],
      lastLimitHit: provider === "Claude" ? snapshot.lastLimitHit : null
    };
  }

  // src/core/ragTools.ts
  var Actions = /* @__PURE__ */ new Set(["rag_search", "rag_sources", "rag_status", "rag_tables", "rag_chunks", "rag_chunk", "rag_index", "rag_remove", "rag_prune", "rag_todo", "rag_annotate", "rag_ingest_note"]);
  function ragActionOf(tool) {
    const parts = tool.split("__");
    return parts.length >= 3 && parts[0] === "mcp" && Actions.has(parts[parts.length - 1]) ? parts[parts.length - 1] : null;
  }
  function isRagWrite(action) {
    return action === "rag_index" || action === "rag_remove" || action === "rag_prune" || action === "rag_ingest_note";
  }

  // src/core/tailChips.ts
  var TailChipMax = 3;
  var TailOkLingerMs = 5e3;
  var TailFailLingerMs = 12e3;
  var TailFadeMs = 1e3;
  var NoTailChips = { chips: [], more: 0 };
  var FileVerbs = { Read: "\u8B80\u53D6", Write: "\u5BEB\u5165", Edit: "\u7DE8\u8F2F", MultiEdit: "\u7DE8\u8F2F" };
  function tailLabel(c) {
    const summary = c.summary.trim().replace(/…+$/, "");
    const verb = FileVerbs[c.tool];
    if (verb !== void 0 && summary.length > 0) {
      const name = summary.slice(Math.max(summary.lastIndexOf("\\"), summary.lastIndexOf("/")) + 1);
      return `${verb} ${name.length > 0 ? name : summary}`;
    }
    const parts = c.tool.split("__");
    if (parts[0] === "mcp" && parts.length >= 3) {
      const action = parts.slice(2).join("__");
      return summary.length > 0 ? `${action} ${summary}` : action;
    }
    return summary.length > 0 ? summary : c.tool;
  }
  function tailChips(recent, now, max = TailChipMax) {
    if (now <= 0 || recent.length === 0) return NoTailChips;
    const eligible = [];
    for (const call of recent) {
      if (call.result === ToolResult.Running) {
        eligible.push({ call, state: "run", alpha: 1, seconds: Math.max(0, (now - call.time) / 1e3) });
        continue;
      }
      const failed = call.result === ToolResult.Failed;
      if (!failed && call.result !== ToolResult.Ok) continue;
      const linger = failed ? TailFailLingerMs : TailOkLingerMs;
      const age = Math.max(0, now - (call.time + call.durationSeconds * 1e3));
      if (age >= linger) continue;
      const alpha = age > linger - TailFadeMs ? (linger - age) / TailFadeMs : 1;
      eligible.push({ call, state: failed ? "fail" : "ok", alpha, seconds: call.durationSeconds });
    }
    if (eligible.length === 0) return NoTailChips;
    eligible.sort((a, b) => a.call.time - b.call.time);
    const shown = eligible.slice(-Math.max(1, max));
    return { chips: shown, more: eligible.length - shown.length };
  }

  // src/core/model.ts
  var FlowParticle = class {
    constructor(kind, pillKey, color) {
      this.kind = kind;
      this.pillKey = pillKey;
      this.color = color;
    }
    /** 沿曲線前進的進度 0–1。 */
    t = 0;
  };
  var Layout = {
    AgentX: -260,
    AgentW: 68,
    AgentH: 84,
    MaxRows: 14,
    // 列距 52（方塊 32 + 間距 20）；主 session 與各子代理的方塊群之間再多留 48，免得展開一塊就擠到鄰居
    RowH: 52,
    PillW: 176,
    PillH: 32,
    GroupGap: 48,
    ExpandedW: 320,
    ExpandedRows: 5,
    ExpandedRowH: 18,
    ExpandedPad: 12,
    ChipX: -650,
    ChipW: 140,
    ChipH: 28,
    // 方塊尾巴的小標籤：寬、高、標籤間距、與方塊的距離、「+N」預留寬度
    // TailW 是單張標籤的最大寬度；多張串在一起時，總寬度不超過 TailBudget（每張自動縮窄，最窄 TailMinW）
    TailW: 176,
    TailMinW: 110,
    TailBudget: 440,
    TailH: 20,
    TailGap: 8,
    TailLead: 16,
    TailMoreW: 22,
    Hub: { x: -380, y: 0 },
    HubR: 44,
    Out: { x: 520, y: -30 },
    OutR: 54,
    Rej: { x: 520, y: 118 },
    /** 機器人的「每單位幾個像素」：機器人以約 30 單位高的單位座標繪製，乘上它（再乘各自的 scale）才是畫面大小。主機器人約 85 像素高。 */
    AlienUnit: 2.85,
    /** 在 Output 處理時可以站幾格（上下錯開）。 */
    OutSlots: 5,
    /** 同一個方塊上有好幾位機甲時，每往後一位往左退多少像素（乘上自己的大小）。 */
    SquadSpacing: 64
  };
  var MaxEscorts = 4;
  var EscortLinger = 1.2;
  var EscortScale = 0.8;
  var BurstSlackMs = 500;
  var AlienReachUnits = 18.1;
  var Palette = {
    Doc: "#5eead4",
    /** 本機 RAG 泡泡（粉紅）：與文件（青綠）、子代理（藍）、技能（紫）、任務（橘）區隔。 */
    Rag: "#f472b6",
    Ok: "#4cd98a",
    Fail: "#ff5a6a",
    Agent: "#7cc4ff",
    Skill: "#c792ff",
    Task: "#ffa657",
    Warn: "#e8b84a",
    Dim: "#5b6572",
    Text: "#e6e9ee",
    Sub: "#8b95a3"
  };
  var FlowPill = class {
    constructor(key, name, color, order, bornAt, agent) {
      this.key = key;
      this.name = name;
      this.color = color;
      this.order = order;
      this.bornAt = bornAt;
      this.agent = agent;
    }
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
    recent = [];
    expanded = false;
    justBorn = true;
    /** 左緣固定：展開時只往右長，才不會壓向左邊的子代理節點與連線。 */
    get left() {
      return -Layout.PillW / 2;
    }
    get right() {
      return this.left + this.w;
    }
  };
  var FlowAgent = class {
    constructor(key, info, order) {
      this.key = key;
      this.info = info;
      this.order = order;
    }
    y = 0;
    fade = 0;
    justBorn = true;
  };
  var IdleOrder = ["none", "rest", "wave", "shadow", "patrol", "sitDown"];
  var FlowAlien = class {
    /**
     * ownerKey：'' ＝主 AI；子代理是它的 key；分流增援是「隊伍#編號」。
     * groupKey：所屬隊伍（''＝主 AI 超級機器人，否則是子代理的怪獸機甲）。escortIndex：0＝隊長，1 以上＝增援。
     */
    constructor(ownerKey, baseScale, seed, groupKey = ownerKey, escortIndex = 0) {
      this.ownerKey = ownerKey;
      this.baseScale = baseScale;
      this.seed = seed;
      this.groupKey = groupKey;
      this.escortIndex = escortIndex;
    }
    x = 0;
    y = 0;
    vx = 0;
    vy = 0;
    /** 目前停靠／前往的方塊；null＝回到自己的節點旁。 */
    targetKey = null;
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
    pose = "stand";
    /** 進入目前動作後經過的秒數。 */
    poseTime = 0;
    wSit = 0;
    wFly = 0;
    wAttack = 0;
    wCheer = 0;
    wHurt = 0;
    wWave = 0;
    idleAct = "none";
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
    deliverTarget = null;
    /** 在 Output 處理還要多久（秒）；到站才開始倒數。 */
    deliverLeft = 0;
    /** 上一趟處理完之後的冷卻（秒）：冷卻中不會再出發，避免一直來回飛。 */
    deliverCool = 0;
    alive = true;
    /** 增援的光暈顏色（取自它正在打的工具方塊）；null＝用預設色。 */
    tint = null;
    /** 負責的那一筆執行中呼叫（toolUseId）；null＝沒有。 */
    callId = null;
    work = null;
    /** 同一個方塊上有好幾位時的排位（0＝最靠近方塊）。 */
    rank = 0;
    /** 增援做完事之後還留多久（秒）才淡出。 */
    linger = 0;
    get scale() {
      return this.baseScale * (0.4 + 0.6 * this.intro);
    }
    get isMonster() {
      return this.groupKey.length > 0;
    }
    /** 在 Output 處理時站哪一格（0–4，上下錯開）：每位依自己的相位分配，同時處理時盡量不疊在一起。 */
    get outSlot() {
      return (Math.floor(this.seed) + 2) % Layout.OutSlots;
    }
  };
  function alienHome(agent) {
    return agent === null ? { x: Layout.Hub.x + 42, y: Layout.Hub.y - Layout.HubR - 52 } : { x: Layout.AgentX + 104, y: agent.y - 55 };
  }
  function alienSpot(p, baseScale = 1) {
    return { x: p.left - AlienReachUnits * Layout.AlienUnit * baseScale - 20, y: p.y };
  }
  function alienOutSpot(fail, baseScale, slot, dx = 0) {
    const reach = AlienReachUnits * Layout.AlienUnit * baseScale + 20;
    const dy = (slot - 2) * (fail ? 12 : 26);
    return fail ? { x: Layout.Rej.x - 46 - reach + dx, y: Layout.Rej.y + dy } : { x: Layout.Out.x - Layout.OutR - reach + dx, y: Layout.Out.y + dy };
  }
  function outAim(fail, slot, dx = 0) {
    return fail ? { x: Layout.Rej.x - 46 + dx, y: Layout.Rej.y + (slot - 2) * 12 } : { x: Layout.Out.x - Layout.OutR * 0.92 + dx, y: Layout.Out.y + (slot - 2) * 26 };
  }
  var defaultOptions = () => ({
    windowMinutes: 30,
    lingerSeconds: 15,
    stepSeconds: 4,
    fadeSeconds: 6,
    freshSeconds: 15,
    freeIdle: true,
    random: Math.random
  });
  var FlashPeak = 0.6;
  var FlashDecay = 0.9;
  var AlienDwellStart = 1.2;
  var AlienDwellEnd = 0.8;
  var DeliverSeconds = 1.6;
  var DeliverCooldown = 3;
  var MaxFlySpeed = 900;
  var SpringK = 38;
  var SpringC = 9;
  var clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  var FlowModel = class {
    o;
    pills = /* @__PURE__ */ new Map();
    agentMap = /* @__PURE__ */ new Map();
    calls = /* @__PURE__ */ new Map();
    particlesList = [];
    aliensMap = /* @__PURE__ */ new Map();
    visits = /* @__PURE__ */ new Map();
    /** 擁有者 → 還沒送去 Output 處理的結果（成功／失敗；只要有一筆失敗就算失敗）。 */
    pendingOut = /* @__PURE__ */ new Map();
    alienLevelValue = 0;
    alienSeq = 0;
    /** 上一次同步時同時執行中的工具數（分流泡泡用）。 */
    parallel = 0;
    /**
     * 並行但「掃描到時已經完成」的快工具：仍要出動一下機甲。key＝toolUseId；
     * owner＝所屬隊伍（''＝主 AI）、time＝呼叫開始時間（毫秒）、left＝還要出動幾秒。
     */
    ghosts = /* @__PURE__ */ new Map();
    ordered = [];
    sessionsList = [];
    orderSeq = 0;
    first = true;
    clock = 0;
    lastActivity = null;
    limitSeen = null;
    /** 使用者偏好「減少動態」時不產生粒子、泡泡與機器人。 */
    reduceMotion = false;
    bubbles = new BubbleQueue();
    agents = [];
    log = [];
    stats = { total: 0, ok: 0, fail: 0, running: 0 };
    activeSessions = 0;
    modelText = "";
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
    liveText = "\u25CF LIVE";
    constructor(options) {
      this.o = { ...defaultOptions(), ...options };
    }
    get windowMinutes() {
      return this.o.windowMinutes;
    }
    get providerLabel() {
      return this.o.provider ?? "AI";
    }
    get modelKey() {
      return this.o.modelKey;
    }
    bindModel(model2) {
      if (this.o.modelKey !== void 0 && this.o.modelKey !== model2) throw new Error("A brain cannot switch models");
      this.o.modelKey = model2;
    }
    outputOffsetY = 0;
    /** 手／腳整組因標籤、泡泡而往右讓開的距離（動畫迴圈慢慢滑過去的值）。 */
    outputOffsetX = 0;
    outputSlotOffset = 0;
    get freeIdle() {
      return this.o.freeIdle;
    }
    set freeIdle(v) {
      this.o.freeIdle = v;
    }
    get pillList() {
      return this.ordered;
    }
    get particles() {
      return this.particlesList;
    }
    get sessions() {
      return this.sessionsList;
    }
    get aliens() {
      return [...this.aliensMap.values()];
    }
    /** 機器人整體可見度（AI 在執行才出現，閒置時淡出）。 */
    get alienLevel() {
      return this.alienLevelValue;
    }
    /**
     * 畫面是否還需要連續重畫：有 AI 在忙（或還在 LIVE 緩衝期）、還沒淡完、還有粒子或泡泡、機器人還沒消失。
     * 全部淡掉之後畫面是靜止的（只剩「目前沒有 AI 在執行」），不需要每秒畫幾十次。
     */
    get animating() {
      return this.busy || this.isLive || this.source > 2e-3 || this.sink > 2e-3 || this.alienLevelValue > 2e-3 || this.particlesList.length > 0 || this.bubbles.items.length > 0 || this.ordered.some((p) => p.fade > 0.01) || this.ordered.some((p) => this.tailOf(p).chips.length > 0);
    }
    /** 最近一次 tick 收到的時間（毫秒時間戳）；小標籤用它判斷「剛結束」。 */
    nowMs = 0;
    /** 某個方塊尾巴要顯示的小標籤。展開時下方已列出呼叫，就不再重複顯示。 */
    tailOf(p) {
      return p.expanded ? NoTailChips : tailChips(p.recent, this.nowMs);
    }
    /**
     * 方塊「輸出連線」的起點 x：沒有小標籤時就是方塊右緣；有的話接在最後一張標籤（或「+N」）之後，
     * 這樣 方塊 → 標籤 → 輸出手臂 仍是一條連續的點對點連線，不會被標籤蓋住。
     */
    tailEndX(p) {
      const { chips, more } = this.tailOf(p);
      if (chips.length === 0) return p.right;
      const n = chips.length;
      const end = p.left + Layout.PillW + Layout.TailLead + n * tailChipWidth(tailWeight(chips)) + (n - 1) * Layout.TailGap + (more > 0 ? Layout.TailGap + Layout.TailMoreW : 0);
      const k = Math.max(...chips.map((c) => c.alpha));
      return p.right + (end - p.right) * k;
    }
    /** 距離「最後一次真實活動」多久（秒）。有 AI 在執行視為 0；從未有過活動為無限大。 */
    idleAge(now) {
      return this.busy ? 0 : this.lastActivity !== null ? Math.max(0, (now - this.lastActivity) / 1e3) : Infinity;
    }
    // ── 資料同步 ───────────────────────────────────────────────────────────
    sync(d) {
      if (this.o.provider) d = providerSnapshot(d, this.o.provider, this.o.modelKey);
      const now = d.at;
      const windowMs = this.o.windowMinutes * 6e4;
      const inWin = d.recentToolCalls.filter((c) => c.result === ToolResult.Running || now - c.time < windowMs);
      const live = /* @__PURE__ */ new Set([
        ...inWin.map((c) => c.sessionId),
        ...d.agents.filter((a) => isActive(a.status)).map((a) => a.sessionId)
      ]);
      this.busy = d.sessions.some((s) => isActive(s.status)) || d.agents.some((s) => isActive(s.status)) || inWin.some((c) => c.result === ToolResult.Running);
      const stamps = [
        ...d.sessions.map((s) => s.lastActivity),
        ...d.agents.map((s) => s.lastActivity),
        ...inWin.map((c) => c.time)
      ].filter((t) => t > 0);
      this.lastActivity = stamps.length > 0 ? Math.max(...stamps) : null;
      this.sessionsList = d.sessions.filter((s) => isActive(s.status) || live.has(s.sessionId)).slice(0, 4);
      const lead = d.sessions.find((s) => isActive(s.status)) ?? d.sessions[0];
      this.modelText = lead ? formatModel(lead.model) : this.o.modelKey ? formatModel(this.o.modelKey) : "";
      const visibleAgents = d.agents.filter((a) => isActive(a.status) || inWin.some((c) => c.sessionId === a.sessionId && c.agentId === a.agentId));
      const agentKeys = new Set(visibleAgents.map((a) => agentKey(a.sessionId, a.agentId)));
      for (const key of [...this.agentMap.keys()]) if (!agentKeys.has(key)) this.agentMap.delete(key);
      for (const a of visibleAgents) {
        const key = agentKey(a.sessionId, a.agentId);
        const node = this.agentMap.get(key);
        if (node) node.info = a;
        else {
          this.agentMap.set(key, new FlowAgent(key, a, this.orderSeq++));
          if (!this.first && !this.reduceMotion)
            this.bubbles.add("agent", key, agentText(a), Palette.Task);
        }
      }
      this.agents = [...this.agentMap.values()].sort((a, b) => a.order - b.order);
      for (const p of this.pills.values()) {
        p.count = p.ok = p.fail = p.running = 0;
        p.recent = [];
      }
      let total = 0, ok = 0, fail = 0, running = 0;
      const ids = /* @__PURE__ */ new Set();
      const newlyDone = [];
      for (const c of [...inWin].reverse()) {
        ids.add(c.toolUseId);
        let { key, name } = pillInfo(c.tool);
        const owner = this.agentMap.get(agentKey(c.sessionId, c.agentId)) ?? null;
        if (owner) key = owner.key + "/" + key;
        total++;
        if (c.result === ToolResult.Ok) ok++;
        else if (c.result === ToolResult.Failed) fail++;
        else if (c.result === ToolResult.Running) running++;
        let p = this.pills.get(key) ?? null;
        if (!p) p = this.makePill(key, name, owner);
        if (!p) continue;
        p.count++;
        p.recent.unshift(c);
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
          const fresh = (now - c.time) / 1e3 < this.o.freshSeconds;
          if (!this.first && !this.reduceMotion && fresh) {
            this.visit(owner, p, AlienDwellStart, c.result);
            if (done) {
              this.pend(owner, c.result);
              newlyDone.push({ c, owner: owner?.key ?? "" });
            }
            this.particlesList.push(new FlowParticle("in", p.key, p.color));
            if (done) this.emitOut(p, c.result);
            const doc = docName(c);
            const rag = ragText(c);
            if (c.result === ToolResult.Failed) this.bubbles.add("failure", p.key, failureText(c, p.name), Palette.Fail);
            else if (rag !== null) this.bubbles.add("rag", p.key, rag, Palette.Rag);
            else if (doc !== null) this.bubbles.add("doc", p.key, docText(c, doc), Palette.Doc);
            else if (!done) this.bubbles.add("toolStart", p.key, toolStartText(c, p.name), p.color, p.name);
          }
        } else if (rec.result === ToolResult.Running && done) {
          this.calls.set(c.toolUseId, { pill: rec.pill, result: c.result });
          if (!this.reduceMotion) {
            const holder = [...this.aliensMap.values()].find((u) => u.escortIndex > 0 && u.callId === c.toolUseId);
            if (holder) this.pendKey(holder.ownerKey, c.result);
            else {
              this.visit(owner, p, AlienDwellEnd, c.result);
              this.pend(owner, c.result);
            }
            this.emitOut(p, c.result);
            if (c.result === ToolResult.Failed) this.bubbles.add("failure", p.key, failureText(c, p.name), Palette.Fail);
          }
        }
      }
      for (const [k, v] of [...this.pills]) if (v.count === 0) this.pills.delete(k);
      for (const id of [...this.calls.keys()]) if (!ids.has(id)) this.calls.delete(id);
      this.ordered = [...this.pills.values()].sort((a, b) => (a.agent?.order ?? -1) - (b.agent?.order ?? -1) || a.order - b.order);
      const announced = this.registerBursts(newlyDone, inWin);
      this.stats = { total, ok, fail, running };
      this.log = inWin.slice(0, 3);
      this.activeSessions = (/* @__PURE__ */ new Set([
        ...d.sessions.filter((s) => isActive(s.status)).map((s) => s.sessionId),
        ...d.agents.filter((a) => isActive(a.status)).map((a) => a.sessionId)
      ])).size;
      const age = this.idleAge(now);
      const wasLive = this.isLive;
      this.isLive = age <= this.o.lingerSeconds;
      this.liveText = this.isLive ? "\u25CF LIVE" : !Number.isFinite(age) ? "\u25CF IDLE" : `\u25CF IDLE \xB7 \u6700\u5F8C\u6D3B\u52D5 ${ago(age)}`;
      if (!this.first && !this.reduceMotion) {
        if (!wasLive && this.isLive)
          this.bubbles.add("status", BubbleAnchors.Hub, "AI \u958B\u59CB\u57F7\u884C" + (this.modelText.length > 0 ? " \xB7 " + this.modelText : ""), Palette.Agent);
        else if (wasLive && !this.isLive)
          this.bubbles.add("status", BubbleAnchors.Hub, `\u5DF2\u9592\u7F6E ${this.o.lingerSeconds} \u79D2\uFF0C\u958B\u59CB\u6DE1\u51FA`, Palette.Warn);
      }
      if (!this.first && !this.reduceMotion && this.parallel < 2 && running >= 2 && !announced)
        this.bubbles.add("status", BubbleAnchors.Hub, `\u5206\u6D41 \xD7${running} \xB7 \u6A5F\u7532\u51FA\u52D5`, Palette.Agent);
      this.parallel = running;
      const hit = d.lastLimitHit;
      if (hit) {
        if (!this.first && !this.reduceMotion && (this.limitSeen === null || hit.hitAt > this.limitSeen))
          this.bubbles.add("limit", BubbleAnchors.Rejected, limitText(hit), Palette.Fail);
        if (this.limitSeen === null || hit.hitAt > this.limitSeen) this.limitSeen = hit.hitAt;
      }
      this.first = false;
    }
    makePill(key, name, owner) {
      let n = 0;
      for (const p2 of this.pills.values()) if (p2.agent === owner) n++;
      if (n >= Layout.MaxRows) return null;
      const p = new FlowPill(key, name, colorOf(owner === null ? key : key.slice(owner.key.length + 1)), this.orderSeq++, this.clock, owner);
      this.pills.set(key, p);
      return p;
    }
    emitOut(p, result) {
      this.particlesList.push(new FlowParticle(
        result === ToolResult.Failed ? "rejected" : "out",
        p.key,
        result === ToolResult.Failed ? Palette.Fail : Palette.Ok
      ));
    }
    visit(owner, p, seconds, outcome) {
      this.visits.set(owner?.key ?? "", { pill: p.key, left: seconds, outcome });
    }
    /** 記下一筆「還沒送去 Output」的結果；快速連續完成的合併成一趟，只要有一筆失敗就整趟算失敗。 */
    pend(owner, result) {
      this.pendKey(owner?.key ?? "", result);
    }
    pendKey(key, result) {
      if (result === ToolResult.Running) return;
      const failed = result === ToolResult.Failed || this.pendingOut.get(key) === ToolResult.Failed;
      this.pendingOut.set(key, failed ? ToolResult.Failed : ToolResult.Ok);
    }
    // ── 機器人 ─────────────────────────────────────────────────────────────
    tickAliens(dt) {
      if (!this.aliensMap.has("")) {
        const h = alienHome(null);
        const a = new FlowAlien("", 1, this.alienSeq++);
        a.x = h.x;
        a.y = h.y;
        a.intro = 1;
        this.aliensMap.set("", a);
      }
      for (const a of this.agents) {
        if (!this.aliensMap.has(a.key)) {
          const main = this.aliensMap.get("");
          const s = new FlowAlien(a.key, 0.7, this.alienSeq++);
          s.x = main.x;
          s.y = main.y;
          this.aliensMap.set(a.key, s);
        }
      }
      for (const u of this.aliensMap.values()) if (u.escortIndex === 0) u.alive = u.ownerKey.length === 0 || this.agentMap.has(u.ownerKey);
      this.assignSquads(dt);
      for (const [k, v] of [...this.visits]) {
        if (v.left - dt <= 0) this.visits.delete(k);
        else this.visits.set(k, { ...v, left: v.left - dt });
      }
      const want = !this.reduceMotion && (this.busy || this.isLive) ? 1 : 0;
      this.alienLevelValue += (want - this.alienLevelValue) * Math.min(1, dt * 1.5);
      for (const u of [...this.aliensMap.values()]) {
        const agent = this.agentMap.get(u.groupKey) ?? null;
        let target = u.work;
        let outcome = ToolResult.Running;
        if (target === null && u.escortIndex === 0) {
          const v = this.visits.get(u.ownerKey);
          const vp = v ? this.pills.get(v.pill) : void 0;
          if (v && vp) {
            target = vp;
            outcome = v.outcome;
          }
        }
        u.targetKey = target?.key ?? null;
        if (u.escortIndex > 0 && target !== null) u.tint = target.color;
        if (u.deliverCool > 0) u.deliverCool -= dt;
        const pend = this.pendingOut.get(u.ownerKey);
        if (target !== null) u.deliverTarget = null;
        else if (u.deliverTarget === null && u.deliverCool <= 0 && u.alive && !this.reduceMotion && pend !== void 0) {
          u.deliverTarget = pend === ToolResult.Failed ? "fail" : "ok";
          u.deliverLeft = DeliverSeconds;
        }
        const slot = (u.outSlot + this.outputSlotOffset) % Layout.OutSlots;
        if (this.o.freeIdle && u.escortIndex === 0 && target === null && u.deliverTarget === null && this.busy && u.alive && !this.reduceMotion) {
          u.idleLeft -= dt;
          if (u.idleLeft <= 0) this.pickIdle(u);
        } else if (u.idleAct !== "none") {
          u.idleAct = "none";
          u.idleLeft = 0;
          u.patrolX = u.patrolY = 0;
        }
        let goal;
        if (target !== null) {
          const s = alienSpot(target, u.baseScale);
          goal = { x: s.x - u.rank * Layout.SquadSpacing * u.baseScale, y: s.y };
        } else if (u.deliverTarget !== null) {
          goal = alienOutSpot(u.deliverTarget === "fail", u.baseScale, slot, this.outputOffsetX);
          goal = { x: goal.x, y: goal.y + this.outputOffsetY };
        } else if (u.alive || agent !== null) {
          const h = alienHome(agent);
          goal = { x: h.x + u.patrolX + u.escortIndex * 52, y: h.y + u.patrolY };
        } else goal = { x: u.x, y: u.y };
        u.vx += (SpringK * (goal.x - u.x) - SpringC * u.vx) * dt;
        u.vy += (SpringK * (goal.y - u.y) - SpringC * u.vy) * dt;
        const sp = Math.sqrt(u.vx * u.vx + u.vy * u.vy);
        if (sp > MaxFlySpeed) {
          u.vx *= MaxFlySpeed / sp;
          u.vy *= MaxFlySpeed / sp;
        }
        u.x += u.vx * dt;
        u.y += u.vy * dt;
        const speed = Math.sqrt(u.vx * u.vx + u.vy * u.vy);
        u.tilt = clamp(u.vx / 500, -0.3, 0.3);
        u.thrust = clamp(speed / 200, 0, 1);
        u.lean = clamp(u.vx / 150, -1, 1);
        const docked = target !== null && Math.hypot(goal.x - u.x, goal.y - u.y) < 14 && speed < 60;
        const deliverDocked = u.deliverTarget !== null && Math.hypot(goal.x - u.x, goal.y - u.y) < 14 && speed < 60;
        let pose;
        if (docked) pose = target.running > 0 ? "attack" : outcome === ToolResult.Failed ? "hurt" : "cheer";
        else if (deliverDocked) pose = "attack";
        else if (speed > 45) pose = "fly";
        else if (target === null && !this.busy) pose = "sit";
        else if (u.idleAct === "wave") pose = "wave";
        else if (u.idleAct === "shadow") pose = "attack";
        else if (u.idleAct === "sitDown") pose = "sit";
        else pose = "stand";
        if (pose !== u.pose) {
          u.pose = pose;
          u.poseTime = 0;
        } else u.poseTime += dt;
        const ease = (cur, on) => cur + ((on ? 1 : 0) - cur) * Math.min(1, dt * 8);
        u.wSit = ease(u.wSit, pose === "sit");
        u.wFly = ease(u.wFly, pose === "fly");
        u.wAttack = ease(u.wAttack, pose === "attack");
        u.wCheer = ease(u.wCheer, pose === "cheer");
        u.wHurt = ease(u.wHurt, pose === "hurt");
        u.wWave = ease(u.wWave, pose === "wave");
        u.punch = pose === "attack" ? 0.5 - 0.5 * Math.cos(u.poseTime * 2 * Math.PI / 0.7) : 0;
        u.punchB = pose === "attack" ? 1 - u.punch : 0;
        if (target !== null) {
          const ax = target.left - u.x, ay = target.y - u.y;
          const len = Math.sqrt(ax * ax + ay * ay);
          if (len > 1) {
            u.aimX = ax / len;
            u.aimY = ay / len;
          }
        } else if (u.deliverTarget !== null) {
          const aim = outAim(u.deliverTarget === "fail", slot, this.outputOffsetX);
          aim.y += this.outputOffsetY;
          const ax = aim.x - u.x, ay = aim.y - u.y;
          const len = Math.sqrt(ax * ax + ay * ay);
          if (len > 1) {
            u.aimX = ax / len;
            u.aimY = ay / len;
          }
        } else if (u.idleAct === "shadow") {
          u.aimX = u.shadowX;
          u.aimY = u.shadowY;
        }
        if (pose === "attack") u.face = u.aimX >= 0 ? 1 : -1;
        if (deliverDocked) {
          const flash = FlashPeak * 0.8 * Math.max(u.punch, u.punchB);
          if (u.deliverTarget === "fail") this.rejFlash = Math.max(this.rejFlash, flash);
          else this.outFlash = Math.max(this.outFlash, flash);
          u.deliverLeft -= dt;
          if (u.deliverLeft <= 0) {
            const p2 = this.pendingOut.get(u.ownerKey);
            if (p2 !== void 0 && p2 === ToolResult.Failed === (u.deliverTarget === "fail")) this.pendingOut.delete(u.ownerKey);
            u.deliverTarget = null;
            u.deliverCool = DeliverCooldown;
          }
        }
        u.bob = Math.sin(this.clock * 2.4 + u.seed * 1.7) * 2.2 * (1 - 0.7 * u.wSit) - u.wCheer * Math.abs(Math.sin(u.poseTime * 9)) * 4;
        u.intro = u.alive ? Math.min(1, u.intro + dt * 2.5) : Math.max(0, u.intro - dt * 3);
        u.alpha = this.alienLevelValue * this.source * u.intro;
        if (!u.alive && u.intro <= 0.01) {
          this.aliensMap.delete(u.ownerKey);
          if (u.escortIndex > 0) this.pendingOut.delete(u.ownerKey);
        }
      }
    }
    /**
     * 並行的快工具（例如一次 Read 三個檔案）：掃描到的時候通常已經完成，只看「執行中」會派不出機甲。
     * 這裡把「這一輪才第一次看到、已完成」的呼叫，和同一隊的其他呼叫依時間排序：區間重疊、或前一個結束後
     * BurstSlackMs 之內就開始下一個，算同一批；同一批有 2 個以上就登記成「出動中」，assignSquads 會替每一筆派一隻機甲短暫出動。
     * 隔了一段時間才開始的下一個（例如要等模型回應的下一回合）不算。
     * 回傳是否已經彈出「分流」泡泡（呼叫端就不再為同一批彈第二顆）。
     */
    registerBursts(done, all) {
      if (done.length === 0 || this.reduceMotion) return false;
      let announced = false;
      const ownerOf = (c) => this.agentMap.get(agentKey(c.sessionId, c.agentId))?.key ?? "";
      for (const owner of new Set(done.map((d) => d.owner))) {
        const fresh = new Set(done.filter((d) => d.owner === owner).map((d) => d.c.toolUseId));
        const pool = all.filter((c) => ownerOf(c) === owner && (fresh.has(c.toolUseId) || c.result === ToolResult.Running)).sort((a, b) => a.time - b.time);
        let cluster = [];
        let end = -Infinity;
        const flush = () => {
          const quick = cluster.filter((c) => fresh.has(c.toolUseId));
          if (cluster.length >= 2 && quick.length > 0) {
            for (const c of quick) if (!this.ghosts.has(c.toolUseId)) this.ghosts.set(c.toolUseId, { owner, time: c.time, left: AlienDwellStart });
            this.bubbles.add("status", BubbleAnchors.Hub, `\u5206\u6D41 \xD7${cluster.length} \xB7 \u6A5F\u7532\u51FA\u52D5`, Palette.Agent);
            announced = true;
          }
          cluster = [];
          end = -Infinity;
        };
        for (const c of pool) {
          if (cluster.length > 0 && c.time > end + BurstSlackMs) flush();
          cluster.push(c);
          end = Math.max(end, c.result === ToolResult.Running ? Infinity : c.time + c.durationSeconds * 1e3);
        }
        flush();
      }
      return announced;
    }
    /**
     * 分流：每個隊（主 AI／各子代理）每一筆「執行中」的呼叫都分配一隻機甲——隊長優先、不夠再派增援（有上限）。
     * 分配是穩定的：已經在打某筆呼叫的繼續打它，新來的呼叫才分給空手的，所以機甲不會互相換位。
     */
    assignSquads(dt) {
      for (const [id, gh] of [...this.ghosts]) {
        gh.left -= dt;
        if (gh.left <= 0) this.ghosts.delete(id);
      }
      for (const e of this.aliensMap.values()) if (e.escortIndex > 0 && !this.aliensMap.has(e.groupKey)) e.alive = false;
      for (const leader of [...this.aliensMap.values()].filter((u) => u.escortIndex === 0)) {
        const g = leader.ownerKey;
        const members = [...this.aliensMap.values()].filter((u) => u.groupKey === g).sort((a, b) => a.escortIndex - b.escortIndex);
        const real = this.ordered.filter((p) => (p.agent?.key ?? "") === g).flatMap((p) => p.recent.filter((c) => c.result === ToolResult.Running));
        const quick = [...this.ghosts].filter(([, gh]) => gh.owner === g).map(([id, gh]) => ({ toolUseId: id, time: gh.time }));
        const running = [...real, ...quick].sort((a, b) => b.time - a.time);
        const ids = new Set(running.map((c) => c.toolUseId));
        for (const m of members) if (m.callId !== null && !ids.has(m.callId)) m.callId = null;
        const held = new Set(members.filter((m) => m.callId !== null).map((m) => m.callId));
        for (const c of running) {
          if (held.has(c.toolUseId)) continue;
          let free = members.find((m) => m.callId === null && m.alive) ?? null;
          if (free === null && !this.reduceMotion && leader.alive && members.length < 1 + MaxEscorts) {
            let idx = 1;
            while (members.some((m) => m.escortIndex === idx)) idx++;
            free = new FlowAlien(g + "#" + idx, leader.baseScale * EscortScale, this.alienSeq++, g, idx);
            free.x = leader.x;
            free.y = leader.y;
            free.linger = EscortLinger;
            this.aliensMap.set(free.ownerKey, free);
            members.push(free);
          }
          if (free === null) break;
          free.callId = c.toolUseId;
        }
        for (const m of members) {
          const rec = m.callId !== null ? this.calls.get(m.callId) : void 0;
          m.work = rec ? this.pills.get(rec.pill) ?? null : null;
        }
        const ranks = /* @__PURE__ */ new Map();
        for (const m of members) {
          if (m.work === null) continue;
          const r = ranks.get(m.work.key) ?? 0;
          m.rank = r;
          ranks.set(m.work.key, r + 1);
        }
        for (const e of members) {
          if (e.escortIndex === 0) continue;
          const busy = e.work !== null || e.deliverTarget !== null || this.pendingOut.has(e.ownerKey);
          if (busy) e.linger = EscortLinger;
          else e.linger -= dt;
          e.alive = leader.alive && e.linger > 0;
        }
      }
    }
    /** 隨機挑下一件自由活動與持續時間。權重：待命 3、揮手 1、對空出拳 1.5、巡邏 1.5、坐下 2；不會連續兩次一樣。 */
    pickIdle(u) {
      const r = this.o.random;
      const roll = r() * 9;
      let act = roll < 3 ? "rest" : roll < 4 ? "wave" : roll < 5.5 ? "shadow" : roll < 7 ? "patrol" : "sitDown";
      if (act === u.idleAct) act = act === "sitDown" ? "rest" : IdleOrder[IdleOrder.indexOf(act) + 1];
      const secs = act === "rest" ? 2 + 3 * r() : act === "wave" ? 1.6 + 0.8 * r() : act === "shadow" ? 2 + 1.5 * r() : act === "patrol" ? 3 + r() : 3 + 3 * r();
      this.setIdle(u, act, secs);
    }
    setIdle(u, act, seconds) {
      const r = this.o.random;
      u.idleAct = act;
      u.idleLeft = seconds;
      u.idlePicks++;
      u.patrolX = u.patrolY = 0;
      if (act === "patrol") {
        const angle = r() * 2 * Math.PI, radius = 18 + 27 * r();
        u.patrolX = Math.cos(angle) * radius;
        u.patrolY = Math.sin(angle) * radius * 0.6;
      } else if (act === "shadow") {
        const side = r() < 0.5 ? -1 : 1, a = (10 + 25 * r()) * Math.PI / 180;
        u.shadowX = side * Math.sin(a);
        u.shadowY = Math.cos(a);
      } else if (act === "wave") u.waveSide = r() < 0.5 ? -1 : 1;
    }
    /** 測試用：強制某個擁有者的機器人立刻做某件自由活動。 */
    forceIdle(ownerKey, act, seconds) {
      this.setIdle(this.aliensMap.get(ownerKey), act, seconds);
    }
    // ── 時間軸（每一幀）─────────────────────────────────────────────────────
    tick(dtRaw, now) {
      const dt = clamp(dtRaw, 0, 0.05);
      this.clock += dt;
      this.nowMs = now;
      this.bubbles.tick(dt, (k) => BubbleAnchors.isFixed(k) || this.pills.has(k) || this.agentMap.has(k));
      const list = this.ordered;
      const gap = Layout.RowH - Layout.PillH;
      const ease = Math.min(1, dt * 8);
      for (const p of list) {
        const wT = p.expanded ? Layout.ExpandedW : Layout.PillW;
        const hT = p.expanded ? Layout.PillH + Layout.ExpandedPad + Math.max(1, p.recent.length) * Layout.ExpandedRowH : Layout.PillH;
        if (p.justBorn) {
          p.w = wT;
          p.h = hT;
        }
        p.w += (wT - p.w) * ease;
        p.h += (hT - p.h) * ease;
      }
      const groups = [];
      const mainPills = list.filter((p) => p.agent === null);
      if (mainPills.length > 0) groups.push({ agent: null, pills: mainPills });
      for (const a of this.agents) groups.push({ agent: a, pills: list.filter((p) => p.agent === a) });
      const sumH = (pills) => pills.reduce((s, p) => s + p.h, 0);
      const heightOf = (g) => Math.max(g.agent === null ? 0 : 72, sumH(g.pills) + Math.max(0, g.pills.length - 1) * gap);
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
          p.runLevel += ((p.running > 0 ? 1 : 0) - p.runLevel) * Math.min(1, dt * 2);
          p.runSeconds = p.running > 0 ? p.runSeconds + dt : 0;
          p.intro = clamp((this.clock - p.bornAt) / 0.35, 0, 1);
          p.justBorn = false;
        }
        top += height + Layout.GroupGap;
      }
      const age = this.idleAge(now);
      const fadeTo = (cur, target) => target >= cur ? cur + (target - cur) * Math.min(1, dt * 6) : target;
      const level = (start) => age <= start ? 1 : clamp(1 - (age - start) / this.o.fadeSeconds, 0, 1);
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
        const p = this.pills.get(pt.pillKey);
        if (pt.kind === "in" && p) p.flash = FlashPeak;
        else if (pt.kind === "out") this.outFlash = FlashPeak;
        else if (pt.kind === "rejected") this.rejFlash = FlashPeak;
        this.particlesList.splice(i, 1);
      }
      this.outFlash = Math.max(0, this.outFlash - dt * FlashDecay);
      this.rejFlash = Math.max(0, this.rejFlash - dt * FlashDecay);
    }
    /** 命中測試（世界座標）：淡到看不見的不能點。 */
    hitPill(wx, wy) {
      for (const p of this.ordered)
        if (p.fade >= 0.3 && wx >= p.left && wx <= p.right && wy >= p.y - Layout.PillH / 2 && wy <= p.y - Layout.PillH / 2 + p.h) return p;
      return null;
    }
    chipY(i) {
      return (i - (this.sessionsList.length - 1) / 2) * 44;
    }
  };
  function route(a, b) {
    const dx = (b.x - a.x) * 0.5;
    return [a, { x: a.x + dx, y: a.y }, { x: b.x - dx, y: b.y }, b];
  }
  function cubic(c, t) {
    const u = 1 - t;
    return {
      x: u * u * u * c[0].x + 3 * u * u * t * c[1].x + 3 * u * t * t * c[2].x + t * t * t * c[3].x,
      y: u * u * u * c[0].y + 3 * u * u * t * c[1].y + 3 * u * t * t * c[2].y + t * t * t * c[3].y
    };
  }
  var routeIn = (p) => route(p.agent ? { x: Layout.AgentX + Layout.AgentW / 2, y: p.agent.y } : { x: Layout.Hub.x + Layout.HubR, y: Layout.Hub.y }, { x: p.left, y: p.y });
  function tailWeight(chips) {
    return Math.max(1, chips.reduce((sum, c) => sum + c.alpha, 0));
  }
  function tailChipWidth(n) {
    if (n <= 1) return Layout.TailW;
    const fit = (Layout.TailBudget - (n - 1) * Layout.TailGap) / n;
    return Math.max(Layout.TailMinW, Math.min(Layout.TailW, fit));
  }
  var routeOut = (p, outputOffsetY = 0, startX = p.right, outputOffsetX = 0) => route({ x: startX, y: p.y }, { x: Layout.Out.x - Layout.OutR + outputOffsetX, y: Layout.Out.y + outputOffsetY });
  var routeRejected = (p, outputOffsetY = 0, startX = p.right, outputOffsetX = 0) => route({ x: startX, y: p.y }, { x: Layout.Rej.x - 46 + outputOffsetX, y: Layout.Rej.y + outputOffsetY });
  var agentKey = (sessionId, agentId) => sessionId + ":" + agentId;
  function pillInfo(tool) {
    const p = tool.split("__");
    return p[0] === "mcp" && p.length >= 3 ? { key: "mcp:" + p[1], name: p[1] } : { key: tool, name: tool };
  }
  function colorOf(key) {
    if (key === "Skill") return Palette.Skill;
    if (key === "Task" || key === "Agent") return Palette.Task;
    let h = 0;
    for (let i = 0; i < key.length; i++) h = Math.imul(h, 31) + key.charCodeAt(i) | 0;
    return hslToHex(Math.abs(h) % 360, 0.85, 0.64);
  }
  function formatModel(m) {
    let s = (m ?? "").trim().replace(/^(?:codex|claude|openai|gemini)\s*[·:|]\s*/i, "");
    if (/^gpt-/i.test(s)) return ("GPT-" + s.slice(4).replaceAll("-", " ")).toUpperCase();
    s = s.replace(/^claude-/i, "");
    s = s.replace(/-(\d)-(\d)/g, " $1.$2").replaceAll("-", " ");
    return s.toUpperCase();
  }
  function ago(seconds) {
    const m = Math.floor(seconds / 60);
    if (m < 1) return "\u525B\u525B";
    if (m < 60) return m + " \u5206\u9418\u524D";
    const h = Math.floor(m / 60);
    return h < 48 ? h + " \u5C0F\u6642\u524D" : Math.floor(h / 24) + " \u5929\u524D";
  }
  function hslToHex(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(h / 60 % 2 - 1)), m = l - c / 2;
    const sec = Math.floor(h / 60);
    const [r, g, b] = sec === 0 ? [c, x, 0] : sec === 1 ? [x, c, 0] : sec === 2 ? [0, c, x] : sec === 3 ? [0, x, c] : sec === 4 ? [x, 0, c] : [c, 0, x];
    const hex = (v) => Math.round((v + m) * 255).toString(16).toUpperCase().padStart(2, "0");
    return "#" + hex(r) + hex(g) + hex(b);
  }
  var pad2 = (n) => String(n).padStart(2, "0");
  var hhmm = (ms) => {
    const d = new Date(ms);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };
  var hhmmss = (ms) => {
    const d = new Date(ms);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  };
  var num1 = (x) => String(Math.round(x * 10) / 10);
  var short = (s, n) => s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
  function limitText(hit) {
    return `\u5DF2\u9054 ${hit.limitType === "five_hour" ? "5 \u5C0F\u6642\u984D\u5EA6\u4E0A\u9650" : hit.limitType + " \u4E0A\u9650"} \xB7 ${hhmm(hit.resetsAt)} \u91CD\u7F6E`;
  }
  var FileTools = /* @__PURE__ */ new Set(["Read", "Edit", "Write", "MultiEdit"]);
  function fileNameOf(c) {
    if (!FileTools.has(c.tool)) return null;
    const path = c.summary.trim().replace(/…+$/, "");
    if (path.length === 0) return null;
    const name = path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);
    return name.length > 0 ? name : null;
  }
  function docName(c) {
    const n = fileNameOf(c);
    return n !== null && /\.(md|markdown)$/i.test(n) ? n : null;
  }
  function docText(c, name) {
    const verb = c.tool === "Read" ? "\u8B80\u53D6" : c.tool === "Write" ? "\u5BEB\u5165" : "\u7DE8\u8F2F";
    return `\u6587\u4EF6 ${short(name, 34)} \xB7 ${verb}`;
  }
  function ragText(c) {
    const action = ragActionOf(c.tool);
    if (action === null) return null;
    let summary = c.summary.trim();
    let wrote = false;
    if (isRagWrite(action)) {
      const m = /^dry_run=(true|false)\s*/.exec(summary);
      if (m) {
        wrote = m[1] === "false";
        summary = summary.slice(m[0].length);
      }
    }
    const value = summary.includes("=") && action !== "rag_search" ? summary.slice(summary.indexOf("=") + 1) : summary;
    const lastName = value.slice(Math.max(value.lastIndexOf("\\"), value.lastIndexOf("/")) + 1);
    switch (action) {
      case "rag_search":
        return value.length > 0 ? `RAG \u67E5\u8A62 \u25B8 ${short(value, 26)}` : "RAG \u67E5\u8A62";
      case "rag_sources":
        return "RAG \u5217\u51FA\u4F86\u6E90";
      case "rag_status":
        return "RAG \u67E5\u770B\u72C0\u614B";
      case "rag_tables":
        return "RAG \u67E5\u770B\u8CC7\u6599\u8868";
      case "rag_chunks":
        return lastName.length > 0 ? `RAG \u67E5\u770B\u7247\u6BB5 \u25B8 ${short(lastName, 24)}` : "RAG \u67E5\u770B\u7247\u6BB5";
      case "rag_chunk":
        return lastName.length > 0 ? `RAG \u8B80\u53D6\u7247\u6BB5 \u25B8 ${short(lastName, 26)}` : "RAG \u8B80\u53D6\u7247\u6BB5";
      case "rag_index":
        return `RAG \u7D22\u5F15${value.length > 0 ? " " + short(value, 18) : ""} \xB7 ${wrote ? "\u5BEB\u5165" : "\u8A66\u8DD1"}`;
      case "rag_remove":
        return `RAG \u522A\u9664${lastName.length > 0 ? " " + short(lastName, 20) : ""} \xB7 ${wrote ? "\u522A\u9664" : "\u8A66\u8DD1"}`;
      case "rag_ingest_note":
        return `RAG \u8A18\u9304\u7B46\u8A18${value.length > 0 ? " \u25B8 " + short(value, 18) : ""} \xB7 ${wrote ? "\u5BEB\u5165" : "\u8A66\u8DD1"}`;
      case "rag_todo":
        return "RAG \u53D6\u5F85\u6A19\u8A3B\u7247\u6BB5";
      case "rag_annotate":
        return "RAG \u5BEB\u6A19\u8A3B";
      default:
        return `RAG \u6E05\u7406${value.length > 0 ? " " + short(value, 18) : ""} \xB7 ${wrote ? "\u522A\u9664" : "\u8A66\u8DD1"}`;
    }
  }
  function toolStartText(c, name) {
    const file = fileNameOf(c);
    if (file !== null) return `${name} \u25B8 ${short(file, 30)}`;
    const parts = c.tool.split("__");
    const sub = parts[0] === "mcp" && parts.length >= 3 ? parts.slice(2).join("__") : "";
    const detail = (sub.length > 0 ? sub + " " : "") + c.summary;
    return detail.trim().length > 0 ? `${name} \u25B8 ${short(detail.trim(), 30)}` : name;
  }
  function failureText(c, name) {
    return `\u2715 ${name} \u5931\u6557` + (c.durationSeconds > 0 ? ` \xB7 ${num1(c.durationSeconds)}s` : "");
  }
  function agentText(a) {
    const id = a.agentId.length > 6 ? a.agentId.slice(0, 6) : a.agentId;
    const model2 = formatModel(a.model);
    return `\u5B50\u4EE3\u7406 ${id.toUpperCase()} \u555F\u52D5` + (model2.length > 0 ? ` \xB7 ${model2}` : "");
  }

  // src/core/flowSceneLayout.ts
  function flowSceneRows(models2) {
    const sizes = models2.filter((model2) => model2.busy || model2.isLive || model2.source > 5e-3 || model2.sink > 5e-3 || model2.pillList.some((p) => p.fade > 0.01)).map((model2) => ({ model: model2, height: Math.max(360, model2.columnHeight + 180) }));
    let top = -sizes.reduce((sum, row) => sum + row.height, 0) / 2;
    return sizes.map(({ model: model2, height }) => {
      const row = { model: model2, height, y: top + height / 2 };
      top += height;
      return row;
    });
  }
  function sharedOutputY(rows) {
    if (rows.length >= 3) return (rows[0].y + rows[rows.length - 1].y) / 2 - 44;
    const row = rows.find((r) => r.model.source > 5e-3) ?? rows.find((r) => r.model.sink > 5e-3) ?? rows[0];
    return (row?.y ?? 0) - 44;
  }
  var OutputShiftMax = 460;
  var OutputShiftGap = 28;
  function outputShiftFor(rightEdges, leftEdge) {
    if (rightEdges.length === 0) return 0;
    const need = Math.max(...rightEdges) + OutputShiftGap - leftEdge;
    return Math.min(OutputShiftMax, Math.max(0, need));
  }
  var OutputAnchor = class _OutputAnchor {
    /** 靠近比例：越大越快（每秒約剩下 e^-Rate 沒走完）。 */
    static Rate = 2;
    /** 最快每秒走多少世界單位，距離很遠時不會一下衝過去。 */
    static MaxSpeed = 450;
    /** 單次最多當成這麼多秒；久沒畫（閒置）之後的第一張不會因為時間差一次走完。 */
    static MaxStep = 0.1;
    /** 目前位置（Y 用於上下滑動，同一個類別也拿來做 X 的左右滑動）。 */
    y = 0;
    ready = false;
    /** 還沒到目標，畫面需要繼續高頻重畫。 */
    isMoving(target) {
      return this.ready && Math.abs(target - this.y) > 0.05;
    }
    /** 往目標走一步並回傳目前位置。第一次、`snap`（減少動態）時直接就位。 */
    update(target, dt, snap = false) {
      if (!this.ready || snap) {
        this.y = target;
        this.ready = true;
        return this.y;
      }
      const step = Math.min(Math.max(dt, 0), _OutputAnchor.MaxStep);
      const want = (target - this.y) * (1 - Math.exp(-step * _OutputAnchor.Rate));
      const cap = _OutputAnchor.MaxSpeed * step;
      this.y += Math.max(-cap, Math.min(cap, want));
      if (Math.abs(target - this.y) < 0.05) this.y = target;
      return this.y;
    }
  };

  // src/webview/brainGlyph.ts
  var BrainOutline = "M -45 5 C -51 -4 -45 -21 -35 -27 C -30 -38 -15 -42 -5 -40 C 7 -47 24 -39 31 -32 C 45 -29 51 -15 48 -4 C 54 8 43 23 31 24 C 26 33 12 33 3 25 C -7 30 -20 25 -25 18 C -35 23 -47 16 -45 5 Z M 12 27 C 10 34 14 41 20 47 L 28 43 C 22 37 22 31 26 27 Z";
  var BrainFolds = [
    "M -43 -7 C -34 -15 -29 -8 -33 -1 C -37 5 -29 10 -23 5 C -17 1 -15 9 -19 15",
    "M -35 -27 C -36 -17 -24 -24 -20 -17 C -17 -10 -25 -9 -25 -3",
    "M -19 -37 C -26 -30 -14 -30 -10 -26 C -6 -21 -13 -17 -8 -12",
    "M -5 -40 C -9 -33 4 -35 7 -28 C 9 -22 1 -20 5 -15 C 10 -8 19 -17 21 -8",
    "M 15 -40 C 22 -33 13 -30 18 -24 C 23 -19 30 -26 34 -19",
    "M 31 -32 C 30 -24 43 -24 42 -13 C 41 -6 34 -12 32 -5 C 30 1 39 3 44 -1",
    "M -42 9 C -35 4 -33 18 -25 18 M -23 5 C -19 -4 -9 -2 -11 5 C -13 13 -4 13 0 8",
    "M -25 18 C -15 15 -14 24 -6 22 C 1 19 -2 12 6 14",
    "M -7 -12 C -3 -6 -14 -7 -17 -2 M 5 -15 C -1 -10 8 -5 4 1 C 0 5 -4 -1 -8 3",
    "M 21 -8 C 25 -1 15 0 16 6 C 17 13 27 6 30 11",
    "M 32 -5 C 25 -10 29 -17 23 -19 M 1 8 C 5 1 14 6 10 13 C 7 19 11 23 15 22",
    "M 44 5 C 38 9 36 17 28 15 C 18 11 13 19 10 24",
    "M 3 25 C 11 18 25 19 33 23 M 9 27 C 16 23 24 25 29 27",
    "M 14 30 C 19 27 23 29 25 30 M 15 33 C 19 31 22 32 23 33",
    "M -43 -15 C -39 -19 -34 -15 -35 -10 M -11 -35 C -5 -30 -1 -34 2 -29"
  ];
  var BrainJunctions = [[-35, -27], [-20, -17], [-33, -1], [-23, 5], [-10, -26], [7, -28], [18, -24], [42, -13], [32, -5], [4, 1], [16, 6], [-6, 22], [30, 11], [15, 22]];

  // src/webview/armorGlyph.ts
  var ArmorPaths = {
    "UpperArm": "M -54 -4 L -38 -16 L -19 -4 L -7 21 L -17 37 L -37 24 Z",
    "UpperFacet": "M -48 -3 L -38 -10 L -24 -1 L -16 17 L -23 22 L -36 14 Z",
    "Forearm": "M -27 17 L -8 29 L 23 -10 L 9 -29 L -5 -17 Z",
    "ForeFacet": "M -16 13 L -7 18 L 15 -10 L 8 -20 L 1 -13 Z",
    "Fist": "M -3 -28 L -6 -44 L 0 -52 L 8 -52 L 12 -47 L 16 -54 L 25 -52 L 28 -47 L 35 -48 L 42 -40 L 40 -23 L 30 -13 L 12 -14 L 7 -20 L 1 -17 L -6 -22 Z",
    "Fingers": "M 4 -46 L 7 -35 M 17 -46 L 19 -34 M 30 -42 L 31 -32 M 11 -26 L 31 -26",
    "Thigh": "M -22 -52 L 6 -55 L 21 -39 L 10 -9 L -14 -6 L -24 -28 Z",
    "ThighFacet": "M -14 -44 L 3 -47 L 12 -35 L 4 -15 L -9 -15 L -16 -30 Z",
    "Shin": "M -17 -4 L 13 -4 L 23 25 L 10 39 L -13 28 L -22 9 Z",
    "ShinFacet": "M -10 4 L 6 4 L 14 24 L 7 29 L -7 22 L -14 10 Z",
    "Boot": "M -12 25 L 14 25 L 26 33 L 44 38 L 42 49 L -20 49 L -24 39 Z",
    "BootFacet": "M -12 34 L 10 33 L 24 40 L 36 42 L 35 44 L -17 44 Z"
  };

  // src/webview/render.ts
  var UI = '"Segoe UI Variable", "Segoe UI", "Microsoft JhengHei UI", system-ui, sans-serif';
  var MONO = '"Cascadia Mono", Consolas, "Microsoft JhengHei UI", monospace';
  var Breath = 800;
  var BrainShape = new Path2D(BrainOutline);
  var BrainFoldPaths = BrainFolds.map((path) => new Path2D(path));
  var ArmorShapes = Object.fromEntries(Object.entries(ArmorPaths).map(([key, path]) => [key, new Path2D(path)]));
  var ClickSlop = 4;
  var colorCache = /* @__PURE__ */ new Map();
  function rgba(hex, alpha = 1) {
    const a = Math.round(Math.min(1, Math.max(0, alpha)) * 64) / 64;
    const key = hex + "|" + a;
    let v = colorCache.get(key);
    if (!v) {
      const n = parseInt(hex.slice(1), 16);
      v = `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
      colorCache.set(key, v);
    }
    return v;
  }
  var BubbleMaxTextW = 300;
  var shorten = (s, n) => s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
  function rowLabel(c) {
    const parts = c.tool.split("__");
    const sub = parts[0] === "mcp" && parts.length >= 3 ? parts.slice(2).join("__") : "";
    return (sub.length > 0 ? sub + "  " : "") + c.summary;
  }
  function poly(...pts) {
    const p = new Path2D();
    pts.forEach(([x, y], i) => i === 0 ? p.moveTo(x, y) : p.lineTo(x, y));
    p.closePath();
    return p;
  }
  var HornGeo = (() => {
    const p = new Path2D();
    p.moveTo(2.2, -10.4);
    p.quadraticCurveTo(7.8, -10, 6.4, -16);
    return p;
  })();
  var ChestGeo = poly([-6, -5.5], [6, -5.5], [4.4, 4], [-4.4, 4]);
  var CrestGeo = poly([-1.2, -12.2], [1.2, -12.2], [0, -15.6]);
  var FlameGeo = poly([-1.4, 0], [1.4, 0], [0, 1]);
  var ChestSideGeo = poly([-3.4, -5.5], [3.4, -5.5], [2.6, 4], [-2.8, 4]);
  var CrestSideGeo = poly([-1.6, -12.2], [0.6, -12.2], [-0.6, -15.2]);
  var HornSideGeo = (() => {
    const p = new Path2D();
    p.moveTo(0.2, -11.8);
    p.quadraticCurveTo(5.2, -11.2, 5.4, -15.8);
    return p;
  })();
  var WingGeo = poly([0, 0], [8, -9], [21, -18], [18, -9], [22, -3], [15, -5], [16, 4], [9, 0], [9, 8], [2, 5]);
  var FootGeo = poly([-3.6, 0], [3.6, 0], [4, 2.4], [3.1, 2.4], [2.4, 5.4], [1.7, 2.4], [0.7, 2.4], [0, 5.8], [-0.7, 2.4], [-1.7, 2.4], [-2.4, 5.4], [-3.1, 2.4], [-4, 2.4]);
  var SideFootGeo = poly([-2.6, 0], [3.2, 0], [7.8, 1.5], [4.4, 1.5], [8.2, 3], [4, 2.7], [7.4, 4.5], [3.2, 3.6], [-2.6, 3.4]);
  var MonsterHornGeo = poly([-1, -12], [1, -12], [0, -17.6]);
  var BladeGeo = poly([2.4, -10.6], [8.8, -16.4], [5.6, -10.4], [3.8, -9.4]);
  var MonsterChestGeo = poly([-6.2, -5.8], [6.2, -5.8], [4.6, 3.6], [-4.6, 3.6]);
  var MonsterChestSideGeo = poly([-3.6, -5.8], [3.6, -5.8], [2.8, 3.6], [-3, 3.6]);
  var MuzzleGeo = poly([-2.8, -8.4], [2.8, -8.4], [1.6, -5.2], [-1.6, -5.2]);
  var SideMuzzleGeo = poly([2.2, -9.2], [6.2, -8.4], [5.6, -6.8], [2.4, -6.4]);
  var SideBladeGeo = poly([-0.8, -11.2], [-6, -15], [-2.4, -10.2]);
  var SideHornGeo = poly([0.6, -12], [2.4, -12], [3.8, -17.4]);
  var TailGeo = (() => {
    const p = new Path2D();
    p.moveTo(2, 9);
    p.bezierCurveTo(10, 11, 16, 7, 14.5, -0.5);
    return p;
  })();
  var SideTailGeo = (() => {
    const p = new Path2D();
    p.moveTo(-2.4, 7);
    p.bezierCurveTo(-9, 9, -14, 6, -15.5, 0);
    return p;
  })();
  var lerp = (a, b, t) => a + (b - a) * t;
  var sparkColor = (u, normal) => u.deliverTarget === "ok" ? Palette.Ok : u.deliverTarget === "fail" ? Palette.Fail : normal;
  var FlowRenderer = class {
    constructor(canvas2) {
      this.canvas = canvas2;
      this.ctx = canvas2.getContext("2d");
      canvas2.addEventListener("wheel", (e) => {
        e.preventDefault();
        this.camK = Math.min(3, Math.max(0.4, this.camK * (e.deltaY < 0 ? 1.1 : 0.9)));
      }, { passive: false });
      canvas2.addEventListener("dblclick", () => {
        this.camX = this.camY = 0;
        this.camK = 1;
      });
      canvas2.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        this.dragging = true;
        this.dragMoved = 0;
        this.dragFrom = { x: e.offsetX, y: e.offsetY };
        this.dragCam = { x: this.camX, y: this.camY };
        canvas2.setPointerCapture(e.pointerId);
      });
      canvas2.addEventListener("pointermove", (e) => {
        if (this.dragging) {
          this.dragMoved = Math.max(this.dragMoved, Math.hypot(e.offsetX - this.dragFrom.x, e.offsetY - this.dragFrom.y));
          if (this.dragMoved > ClickSlop) {
            this.camX = this.dragCam.x + e.offsetX - this.dragFrom.x;
            this.camY = this.dragCam.y + e.offsetY - this.dragFrom.y;
          }
          return;
        }
        const wp = this.toWorld(e.offsetX, e.offsetY);
        const hit = this.hitScene(wp);
        this.hoverPill = hit;
        this.hoverKey = hit?.key ?? null;
        canvas2.style.cursor = hit ? "pointer" : "default";
      });
      canvas2.addEventListener("pointerup", (e) => {
        if (!this.dragging) return;
        this.dragging = false;
        canvas2.releasePointerCapture(e.pointerId);
        if (this.dragMoved <= ClickSlop) {
          const wp = this.toWorld(e.offsetX, e.offsetY);
          const p = this.hitScene(wp);
          if (p) p.expanded = !p.expanded;
        }
      });
      canvas2.addEventListener("pointerleave", () => {
        if (!this.dragging) {
          this.hoverKey = null;
          this.hoverPill = null;
          canvas2.style.cursor = "default";
        }
      });
    }
    ctx;
    w = 0;
    h = 0;
    dpr = 1;
    fit = 1;
    camX = 0;
    /** 手／腳整組目前往右讓開的距離（由動畫迴圈慢慢滑過去）。 */
    outX = 0;
    camY = 0;
    camK = 1;
    ms = 0;
    hoverKey = null;
    model = null;
    rows = [];
    hoverPill = null;
    // 拖曳
    dragging = false;
    dragFrom = { x: 0, y: 0 };
    dragCam = { x: 0, y: 0 };
    dragMoved = 0;
    /** 把鏡頭對準世界座標 (wx, wy) 並放大到 k 倍（測試頁用，方便看機器人的細節）。 */
    focus(wx, wy, k) {
      const base = this.fit / this.camK;
      this.camK = k;
      this.camX = -wx * base * k;
      this.camY = -wy * base * k - 30;
    }
    /** 畫布大小改變（CSS 像素與裝置像素比）。 */
    resize(w, h, dpr) {
      this.w = w;
      this.h = h;
      this.dpr = dpr;
      this.canvas.width = Math.max(1, Math.round(w * dpr));
      this.canvas.height = Math.max(1, Math.round(h * dpr));
    }
    toWorld(x, y) {
      return { x: (x - (this.w / 2 + this.camX)) / this.fit + this.outX / 2, y: (y - (this.h / 2 + 30 + this.camY)) / this.fit };
    }
    hitScene(point) {
      if (this.rows.length === 0) return this.model?.hitPill(point.x, point.y) ?? null;
      for (const row of this.rows) {
        const pill = row.model.hitPill(point.x, point.y - row.y);
        if (pill) return pill;
      }
      return null;
    }
    /** `outputY`：手／腳整組目前的 Y（動畫迴圈慢慢滑過去的值）；沒給就直接用目標位置。 */
    renderScene(models2, ms, outputY, outputX = 0) {
      this.rows = flowSceneRows(models2);
      this.outX = outputX;
      const outY = outputY ?? sharedOutputY(this.rows);
      this.ms = ms;
      const c = this.ctx;
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.globalAlpha = 1;
      c.fillStyle = "#0b0d10";
      c.fillRect(0, 0, this.w, this.h);
      if (this.w < 10 || this.h < 10 || this.rows.length === 0) return;
      this.drawGrid();
      const height = this.rows.reduce((sum, row) => sum + row.height, 0);
      this.fit = Math.min(1.35, Math.max(0.1, Math.min(this.w / (1400 + outputX), (this.h - 100) / height))) * this.camK;
      c.save();
      c.translate(this.w / 2 + this.camX, this.h / 2 + 30 + this.camY);
      c.scale(this.fit, this.fit);
      c.translate(-outputX / 2, 0);
      for (const [rowIndex, row] of this.rows.entries()) {
        const m = row.model;
        m.outputOffsetY = outY - row.y;
        m.outputOffsetX = outputX;
        m.outputSlotOffset = rowIndex;
        c.save();
        c.translate(0, row.y);
        this.alpha(m.source, () => {
          this.drawChipEdges(m);
          this.drawChips(m);
          this.drawHub(m);
        });
        this.alpha(1, () => {
          this.drawEdges(m);
          this.drawPills(m);
          this.drawParticles(m);
          this.drawAliens(m);
          this.drawBubbles(m);
        });
        c.restore();
      }
      c.save();
      c.translate(outputX, outY);
      const visibleModels = this.rows.map((row) => row.model);
      this.alpha(Math.max(...visibleModels.map((m) => m.sink)), () => {
        this.drawOutputs(visibleModels);
        this.drawSummary(visibleModels);
      });
      c.restore();
      c.restore();
    }
    /**
     * 手／腳整組這一刻該往右讓多遠：看各方塊的尾巴標籤與說明泡泡伸到哪裡，擋到手／腳就讓開；
     * 全部消失後回傳 0（呼叫端用 OutputAnchor 讓它慢慢滑過去、再滑回來）。
     */
    requiredOutputShiftX(models2) {
      const edges = [];
      for (const m of models2) {
        for (const p of m.pillList) {
          if (p.fade < 0.01) continue;
          const end = m.tailEndX(p);
          if (end > p.right + 1) edges.push(end);
          for (const b of m.bubbles.items) {
            if (b.anchorKey !== p.key) continue;
            if (b.alpha(BubbleQueue.FadeSeconds) * p.fade < 0.02) continue;
            const text = this.fitText(b.text, BubbleMaxTextW, 11, false);
            edges.push(end + 18 + this.measure(text, 11, false, false) + 22);
          }
        }
      }
      return outputShiftFor(edges, Layout.Out.x - Layout.OutR - (AlienReachUnits * Layout.AlienUnit + 20));
    }
    // ── 小工具 ───────────────────────────────────────────────────────────
    alpha(a, draw) {
      if (a <= 5e-3) return;
      const c = this.ctx;
      c.save();
      c.globalAlpha *= Math.min(1, a);
      draw();
      c.restore();
    }
    rr(x, y, w, h, r) {
      this.ctx.beginPath();
      this.ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
    }
    fillRR(x, y, w, h, r, fill, stroke = null, lw = 1) {
      this.rr(x, y, w, h, r);
      if (fill) {
        this.ctx.fillStyle = fill;
        this.ctx.fill();
      }
      if (stroke) {
        this.ctx.strokeStyle = stroke;
        this.ctx.lineWidth = lw;
        this.ctx.stroke();
      }
    }
    circle(x, y, r, fill, stroke = null, lw = 1) {
      const c = this.ctx;
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      if (fill) {
        c.fillStyle = fill;
        c.fill();
      }
      if (stroke) {
        c.strokeStyle = stroke;
        c.lineWidth = lw;
        c.stroke();
      }
    }
    ellipse(x, y, rx, ry, fill, stroke = null, lw = 1) {
      const c = this.ctx;
      c.beginPath();
      c.ellipse(x, y, Math.max(0.01, rx), Math.max(0.01, ry), 0, 0, Math.PI * 2);
      if (fill) {
        c.fillStyle = fill;
        c.fill();
      }
      if (stroke) {
        c.strokeStyle = stroke;
        c.lineWidth = lw;
        c.stroke();
      }
    }
    lineSeg(x0, y0, x1, y1, stroke, lw, round = false) {
      const c = this.ctx;
      c.beginPath();
      c.moveTo(x0, y0);
      c.lineTo(x1, y1);
      c.strokeStyle = stroke;
      c.lineWidth = lw;
      c.lineCap = round ? "round" : "butt";
      c.stroke();
      c.lineCap = "butt";
    }
    fillPath(p, fill, stroke = null, lw = 1, round = false) {
      const c = this.ctx;
      if (fill) {
        c.fillStyle = fill;
        c.fill(p);
      }
      if (stroke) {
        c.strokeStyle = stroke;
        c.lineWidth = lw;
        c.lineCap = round ? "round" : "butt";
        c.stroke(p);
        c.lineCap = "butt";
      }
    }
    /** 文字以「垂直置中」的 y 定位。回傳寬度。 */
    text(s, x, yMid, size, hex, o = {}) {
      const c = this.ctx;
      c.font = `${o.bold ? "bold " : ""}${size}px ${o.mono ? MONO : UI}`;
      const width = c.measureText(s).width;
      const a = o.alpha ?? 1;
      if (a <= 4e-3) return width;
      c.textAlign = o.align ?? "left";
      c.textBaseline = "middle";
      c.fillStyle = rgba(hex, a);
      c.fillText(s, x, yMid);
      return width;
    }
    measure(s, size, bold, mono) {
      this.ctx.font = `${bold ? "bold " : ""}${size}px ${mono ? MONO : UI}`;
      return this.ctx.measureText(s).width;
    }
    /** 依像素寬度截短文字（中文字比英文寬），超過就以「...」結尾。 */
    fitText(s, maxWidth, size, mono = true) {
      if (this.measure(s, size, false, mono) <= maxWidth) return s;
      let n = s.length;
      while (n > 1 && this.measure(s.slice(0, n) + "...", size, false, mono) > maxWidth) n--;
      return s.slice(0, n) + "...";
    }
    bezier(p) {
      const path = new Path2D();
      path.moveTo(p[0].x, p[0].y);
      path.bezierCurveTo(p[1].x, p[1].y, p[2].x, p[2].y, p[3].x, p[3].y);
      return path;
    }
    /** 發光：在線條底下疊 3 層更寬、更淡的線。 */
    glowStroke(path, hex, alpha, radius) {
      if (radius < 0.8 || alpha < 0.01) return;
      const c = this.ctx;
      c.lineCap = "round";
      for (const [k, a] of [[1, 0.1], [0.55, 0.16], [0.25, 0.22]]) {
        c.strokeStyle = rgba(hex, alpha * a);
        c.lineWidth = radius * k;
        c.stroke(path);
      }
      c.lineCap = "butt";
    }
    glowRect(x, y, w, h, corner, hex, alpha, radius) {
      if (radius < 0.8 || alpha < 0.01) return;
      for (const [k, a] of [[0.9, 0.1], [0.5, 0.16], [0.22, 0.22]]) {
        this.rr(x, y, w, h, corner);
        this.ctx.strokeStyle = rgba(hex, alpha * a);
        this.ctx.lineWidth = radius * k;
        this.ctx.stroke();
      }
    }
    glowCircle(cx, cy, r, hex, alpha, radius) {
      if (radius < 0.8 || alpha < 0.01) return;
      const c = this.ctx;
      const a = Math.min(1, Math.max(0, alpha));
      const g = c.createRadialGradient(cx, cy, 0, cx, cy, r + radius);
      g.addColorStop(0, rgba(hex, 0.55 * a));
      g.addColorStop(r / (r + radius), rgba(hex, 0.55 * a));
      g.addColorStop(1, rgba(hex, 0));
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cy, r + radius, 0, Math.PI * 2);
      c.fill();
    }
    line(path, hex, width, alpha, glow) {
      const g = this.bezier(path);
      this.glowStroke(g, hex, alpha, glow);
      this.ctx.strokeStyle = rgba(hex, alpha);
      this.ctx.lineWidth = width;
      this.ctx.stroke(g);
    }
    // ── 主繪製 ───────────────────────────────────────────────────────────
    render(m, ms) {
      this.rows = [];
      this.model = m;
      this.ms = ms;
      const c = this.ctx;
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.globalAlpha = 1;
      c.fillStyle = "#0b0d10";
      c.fillRect(0, 0, this.w, this.h);
      if (this.w < 10 || this.h < 10) return;
      this.drawGrid();
      const half = Math.max(250, m.columnHeight / 2 + 70);
      this.fit = Math.min(1.35, Math.max(0.1, Math.min(this.w / 1400, (this.h - 90) / (half * 2 + 60)))) * this.camK;
      c.save();
      c.translate(this.w / 2 + this.camX, this.h / 2 + 30 + this.camY);
      c.scale(this.fit, this.fit);
      this.alpha(m.source, () => {
        this.drawChipEdges(m);
        this.drawChips(m);
        this.drawHub(m);
      });
      this.alpha(m.sink, () => {
        this.drawOutputs([m]);
        this.drawSummary([m]);
      });
      this.alpha(1, () => {
        this.drawEdges(m);
        this.drawPills(m);
        this.drawParticles(m);
        this.drawAliens(m);
        this.drawBubbles(m);
      });
      c.restore();
      this.drawLog(m);
      this.drawHeader(m);
      if (m.sink <= 0.05) {
        this.text("\u76EE\u524D\u6C92\u6709 AI \u5728\u57F7\u884C\u3002", this.w / 2, this.h / 2 - 12, 14, "#6b7685", { align: "center" });
        this.text("\u958B\u59CB\u57F7\u884C\u5F8C\uFF0C\u7BC0\u9EDE\u8207\u6D41\u52D5\u7C92\u5B50\u6703\u81EA\u52D5\u6D6E\u73FE\uFF1B\u505C\u6B62\u4E00\u6BB5\u6642\u9593\u5F8C\u6703\u6162\u6162\u6D88\u5931\u3002", this.w / 2, this.h / 2 + 12, 13, "#6b7685", { align: "center" });
      }
    }
    drawGrid() {
      const step = 38 * this.camK;
      const ox = ((this.w / 2 + this.camX) % step + step) % step;
      const oy = ((this.h / 2 + this.camY) % step + step) % step;
      this.ctx.fillStyle = rgba("#7cc4ff", 0.06);
      for (let x = ox; x < this.w; x += step) for (let y = oy; y < this.h; y += step) this.ctx.fillRect(x, y, 1.3, 1.3);
    }
    drawChipEdges(m) {
      m.sessions.forEach((s, i) => {
        const active = isActive(s.status);
        this.line(route({ x: Layout.ChipX + Layout.ChipW, y: m.chipY(i) }, { x: Layout.Hub.x - Layout.HubR, y: Layout.Hub.y }), Palette.Agent, 1.2, active ? 0.45 : 0.14, active ? 8 : 0);
      });
    }
    // 每個方塊的三條連線（主節點→方塊、方塊→輸出、方塊→REJECTED）都跟著該方塊淡出（乘上 fade）
    drawEdges(m) {
      for (const agent of m.agents) {
        if (agent.info.parentToolUseId === null) continue;
        const parent = m.agents.find((a) => a.info.sessionId === agent.info.sessionId && a.info.agentId === agent.info.parentAgentId);
        if (agent.info.parentAgentId.length > 0 && !parent) continue;
        const start = parent ? { x: Layout.AgentX + Layout.AgentW / 2, y: parent.y } : { x: Layout.Hub.x + Layout.HubR, y: Layout.Hub.y };
        this.line(route(start, { x: Layout.AgentX - Layout.AgentW / 2, y: agent.y }), Palette.Task, 1.2, 0.4 * agent.fade, 0);
      }
      for (const p of m.pillList) {
        if (p.fade < 0.01) continue;
        const lv = p.runLevel;
        const pulse = m.reduceMotion ? 0 : 0.1 * Math.sin(this.ms / Breath);
        this.line(routeIn(p), p.color, 1.2 + 0.8 * lv, (0.2 + (0.35 + pulse) * lv) * p.fade, 12 * lv * p.fade);
        const startX = m.tailEndX(p);
        this.line(routeOut(p, m.outputOffsetY, startX, m.outputOffsetX), p.color, 1, (0.1 + (p.ok > 0 ? 0.1 : 0)) * p.fade, 0);
        if (p.fail > 0) this.line(routeRejected(p, m.outputOffsetY, startX, m.outputOffsetX), Palette.Fail, 1, 0.12 * p.fade, 0);
      }
    }
    drawChips(m) {
      m.sessions.forEach((s, i) => {
        const y = m.chipY(i) - Layout.ChipH / 2;
        const active = isActive(s.status);
        const col = s.status === SessionStatus.Waiting ? Palette.Task : Palette.Agent;
        this.fillRR(Layout.ChipX, y, Layout.ChipW, Layout.ChipH, 7, rgba("#12161c"), rgba(col, active ? 0.9 : 0.35), 1.2);
        const dotR = 3.2 + (active && !m.reduceMotion ? 0.5 * Math.sin(this.ms / Breath) : 0);
        this.circle(Layout.ChipX + 12, y + Layout.ChipH / 2, dotR, rgba(active ? col : Palette.Dim));
        this.text(((m.providerLabel === "AI" ? s.provider || "Claude" : m.providerLabel) + " " + (s.sessionId.startsWith("codex:") ? s.sessionId.slice(6, 10) : s.sessionId.slice(0, 4))).toUpperCase(), Layout.ChipX + 24, y + Layout.ChipH / 2, 11, Palette.Text, { mono: true });
        this.circle(Layout.ChipX + Layout.ChipW, y + Layout.ChipH / 2, 3, rgba(col));
      });
    }
    drawPills(m) {
      this.drawAgentNodes(m);
      for (const p of m.pillList) {
        if (p.fade < 0.01) continue;
        const x = p.left, y = p.y - Layout.PillH / 2;
        const lv = p.runLevel;
        const runLabel = p.running > 0 && p.runSeconds > 1.2;
        const hover = this.rows.length > 0 ? p === this.hoverPill : p.key === this.hoverKey;
        this.alpha(p.intro * p.fade, () => {
          const corner = Math.min(16, p.h / 2);
          const glow = 6 + 6 * lv + (m.reduceMotion ? 0 : 3 * lv * Math.sin(this.ms / Breath)) + 8 * p.flash + (hover ? 8 : 0);
          this.glowRect(x, y, p.w, p.h, corner, p.color, 1, glow);
          this.fillRR(x, y, p.w, p.h, corner, rgba("#10141a"), rgba(p.color), 1.4 + 0.6 * Math.max(lv, hover ? 1 : 0));
          this.fillRR(x + 8, y + 6, 20, 20, 6, rgba(p.color, 0.25));
          this.text(p.name.slice(0, 1).toUpperCase(), x + 18, y + Layout.PillH / 2 + 1, 12, p.color, { bold: true, mono: true, align: "center" });
          this.text(shorten(p.name, 13), x + 36, y + Layout.PillH / 2, 12, Palette.Text);
          this.text(runLabel ? `\u2026${p.running}` : "\xD7" + p.count, x + p.w - 28, y + Layout.PillH / 2, 10, runLabel ? Palette.Warn : Palette.Sub, { mono: true, align: "right" });
          this.text(p.expanded ? "\u25BE" : "\u25B8", x + p.w - 14, y + Layout.PillH / 2, 10, hover ? Palette.Text : Palette.Dim, { mono: true, align: "center" });
          this.drawRows(p, x, y, corner);
          this.drawTail(m, p);
          this.circle(x, p.y, 3, rgba(p.color));
          this.circle(x + p.w, p.y, 3, rgba(p.color));
        });
      }
    }
    drawAgentNodes(m) {
      for (const a of m.agents) {
        if (a.fade < 0.01) continue;
        this.alpha(a.fade, () => {
          this.drawBrain(Layout.AgentX, a.y, 0.65, isActive(a.info.status), m.reduceMotion);
          this.text(formatModel(a.info.model), Layout.AgentX, a.y + 45, 10, "#c6f7ff", { bold: true, mono: true, align: "center" });
        });
      }
    }
    // 展開時：標題列下方列出最近幾筆「真實」呼叫（✓／✕／… 時間 內容 耗時）
    drawRows(p, x, y, corner) {
      const open = Math.min(1, Math.max(0, (p.h - Layout.PillH) / 24));
      if (open <= 0.02 || p.recent.length === 0 && !p.expanded) return;
      const c = this.ctx;
      c.save();
      this.rr(x, y, p.w, p.h, corner);
      c.clip();
      c.globalAlpha *= open;
      this.lineSeg(x + 10, y + Layout.PillH, x + p.w - 10, y + Layout.PillH, rgba(p.color, 0.25), 1);
      const chars = Math.max(8, Math.floor((p.w - 150) / 6.2));
      p.recent.forEach((cl, i) => {
        const cy = y + Layout.PillH + Layout.ExpandedPad / 2 + i * Layout.ExpandedRowH + Layout.ExpandedRowH / 2;
        const mark = cl.result === ToolResult.Ok ? "\u2713" : cl.result === ToolResult.Failed ? "\u2715" : "\u2026";
        this.text(mark, x + 14, cy, 10.5, cl.result === ToolResult.Ok ? Palette.Ok : cl.result === ToolResult.Failed ? Palette.Fail : Palette.Warn, { mono: true });
        this.text(hhmmss(cl.time), x + 28, cy, 10.5, Palette.Sub, { mono: true });
        this.text(shorten(rowLabel(cl), chars), x + 92, cy, 10.5, Palette.Text, { mono: true });
        this.text(cl.result === ToolResult.Running ? "\u2026" : num1(cl.durationSeconds) + "s", x + p.w - 12, cy, 10.5, Palette.Sub, { mono: true, align: "right" });
      });
      c.restore();
    }
    // 方塊尾巴的小標籤：執行中（橘、發光脈動）／剛成功（綠 ✓）／剛失敗（紅 ✕），結束一段時間後淡出
    drawTail(m, p) {
      const { chips, more } = m.tailOf(p);
      if (chips.length === 0) return;
      const W = tailChipWidth(tailWeight(chips)), H = Layout.TailH, gap = Layout.TailGap;
      let x = p.left + Layout.PillW + Layout.TailLead;
      this.lineSeg(p.left + Layout.PillW, p.y, x, p.y, rgba(p.color, 0.5), 1);
      chips.forEach((chip, i) => {
        const col = chip.state === "run" ? Palette.Task : chip.state === "ok" ? Palette.Ok : Palette.Fail;
        const y = p.y - H / 2;
        this.alpha(chip.alpha, () => {
          if (chip.state === "run") {
            const pulse = m.reduceMotion ? 0.5 : 0.5 + 0.5 * Math.sin(this.ms / Breath);
            this.glowRect(x, y, W, H, 6, col, 1, 5 + 5 * pulse);
          }
          this.fillRR(x, y, W, H, 6, rgba("#12161c"), rgba(col, chip.state === "run" ? 0.95 : 0.7), 1.2);
          const mark = chip.state === "run" ? "\u2026" : chip.state === "ok" ? "\u2713" : "\u2715";
          this.text(mark, x + 10, p.y, 10.5, col, { mono: true, bold: true, align: "center" });
          const secText = num1(chip.seconds) + "s";
          const room = W - 20 - 8 - this.measure(secText, 9.5, false, true) - 6;
          this.text(this.fitText(tailLabel(chip.call), room, 10), x + 20, p.y, 10, Palette.Text, { mono: true });
          this.text(secText, x + W - 6, p.y, 9.5, Palette.Sub, { mono: true, align: "right" });
        });
        if (i < chips.length - 1) this.lineSeg(x + W, p.y, x + W + gap, p.y, rgba(col, 0.4 * chip.alpha), 1);
        x += W + gap;
      });
      if (more > 0) this.text("+" + more, x, p.y, 10, Palette.Sub, { mono: true });
      this.circle(m.tailEndX(p), p.y, 3, rgba(p.color));
    }
    drawHub(m) {
      const { x, y } = Layout.Hub;
      this.drawBrain(x, y, 1, m.busy, m.reduceMotion);
      if (m.modelText.length > 0) this.text(m.modelText, x, y + 65, 15, "#c6f7ff", { bold: true, mono: true, align: "center" });
    }
    drawBrain(x, y, scale, busy, reduceMotion) {
      const phase = reduceMotion ? 0 : this.ms / (busy ? 700 : 1400);
      const breath = reduceMotion ? 1 : 1 + Math.sin(phase) * (busy ? 0.025 : 0.01);
      const bob = reduceMotion ? 0 : Math.sin(phase * 0.7) * 1.8 * scale;
      const c = this.ctx;
      c.save();
      c.translate(x, y + bob);
      c.scale(breath * scale, breath * scale);
      this.glowStroke(BrainShape, "#3de5ff", 0.7, 17);
      this.fillPath(BrainShape, rgba("#0a1d2c"), rgba("#62e6ff", 0.9), 1.8, true);
      BrainFoldPaths.forEach((path, i) => {
        const level = reduceMotion ? 0.6 : 0.45 + 0.45 * (1 + Math.sin(phase * 1.4 - i * 0.7)) / 2;
        this.fillPath(path, null, rgba(i % 3 === 0 ? "#c59aff" : "#38d9ef", level), 1.4, true);
      });
      BrainJunctions.forEach(([nx, ny], i) => {
        const pulse = reduceMotion ? 0.3 : Math.pow(Math.max(0, Math.sin(phase * 2 - i * 0.8)), 6);
        this.circle(nx, ny, 3.5 + pulse * 2, rgba("#3de5ff", 0.1 + pulse * 0.25));
        this.circle(nx, ny, 1.3 + pulse, rgba("#d4fbff", 0.45 + pulse * 0.55));
      });
      if (!reduceMotion) {
        const scanY = -44 + this.ms / (busy ? 2400 : 4800) % 1 * 92;
        c.save();
        c.clip(BrainShape);
        c.fillStyle = rgba("#71f4ff", 0.08);
        c.fillRect(-52, scanY - 9, 104, 10);
        this.lineSeg(-52, scanY, 52, scanY, rgba("#adfaff", 0.65), 1);
        c.restore();
      }
      c.restore();
    }
    drawOutputs(models2) {
      this.drawArmor(false, models2);
      this.drawArmor(true, models2);
      this.text("\u6210\u529F " + models2.reduce((n, m) => n + m.stats.ok, 0), Layout.Out.x, Layout.Out.y + 66, 12, Palette.Ok, { bold: true, mono: true, align: "center" });
      this.text("\u5931\u6557 " + models2.reduce((n, m) => n + m.stats.fail, 0), Layout.Rej.x, Layout.Rej.y + 66, 12, Palette.Fail, { bold: true, mono: true, align: "center" });
    }
    drawArmor(leg, models2) {
      const reduce = models2.every((m) => m.reduceMotion);
      const busy = models2.some((m) => m.busy);
      const flash = Math.max(...models2.map((m) => leg ? m.rejFlash : m.outFlash));
      const phase = reduce ? 0 : this.ms / (busy ? 500 : 1100);
      const angle = reduce ? 0 : Math.sin(phase) * (busy ? 4 : 1.2) + flash * (leg ? -6 : 7);
      const color = leg ? Palette.Fail : Palette.Ok;
      const anchor = leg ? Layout.Rej : Layout.Out;
      const pivot = leg ? { x: -3, y: -7 } : { x: -17, y: 24 };
      const c = this.ctx;
      c.save();
      c.translate(anchor.x, anchor.y);
      const plate = (shape, fill, bright = false) => {
        this.glowStroke(shape, color, bright ? 0.5 + flash : 0.2, bright ? 7 + flash * 10 : 4);
        this.fillPath(shape, rgba(fill), rgba(bright ? color : "#7090a8", 0.95), bright ? 1.5 : 1.1, true);
      };
      this.lineSeg(leg ? -46 : -54, 0, pivot.x, pivot.y, rgba(color, 0.6), 2);
      plate(leg ? ArmorShapes.Thigh : ArmorShapes.UpperArm, "#172635");
      plate(leg ? ArmorShapes.ThighFacet : ArmorShapes.UpperFacet, "#38536b");
      this.circle(pivot.x, pivot.y, 8, rgba("#0d1925"), rgba("#8da8bd"), 1.4);
      this.circle(pivot.x, pivot.y, 3, rgba(color, 0.6 + flash * 0.4));
      c.translate(pivot.x, pivot.y);
      c.rotate(angle * Math.PI / 180);
      c.translate(-pivot.x, -pivot.y);
      plate(leg ? ArmorShapes.Shin : ArmorShapes.Forearm, "#152938", true);
      plate(leg ? ArmorShapes.ShinFacet : ArmorShapes.ForeFacet, "#42657a");
      plate(leg ? ArmorShapes.Boot : ArmorShapes.Fist, "#243e52", true);
      if (leg) plate(ArmorShapes.BootFacet, "#55778d");
      else this.fillPath(ArmorShapes.Fingers, null, rgba("#a9d9ec", 0.8), 1.2, true);
      const u = reduce ? 0.5 : this.ms / (busy ? 1300 : 2600) % 1;
      const px = leg ? -3 + 11 * u : -16 + 30 * u;
      const py = leg ? -7 + 37 * u : 20 - 44 * u;
      this.circle(px, py, 6, rgba(color, 0.16));
      this.circle(px, py, 1.7, rgba("#e5ffff", 0.9));
      c.restore();
    }
    drawBubbles(m) {
      const h = 26, tail = 6, stackGap = 4;
      const stacked = /* @__PURE__ */ new Map();
      for (const b of m.bubbles.items) {
        if (b.anchorKey === BubbleAnchors.Hub) continue;
        const pill = m.pillList.find((p) => p.key === b.anchorKey);
        const agent = pill ? void 0 : m.agents.find((a) => a.key === b.anchorKey);
        if (!pill && m.agents.some((a) => a.key === b.anchorKey)) continue;
        if (!pill && !agent && !BubbleAnchors.isFixed(b.anchorKey)) continue;
        const nth = stacked.get(b.anchorKey) ?? 0;
        stacked.set(b.anchorKey, nth + 1);
        const dy = nth * (h + stackGap);
        const follow = pill?.fade ?? agent?.fade ?? (b.anchorKey === BubbleAnchors.Hub ? m.source : m.sink);
        const alpha = b.alpha(BubbleQueue.FadeSeconds) * follow;
        if (alpha < 0.02) continue;
        const text = this.fitText(b.text, BubbleMaxTextW, 11, false);
        const w = this.measure(text, 11, false, false) + 22;
        let bx, by;
        const tailPath = new Path2D();
        if (pill) {
          const edge = m.tailEndX(pill);
          bx = edge + 18;
          by = pill.y - h / 2 + dy;
          if (nth === 0) {
            tailPath.moveTo(edge + 5, pill.y);
            tailPath.lineTo(bx + 1, pill.y - tail);
            tailPath.lineTo(bx + 1, pill.y + tail);
            tailPath.closePath();
          }
        } else if (b.anchorKey === BubbleAnchors.Rejected) {
          const cy = Layout.Rej.y + m.outputOffsetY;
          bx = Layout.Rej.x + m.outputOffsetX - 105 - w;
          by = cy - h / 2 + dy;
          if (nth === 0) {
            tailPath.moveTo(Layout.Rej.x + m.outputOffsetX - 52, cy);
            tailPath.lineTo(bx + w - 1, cy - tail);
            tailPath.lineTo(bx + w - 1, cy + tail);
            tailPath.closePath();
          }
        } else {
          const hub = b.anchorKey === BubbleAnchors.Hub;
          const [cx, top, tipY, below] = agent ? [Layout.AgentX, agent.y - Layout.AgentH / 2 - 14 - h, agent.y - Layout.AgentH / 2 - 3, false] : hub ? [Layout.Hub.x, Layout.Hub.y - Layout.HubR - 18 - h, Layout.Hub.y - Layout.HubR - 5, false] : [Layout.Rej.x + m.outputOffsetX, Layout.Rej.y + 15 + 14, Layout.Rej.y + 17, true];
          bx = cx - w / 2;
          by = below ? top + dy : top - dy;
          if (nth === 0) {
            const baseY = below ? by + 1 : by + h - 1;
            tailPath.moveTo(cx, tipY);
            tailPath.lineTo(cx - tail, baseY);
            tailPath.lineTo(cx + tail, baseY);
            tailPath.closePath();
          }
        }
        this.alpha(alpha, () => {
          this.glowRect(bx, by, w, h, 9, b.color, 0.8, 6);
          this.fillPath(tailPath, rgba("#161b22"), rgba(b.color), 1.2);
          this.fillRR(bx, by, w, h, 9, rgba("#161b22"), rgba(b.color), 1.2);
          this.text(text, bx + w / 2, by + h / 2, 11, Palette.Text, { align: "center" });
        });
      }
    }
    drawParticles(m) {
      for (const pt of m.particles) {
        const p = m.pillList.find((x) => x.key === pt.pillKey);
        if (!p) continue;
        const startX = m.tailEndX(p);
        const path = pt.kind === "in" ? routeIn(p) : pt.kind === "out" ? routeOut(p, m.outputOffsetY, startX, m.outputOffsetX) : routeRejected(p, m.outputOffsetY, startX, m.outputOffsetX);
        for (let i = 8; i >= 0; i--) {
          const q = cubic(path, Math.min(1, Math.max(0, pt.t - i * 0.03)));
          const r = 4.6 - i * 0.4;
          this.circle(q.x, q.y, r, rgba(pt.color, (1 - i / 9) * 0.85));
        }
        const hd = cubic(path, Math.min(1, Math.max(0, pt.t)));
        this.glowCircle(hd.x, hd.y, 2.2, pt.color, 1, 12);
        this.circle(hd.x, hd.y, 2.2, "#ffffff");
      }
    }
    // ── 機器人 ───────────────────────────────────────────────────────────
    // 位置、動作權重、推進強度都來自 FlowModel；這裡只負責「依權重混合各關節角度」並畫外形。
    // 動作：站（待命）、坐（AI 停下來）、飛（移動中，身體往前倒、領頭那隻手舉起）、攻擊（側身對著執行中的工具出拳）、
    //       歡呼（成功，雙手舉起小跳）、受創（失敗，眼睛變紅、抖動後仰）。主機器人核心與眼睛是青色、子代理的是橘色。
    drawAliens(m) {
      for (const u of m.aliens) {
        if (u.isMonster) this.drawMonster(m, u);
        else this.drawAlien(m, u);
      }
    }
    // ── 怪獸機甲（子代理）────────────────────────────────────────────────────
    // 與主機器人共用同一套動作（位置、權重、出拳節奏都來自 FlowModel），只是外形不同：
    // 翅膀在飛行與攻擊時張開、平常收攏；尾巴微微擺動；左手是肩砲，右手是鉤爪。
    drawMonster(m, u) {
      if (u.alpha < 0.02) return;
      const Black = "#1a1d24", Gold = "#e8b84a", GoldDark = "#a67c1a", ClawGold = "#f4e2a0", Red = "#d8402a", RedDark = "#8e1f14", Blue = "#4a7fd4", BlueDark = "#2b4aa6", White = "#e9edf2", Steel = "#8e99a6";
      const c = this.ctx;
      const q = u.scale * Layout.AlienUnit;
      const accent = u.tint ?? Palette.Task;
      const eye = u.wHurt > 0.5 ? Palette.Fail : "#ff5a3a";
      const drop = 4.5 * u.wSit;
      const cy = u.y + u.bob + drop * q;
      const shake = m.reduceMotion ? 0 : Math.sin(this.ms / 18) * u.wHurt * 1.1;
      const deg = u.lean * 62 * u.wFly + u.tilt * 57 * 0.6 * (1 - u.wFly) - u.wHurt * 9 + u.wAttack * u.face * 7;
      const punch = u.wAttack * Math.max(u.punch, u.punchB);
      const turn = u.wAttack * Math.PI / 2;
      const fx = Math.cos(turn), sx = Math.sin(turn);
      const sideOnly = u.wAttack > 0.97;
      const spread = 0.55 + 0.45 * Math.max(u.wFly, u.wCheer, u.wAttack * 0.6);
      const flap = m.reduceMotion ? 0 : Math.sin(this.ms / 90) * 0.16 * u.wFly + Math.sin(this.ms / 380 + u.seed) * 0.04;
      c.save();
      c.globalAlpha *= Math.min(1, u.alpha);
      this.glowCircle(u.x, cy, 10 * q, accent, 0.5 + 0.3 * punch, 14 * q);
      c.translate(u.x, cy + 6 * q);
      c.rotate(deg * Math.PI / 180);
      c.translate(-u.x, -(cy + 6 * q));
      if (!sideOnly) {
        c.save();
        c.translate(u.x + shake * q, cy);
        c.scale(q * Math.max(fx, 0.03), q);
        for (const side of [-1, 1]) {
          c.save();
          c.translate(side * 4.6, -4.2);
          c.scale(side * spread, spread * (1 + flap));
          this.fillPath(WingGeo, rgba(Red), rgba(Gold), 0.7);
          for (const [x, y] of [[21, -18], [22, -3], [16, 4]]) this.lineSeg(0, 0, x, y, rgba(RedDark), 0.9, true);
          c.restore();
        }
        c.save();
        c.translate(0, Math.sin(this.ms / 300 + u.seed) * 0.4);
        this.fillPath(TailGeo, null, rgba(Blue), 2.4, true);
        c.restore();
        const flame = 2.2 + 5.5 * u.thrust + 3 * u.wFly + 0.9 * Math.sin(this.ms / 55 + u.x);
        for (const side of [-1, 1]) {
          const bx = side * (3.8 + 2.2 * u.wSit - 1.6 * u.wFly);
          const footY = 11.2 - drop;
          c.save();
          c.translate(bx, footY + 5.4);
          c.scale(1, flame);
          this.fillPath(FlameGeo, rgba("#ff8a3a", 0.6 + 0.4 * u.thrust));
          c.restore();
          this.fillRR(bx - 2.1, 4.5, 4.2, 7 - drop, 0.8, rgba(Black), rgba(Gold), 0.5);
          this.circle(bx, footY - 0.2, 1.7, rgba(White), rgba(Steel), 0.4);
          c.save();
          c.translate(bx, footY);
          this.fillPath(FootGeo, rgba(ClawGold), rgba(GoldDark), 0.5);
          c.restore();
        }
        this.fillRR(-4.8, 3.4, 9.6, 2.4, 0.6, rgba(Gold), rgba(GoldDark), 0.5);
        const lead = u.lean >= 0 ? 1 : -1;
        const aimDeg = Math.atan2(-u.aimX, u.aimY) * 180 / Math.PI;
        const tips = [{ x: 0, y: 0, p: 0 }, { x: 0, y: 0, p: 0 }];
        const arms = () => {
          for (const side of [-1, 1]) {
            let a = lerp(6, 22, u.wSit);
            a = lerp(a, side === lead ? 158 : 26, u.wFly);
            a = lerp(a, 165, u.wCheer);
            if (side === u.waveSide) a = lerp(a, 150 + 18 * Math.sin(this.ms / 110), u.wWave);
            a = lerp(a, 55 + 14 * Math.sin(this.ms / 60 + side), u.wHurt);
            let theta = -side * a;
            const p = side > 0 ? u.punch : u.punchB;
            const ext = 7.5 * p * u.wAttack;
            theta = lerp(theta, aimDeg - side * 6, u.wAttack);
            const len = 7 + ext;
            c.save();
            c.translate(side * 8.6, -2.5);
            c.rotate(theta * Math.PI / 180);
            c.translate(-side * 8.6, 2.5);
            this.fillRR(side * 8.6 - 1.9, -2.5, 3.8, len, 0.9, rgba(Black), rgba(Gold), 0.5);
            this.fillRR(side * 8.6 - 2, -2.5 + len * 0.45, 4, 1, 0.3, rgba(Gold));
            if (side < 0) {
              this.fillRR(side * 8.6 - 1.3, -2.5 + len, 2.6, 3.8, 0.6, rgba(Steel), rgba(Black), 0.5);
              this.fillRR(side * 8.6 - 1.7, -2.5 + len + 3.2, 3.4, 1, 0.3, rgba(Black));
            } else {
              this.circle(side * 8.6, -2.5 + len + 1.2, 2.3, rgba(Blue), rgba(BlueDark), 0.5);
              for (const dx of [-1.4, 0, 1.4]) {
                const cx = side * 8.6 + dx;
                this.fillPath(poly([cx - 0.5, -2.5 + len + 2.8], [cx + 0.5, -2.5 + len + 2.8], [cx, -2.5 + len + 5]), rgba(ClawGold), null, 0, false);
              }
            }
            c.restore();
            const rad = theta * Math.PI / 180;
            tips[side > 0 ? 1 : 0] = { x: side * 8.6 - (len + 5) * Math.sin(rad), y: -2.5 + (len + 5) * Math.cos(rad), p: p * u.wAttack };
          }
        };
        if (u.wAttack <= 0.5) arms();
        this.fillPath(MonsterChestGeo, rgba(Black), rgba(Gold), 0.6);
        this.fillPath(poly([-2.6, -5.4], [2.6, -5.4], [0, 1.8]), rgba(White));
        for (const side of [-1, 1]) {
          this.fillRR(side * 7.4 - 2.8, -6.8, 5.6, 4.6, 1.2, rgba(Black), rgba(Gold), 0.6);
          this.lineSeg(side * 5.2, -3.4, side * 3.6, -1, rgba(Gold), 0.8, true);
        }
        this.glowCircle(0, -1.8, 1.6, accent, 1, 5);
        this.circle(0, -1.8, 1.5 + 0.5 * punch, rgba(accent), rgba("#ffffff", 0.8), 0.4);
        if (u.wAttack > 0.5) arms();
        for (const side of [-1, 1]) {
          c.save();
          c.scale(side, 1);
          this.fillPath(BladeGeo, rgba(Gold), rgba(GoldDark), 0.5);
          c.restore();
        }
        this.ellipse(0, -9, 3.9, 3.6, rgba(Blue), rgba(BlueDark), 0.6);
        this.fillPath(MuzzleGeo, rgba(White), rgba(Steel), 0.4);
        this.fillRR(-3.2, -10.6, 6.4, 2.2, 0.9, rgba(Black));
        this.fillPath(MonsterHornGeo, rgba(Gold), rgba(GoldDark), 0.5);
        const look = m.reduceMotion ? 0 : Math.min(0.9, Math.max(-0.9, u.tilt * 3));
        for (const side of [-1, 1]) this.ellipse(side * 1.6 + look, -9.5, 0.95, 0.55, rgba(eye));
        for (const t of tips)
          if (t.p > 0.15 && u.wAttack < 0.5) this.glowCircle(t.x, t.y, 1.9 * (0.6 + 0.8 * t.p), sparkColor(u, "#ff9a4a"), Math.min(1, t.p * 1.2), 6);
        c.restore();
      }
      if (sx > 0.03) this.drawMonsterSide(u, q, cy, sx, accent, eye, spread, flap);
      c.restore();
    }
    drawMonsterSide(u, q, cy, sx, accent, eye, spread, flap) {
      const Black = "#1a1d24", Gold = "#e8b84a", GoldDark = "#a67c1a", ClawGold = "#f4e2a0", Red = "#d8402a", RedDark = "#8e1f14", Blue = "#4a7fd4", BlueDark = "#2b4aa6", White = "#e9edf2", Steel = "#8e99a6";
      const c = this.ctx;
      c.save();
      c.translate(u.x, cy);
      c.scale(q * sx * u.face, q);
      for (const [dx, dy, a] of [[-0.6, -3.6, 0.55], [-1.6, -4.2, 1]]) {
        c.save();
        c.translate(dx, dy);
        c.scale(-spread * (a === 1 ? 1 : 0.9), spread * (1 + flap) * (a === 1 ? 1 : 0.9));
        c.globalAlpha *= a === 1 ? 1 : 0.75;
        this.fillPath(WingGeo, rgba(a === 1 ? Red : RedDark), rgba(Gold), 0.7);
        for (const [x, y] of [[21, -18], [22, -3], [16, 4]]) this.lineSeg(0, 0, x, y, rgba(RedDark), 0.9, true);
        c.restore();
      }
      this.fillPath(SideTailGeo, null, rgba(Blue), 2.4, true);
      for (const [hx, th] of [[-1, 18], [1.2, -16]]) {
        c.save();
        c.translate(hx, 4.5);
        c.rotate(th * Math.PI / 180);
        c.translate(-hx, -4.5);
        this.fillRR(hx - 2, 4.5, 4, 7.5, 0.8, rgba(Black), rgba(Gold), 0.5);
        c.restore();
        const rad = th * Math.PI / 180;
        const tx = hx - 7.5 * Math.sin(rad), ty = 4.5 + 7.5 * Math.cos(rad);
        this.circle(tx, ty - 0.4, 1.6, rgba(White), rgba(Steel), 0.4);
        c.save();
        c.translate(tx, ty);
        this.fillPath(SideFootGeo, rgba(ClawGold), rgba(GoldDark), 0.5);
        c.restore();
      }
      this.fillRR(-3.6, 3.4, 7.2, 2.4, 0.6, rgba(Gold), rgba(GoldDark), 0.5);
      const tips = [];
      const arm = (px, py, p, far, cannon) => {
        const theta = lerp(-30, -92, p);
        const len = 7 + 7.5 * p;
        c.save();
        c.translate(px, py);
        c.rotate(theta * Math.PI / 180);
        c.translate(-px, -py);
        this.fillRR(px - 1.8, py, 3.6, len, 0.9, rgba(far ? "#10121a" : Black), rgba(Gold), 0.5);
        this.fillRR(px - 1.9, py + len * 0.45, 3.8, 1, 0.3, rgba(Gold));
        if (cannon) {
          this.fillRR(px - 1.2, py + len, 2.4, 4.2, 0.6, rgba(Steel), rgba(Black), 0.5);
          this.fillRR(px - 1.6, py + len + 3.6, 3.2, 1, 0.3, rgba(Black));
        } else {
          this.circle(px, py + len + 1.2, 2.1, rgba(far ? BlueDark : Blue), rgba(BlueDark), 0.5);
          for (const dx of [-1.2, 0, 1.2]) this.fillPath(poly([px + dx - 0.45, py + len + 2.6], [px + dx + 0.45, py + len + 2.6], [px + dx, py + len + 4.6]), rgba(ClawGold));
        }
        c.restore();
        const rad = theta * Math.PI / 180;
        tips.push({ x: px - (len + 5.2) * Math.sin(rad), y: py + (len + 5.2) * Math.cos(rad), p });
      };
      arm(-0.6, -3.2, u.punchB, true, false);
      this.fillPath(MonsterChestSideGeo, rgba(Black), rgba(Gold), 0.6);
      this.fillPath(poly([2.2, -5.2], [3.5, -5.2], [2.8, 2], [1.8, 2]), rgba(White));
      this.glowCircle(2.4, -1.6, 1.3, accent, 1, 4);
      this.circle(2.4, -1.6, 1.2, rgba(accent), rgba("#ffffff", 0.8), 0.4);
      arm(0.6, -3.4, u.punch, false, true);
      this.fillRR(-2.6, -7, 5.2, 4.6, 1.2, rgba(Black), rgba(Gold), 0.6);
      this.fillPath(SideBladeGeo, rgba(Gold), rgba(GoldDark), 0.5);
      this.ellipse(0.6, -9, 3.7, 3.5, rgba(Blue), rgba(BlueDark), 0.6);
      this.fillPath(SideMuzzleGeo, rgba(White), rgba(Steel), 0.4);
      this.fillRR(0.8, -10.8, 3.2, 2, 0.8, rgba(Black));
      this.fillPath(SideHornGeo, rgba(Gold), rgba(GoldDark), 0.5);
      this.ellipse(2.7, -9.8, 0.95, 0.55, rgba(eye));
      for (const t of tips)
        if (t.p > 0.15) this.glowCircle(t.x, t.y, 1.9 * (0.6 + 0.8 * t.p), sparkColor(u, "#ff9a4a"), Math.min(1, t.p * 1.2), 6);
      c.restore();
    }
    drawAlien(m, u) {
      if (u.alpha < 0.02) return;
      const Silver = "#c9d1da", SilverDark = "#8e99a6", Red = "#d8322b", RedLight = "#ff7a6a", Navy = "#2b4aa6", NavyLight = "#7aa0ff", Gold = "#f2c230", Dark = "#12161c";
      const c = this.ctx;
      const q = u.scale * Layout.AlienUnit;
      const accent = u.tint ?? "#7ff3ff";
      const eye = u.wHurt > 0.5 ? Palette.Fail : accent;
      const drop = 4.5 * u.wSit;
      const cy = u.y + u.bob + drop * q;
      const shake = m.reduceMotion ? 0 : Math.sin(this.ms / 18) * u.wHurt * 1.1;
      const deg = u.lean * 62 * u.wFly + u.tilt * 57 * 0.6 * (1 - u.wFly) - u.wHurt * 9 + u.wAttack * u.face * 7;
      const punch = u.wAttack * Math.max(u.punch, u.punchB);
      const turn = u.wAttack * Math.PI / 2;
      const fx = Math.cos(turn), sx = Math.sin(turn);
      const sideOnly = u.wAttack > 0.97;
      c.save();
      c.globalAlpha *= Math.min(1, u.alpha);
      this.glowCircle(u.x, cy, 9 * q, accent, 0.6 + 0.3 * punch, 14 * q);
      c.translate(u.x, cy + 6 * q);
      c.rotate(deg * Math.PI / 180);
      c.translate(-u.x, -(cy + 6 * q));
      if (!sideOnly) {
        c.save();
        c.translate(u.x + shake * q, cy);
        c.scale(q * Math.max(fx, 0.03), q);
        const flame = 2.2 + 5.5 * u.thrust + 3 * u.wFly + 0.9 * Math.sin(this.ms / 55 + u.x);
        for (const side of [-1, 1]) {
          const bx = side * (3.4 + 2.2 * u.wSit - 1.6 * u.wFly);
          c.save();
          c.translate(bx, 14 - drop);
          c.scale(1, flame);
          this.fillPath(FlameGeo, rgba("#ffb347", 0.6 + 0.4 * u.thrust));
          c.restore();
          this.fillRR(bx - 1.8, 4.5, 3.6, 7 - drop, 0.8, rgba(Silver), rgba(SilverDark), 0.6);
          this.fillRR(bx - 2.6, 10.8 - drop, 5.2, 3.4, 1, rgba(Navy), rgba(NavyLight), 0.6);
        }
        c.fillStyle = rgba(Dark);
        c.fillRect(-4.6, 3.6, 9.2, 2.6);
        const lead = u.lean >= 0 ? 1 : -1;
        const aimDeg = Math.atan2(-u.aimX, u.aimY) * 180 / Math.PI;
        const tips = [{ x: 0, y: 0, p: 0 }, { x: 0, y: 0, p: 0 }];
        const arms = () => {
          for (const side of [-1, 1]) {
            let a = lerp(6, 22, u.wSit);
            a = lerp(a, side === lead ? 158 : 26, u.wFly);
            a = lerp(a, 165, u.wCheer);
            if (side === u.waveSide) a = lerp(a, 150 + 18 * Math.sin(this.ms / 110), u.wWave);
            a = lerp(a, 55 + 14 * Math.sin(this.ms / 60 + side), u.wHurt);
            let theta = -side * a;
            const p = side > 0 ? u.punch : u.punchB;
            const ext = 7.5 * p * u.wAttack;
            theta = lerp(theta, aimDeg - side * 6, u.wAttack);
            const len = 7 + ext;
            c.save();
            c.translate(side * 8.4, -2.5);
            c.rotate(theta * Math.PI / 180);
            c.translate(-side * 8.4, 2.5);
            this.fillRR(side * 8.4 - 1.5, -2.5, 3, len, 0.8, rgba(Silver), rgba(SilverDark), 0.6);
            this.circle(side * 8.4, -2.5 + len + 1.1, 2.1, rgba(Navy), rgba(NavyLight), 0.6);
            this.ellipse(side * 8.4, -2.5 + len + 3.2, 3.4, 1.1, rgba("#e6e9ee"), rgba(Gold), 0.6);
            c.restore();
            const rad = theta * Math.PI / 180;
            tips[side > 0 ? 1 : 0] = { x: side * 8.4 - (len + 4) * Math.sin(rad), y: -2.5 + (len + 4) * Math.cos(rad), p: p * u.wAttack };
          }
        };
        if (u.wAttack <= 0.5) arms();
        this.fillPath(ChestGeo, rgba(Red), rgba(RedLight), 0.6);
        for (const side of [-1, 1]) this.fillRR(side * 7.2 - 2.4, -6.2, 4.8, 4.2, 1.2, rgba(Red), rgba(RedLight), 0.6);
        this.glowCircle(0, -0.8, 2.2, accent, 1, 5);
        this.circle(0, -0.8, 2 + 0.5 * punch, rgba(accent), rgba("#ffffff", 0.8), 0.5);
        if (u.wAttack > 0.5) arms();
        this.ellipse(0, -9, 3.9, 3.5, rgba(Silver), rgba(SilverDark), 0.6);
        for (const side of [-1, 1]) {
          c.save();
          c.scale(side, 1);
          this.fillPath(HornGeo, null, rgba(Gold), 1.5, true);
          c.restore();
        }
        this.fillPath(CrestGeo, rgba(Red));
        this.fillRR(-2.8, -10.4, 5.6, 2.4, 1, rgba(Dark));
        const look = m.reduceMotion ? 0 : Math.min(0.9, Math.max(-0.9, u.tilt * 3));
        for (const side of [-1, 1]) this.ellipse(side * 1.4 + look, -9.2, 0.95, 0.6, rgba(eye));
        for (const t of tips)
          if (t.p > 0.15 && u.wAttack < 0.5) this.glowCircle(t.x, t.y, 1.8 * (0.6 + 0.8 * t.p), sparkColor(u, "#ffd36b"), Math.min(1, t.p * 1.2), 6);
        c.restore();
      }
      if (sx > 0.03) this.drawAlienSide(u, q, cy, sx, accent, eye);
      c.restore();
    }
    // ── 側面剪影（攻擊用）：面向 +x，原點＝胸口中心；face＝−1 時整個鏡射 ──────────────────────
    drawAlienSide(u, q, cy, sx, accent, eye) {
      const Silver = "#c9d1da", SilverDark = "#8e99a6", Red = "#d8322b", RedLight = "#ff7a6a", Navy = "#2b4aa6", NavyDark = "#1f3680", NavyLight = "#7aa0ff", Gold = "#f2c230", Dark = "#12161c", Pack = "#3a4452";
      const c = this.ctx;
      c.save();
      c.translate(u.x, cy);
      c.scale(q * sx * u.face, q);
      const flame = 2 + 4.5 * u.thrust + 0.9 * Math.sin(this.ms / 55 + u.x);
      c.save();
      c.translate(-4.6, 2.2);
      c.rotate(28 * Math.PI / 180);
      c.scale(1.2, flame);
      this.fillPath(FlameGeo, rgba("#ffb347", 0.6 + 0.4 * u.thrust));
      c.restore();
      this.fillRR(-6.4, -6, 3.4, 8.4, 1, rgba(Pack), rgba(SilverDark), 0.6);
      for (const [hx, th] of [[-1, 18], [1.2, -16]]) {
        c.save();
        c.translate(hx, 4.5);
        c.rotate(th * Math.PI / 180);
        c.translate(-hx, -4.5);
        this.fillRR(hx - 1.7, 4.5, 3.4, 7.5, 0.8, rgba(Silver), rgba(SilverDark), 0.6);
        c.restore();
        const rad = th * Math.PI / 180;
        const tx = hx - 7.5 * Math.sin(rad), ty = 4.5 + 7.5 * Math.cos(rad);
        this.fillRR(tx - 2.4, ty - 0.6, 6.4, 3.2, 1, rgba(Navy), rgba(NavyLight), 0.6);
      }
      c.fillStyle = rgba(Dark);
      c.fillRect(-3.2, 3.4, 6.4, 2.6);
      const tips = [];
      const arm = (px, py, p, far) => {
        const theta = lerp(-30, -92, p);
        const len = 7 + 7.5 * p;
        c.save();
        c.translate(px, py);
        c.rotate(theta * Math.PI / 180);
        c.translate(-px, -py);
        this.fillRR(px - 1.4, py, 2.8, len, 0.8, rgba(far ? SilverDark : Silver), rgba(SilverDark), 0.6);
        this.circle(px, py + len + 1.1, 2, rgba(far ? NavyDark : Navy), rgba(NavyLight), 0.6);
        this.ellipse(px, py + len + 3.2, 3.4, 1.1, rgba(far ? "#aab2bd" : "#e6e9ee"), rgba(Gold), 0.6);
        c.restore();
        const rad = theta * Math.PI / 180;
        tips.push({ x: px - (len + 4) * Math.sin(rad), y: py + (len + 4) * Math.cos(rad), p });
      };
      arm(-0.6, -3.2, u.punchB, true);
      this.fillPath(ChestSideGeo, rgba(Red), rgba(RedLight), 0.6);
      this.glowCircle(2.2, -0.8, 1.5, accent, 1, 4);
      this.circle(2.2, -0.8, 1.3, rgba(accent), rgba("#ffffff", 0.8), 0.4);
      arm(0.6, -3.4, u.punch, false);
      this.circle(0, -4.2, 2.7, rgba(Red), rgba(RedLight), 0.6);
      this.ellipse(0.6, -9, 3.6, 3.5, rgba(Silver), rgba(SilverDark), 0.6);
      this.fillPath(HornSideGeo, null, rgba(Gold), 1.5, true);
      this.fillPath(CrestSideGeo, rgba(Red));
      this.fillRR(1, -10.3, 3, 2.4, 1, rgba(Dark));
      this.ellipse(2.7, -9.1, 0.95, 0.6, rgba(eye));
      for (const t of tips)
        if (t.p > 0.15) this.glowCircle(t.x, t.y, 1.8 * (0.6 + 0.8 * t.p), sparkColor(u, "#ffd36b"), Math.min(1, t.p * 1.2), 6);
      c.restore();
    }
    // 右下摘要卡
    drawSummary(models2) {
      const m = models2[0];
      const x = 330, y = 190, w = 290, h = 92;
      this.fillRR(x, y, w, h, 10, rgba("#10141a", 0.92), rgba("#232a33"), 1);
      this.circle(x + 16, y + 18, 3, rgba(Palette.Ok));
      this.text(`WINDOW \xB7 ${m.windowMinutes} MIN`, x + 26, y + 18, 10, Palette.Sub, { mono: true });
      this.text(`${models2.reduce((n, m2) => n + m2.stats.total, 0)} \u6B21\u547C\u53EB`, x + 16, y + 49, 30, Palette.Text, { bold: true });
      this.text(`${models2.reduce((n, m2) => n + m2.agents.length, 0)} \u5B50\u4EE3\u7406 \xB7 ${models2.reduce((n, m2) => n + m2.pillList.length, 0)} \u5DE5\u5177\u7BC0\u9EDE \xB7 ${models2.reduce((n, m2) => n + m2.stats.running, 0)} \u57F7\u884C\u4E2D`, x + 16, y + 76, 11, Palette.Sub);
    }
    // 底部日誌：最近 3 筆真實呼叫（螢幕座標，不隨縮放），屬於 output，最後才淡出
    drawLog(m) {
      const log = m.log.slice(0, 3).reverse();
      log.forEach((c, i) => {
        const mark = c.result === ToolResult.Ok ? "\u2713" : c.result === ToolResult.Failed ? "\u2715" : "\u2026";
        const line = `${hhmmss(c.time)}  ${mark}  ${pillInfo(c.tool).name}  ${shorten(c.summary, 70)}`;
        this.text(line, 16, this.h - 14 - (log.length - 1 - i) * 16 - 6, 11, Palette.Sub, { alpha: (0.45 + 0.18 * i) * m.sink, mono: true });
      });
    }
    // 頂部：標題（固定）、統計數字（屬於 output，最後才淡出）、LIVE／IDLE 徽章、模型
    drawHeader(m) {
      const c = this.ctx;
      const g = c.createLinearGradient(0, 0, 0, 62);
      g.addColorStop(0, "#0b0d10");
      g.addColorStop(1, "rgba(11,13,16,0)");
      c.fillStyle = g;
      c.fillRect(0, 0, this.w, 62);
      const narrow = this.w < 640;
      const tiny = this.w < 260;
      let tx = 18;
      if (!tiny) tx += this.text("\u25C8", tx, 24, 13, Palette.Agent) + 10;
      tx += this.text(m.providerLabel.toUpperCase() + " FLOW", tx, 24, 12, Palette.Text, { bold: true }) + 10;
      if (narrow) {
        const s2 = m.stats;
        const dot = m.isLive ? Palette.Ok : Palette.Warn;
        this.text(tiny ? "\u25CF" : m.isLive ? "\u25CF LIVE" : "\u25CF IDLE", this.w - 14, 24, 11, dot, { bold: true, align: "right" });
        const variants = [
          `\u57F7\u884C\u4E2D ${s2.running} \xB7 \u5931\u6557 ${s2.fail} \xB7 \u6210\u529F ${s2.ok} \xB7 \u5171 ${s2.total} \xB7 \u6D3B\u8E8D ${m.activeSessions}`,
          `\u57F7\u884C ${s2.running} \xB7 \u5931\u6557 ${s2.fail} \xB7 \u6210\u529F ${s2.ok} \xB7 \u5171 ${s2.total}`,
          `${s2.running} \u57F7\u884C \xB7 ${s2.fail} \u5931\u6557 \xB7 ${s2.ok} \u6210\u529F`
        ];
        const line = variants.find((v) => this.measure(v, 10.5, false, false) <= this.w - 28) ?? variants[2];
        this.text(line, 18, 46, 10.5, Palette.Sub, { alpha: m.sink });
        return;
      }
      this.text("\u672C\u6A5F " + m.providerLabel, tx, 24, 12, "#6b7685");
      let x = this.w - 18;
      if (m.modelText.length > 0) {
        const wd = this.measure(m.modelText, 11, true, true) + 20;
        this.fillRR(x - wd, 12, wd, 24, 12, rgba("#161b22"), rgba("#2a323c"), 1);
        this.text(m.modelText, x - wd / 2, 24, 11, Palette.Text, { bold: true, mono: true, align: "center" });
        x -= wd + 22;
      }
      x -= this.text(m.liveText, x, 24, 11, m.isLive ? Palette.Ok : Palette.Warn, { bold: true, align: "right" }) + 22;
      const s = m.stats;
      const cols = [
        [String(s.running), "\u57F7\u884C\u4E2D", Palette.Warn],
        [String(s.fail), "\u5931\u6557", Palette.Fail],
        [String(s.ok), "\u6210\u529F", Palette.Ok],
        [String(s.total), "\u5DE5\u5177\u547C\u53EB", Palette.Text],
        [String(m.activeSessions), "\u6D3B\u8E8D session", Palette.Text]
      ];
      for (const [num, label, hex] of cols) {
        const wd = Math.max(this.measure(num, 20, true, false), this.measure(label, 10, false, false));
        this.text(num, x - wd / 2, 18, 20, hex, { alpha: m.sink, bold: true, align: "center" });
        this.text(label, x - wd / 2, 38, 10, "#6b7685", { alpha: m.sink, align: "center" });
        x -= wd + 22;
      }
    }
  };

  // src/webview/main.ts
  var vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
  var $ = (id) => document.getElementById(id);
  var model = new FlowModel({ provider: "Claude" });
  var codexModel = new FlowModel({ provider: "Codex" });
  var models = [model, codexModel];
  var canvas = $("flow");
  var stage = $("stage");
  canvas.setAttribute("aria-label", "AI \u5171\u540C\u684C\u5E03\uFF1A\u6A21\u578B\u4F9D\u9996\u6B21\u51FA\u73FE\u9806\u5E8F\u7531\u4E0A\u5F80\u4E0B\u6392\u5217");
  var renderer = new FlowRenderer(canvas);
  renderer.model = model;
  var motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  models.forEach((m) => {
    m.reduceMotion = motion.matches;
  });
  motion.addEventListener("change", () => {
    model.reduceMotion = motion.matches;
    models.forEach((m) => {
      m.reduceMotion = motion.matches;
    });
  });
  function renderStatus(s) {
    const notice = $("notice");
    const home = !s.claudeHomeFound && !s.codexHomeFound ? `\u627E\u4E0D\u5230 .claude \u8CC7\u6599\u593E\uFF1A${s.claudeHome}` : "";
    const text = home;
    notice.hidden = text.length === 0;
    notice.textContent = text;
    notice.className = "notice" + (home ? " warn" : "");
    const active = s.sessions.filter((x) => isActive(x.status)).length;
    const activeAgents = s.agents.filter((a) => isActive(a.status)).length;
    const sources = [s.claudeHomeFound ? "Claude" : "", s.codexHomeFound ? "Codex" : ""].filter(Boolean).join(" + ");
    $("status").textContent = sources ? `\u5DF2\u8B80\u53D6\u672C\u6A5F ${sources}  \xB7  \u6D3B\u8E8D ${active} / ${s.sessions.length} \u500B session  \xB7  ${activeAgents} \u500B\u6D3B\u8E8D\u5B50\u4EE3\u7406  \xB7  ${s.recentToolCalls.length} \u7B46\u5DE5\u5177\u547C\u53EB` : "\u5C1A\u672A\u627E\u5230\u672C\u6A5F\u9010\u5B57\u7A3F\u8CC7\u6599\u593E";
  }
  var maxFps = 30;
  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (msg.type === "snapshot" && msg.snapshot) applySnapshot(msg.snapshot);
    else if (msg.type === "config") {
      if (typeof msg.bubbles === "boolean") {
        model.bubbles.enabled = msg.bubbles;
        models.forEach((m) => {
          m.bubbles.enabled = msg.bubbles;
        });
        $("bubbles").checked = msg.bubbles;
      }
      if (typeof msg.freeIdle === "boolean") {
        model.freeIdle = msg.freeIdle;
        models.forEach((m) => {
          m.freeIdle = msg.freeIdle;
        });
      }
      if (typeof msg.maxFps === "number") maxFps = Math.min(60, Math.max(10, msg.maxFps));
    }
  });
  function applySnapshot(s) {
    const providers = snapshotProviders(s);
    const sessions = s.sessions.filter((x) => isActive(x.status)).concat(s.sessions);
    for (const session of sessions) {
      const provider = sessionProvider(session);
      const name = session.model;
      if (models.some((m) => m.providerLabel === provider && m.modelKey === name)) continue;
      const existing = models.find((m) => m.providerLabel === provider && m.modelKey === void 0);
      const next = existing ?? new FlowModel({ provider, modelKey: name, freeIdle: model.freeIdle });
      if (existing) {
        existing.bindModel(name);
        models.splice(models.indexOf(existing), 1);
      } else {
        next.reduceMotion = model.reduceMotion;
        next.bubbles.enabled = model.bubbles.enabled;
      }
      const firstUnbound = models.findIndex((m) => m.modelKey === void 0);
      models.splice(firstUnbound < 0 ? models.length : firstUnbound, 0, next);
    }
    for (const provider of providers) {
      if (!models.some((m) => m.providerLabel === provider)) {
        const next = new FlowModel({ provider, freeIdle: model.freeIdle });
        next.reduceMotion = model.reduceMotion;
        next.bubbles.enabled = model.bubbles.enabled;
        models.push(next);
      }
      const primary = models.find((m) => m.providerLabel === provider);
      Object.assign(window.flowModels, { [provider]: primary });
    }
    models.forEach((m) => m.sync(s));
    for (let i = models.length - 1; i >= 0; i--) {
      const m = models[i];
      if (m.modelKey !== void 0 && m.sessions.length === 0 && !m.animating && !providerSnapshot(s, m.providerLabel, m.modelKey).sessions.length) models.splice(i, 1);
    }
    renderStatus(s);
  }
  window.applySnapshot = applySnapshot;
  window.flowModel = model;
  window.flowRenderer = renderer;
  Object.assign(window, { flowModels: { Claude: model, Codex: codexModel } });
  document.getElementById("settings")?.addEventListener("click", () => vscode?.postMessage({ type: "openSettings" }));
  $("bubbles").addEventListener("change", (e) => {
    model.bubbles.enabled = e.target.checked;
    models.forEach((m) => {
      m.bubbles.enabled = e.target.checked;
    });
  });
  var MaxDpr = 1.5;
  var resize = () => {
    const r = stage.getBoundingClientRect();
    renderer.resize(Math.max(1, Math.floor(r.width)), Math.max(1, Math.floor(r.height)), Math.min(MaxDpr, window.devicePixelRatio || 1));
  };
  var observer = new ResizeObserver(resize);
  observer.observe(stage);
  resize();
  var renderStats = { frames: 0, ms: 0 };
  window.renderStats = renderStats;
  var outputAnchor = new OutputAnchor();
  var outputAnchorX = new OutputAnchor();
  var targetX = 0;
  var lastDraw = 0;
  var frame = (ts) => {
    const moving = outputAnchor.isMoving(sharedOutputY(flowSceneRows(models))) || outputAnchorX.isMoving(targetX);
    const interval = models.some((m) => m.animating) || moving ? 1e3 / maxFps : 1e3;
    if (lastDraw === 0 || ts - lastDraw >= interval - 2) {
      const dt = lastDraw === 0 ? 0 : (ts - lastDraw) / 1e3;
      lastDraw = ts;
      const t0 = performance.now();
      targetX = renderer.requiredOutputShiftX(models);
      const outputX = outputAnchorX.update(targetX, dt, models.every((m) => m.reduceMotion));
      models.forEach((m) => {
        m.outputOffsetX = outputX;
      });
      const rows = flowSceneRows(models);
      const outputY = outputAnchor.update(sharedOutputY(rows), dt, models.every((m) => m.reduceMotion));
      rows.forEach((row, i) => {
        row.model.outputOffsetY = outputY - row.y;
        row.model.outputSlotOffset = i;
      });
      models.forEach((m) => m.tick(dt, Date.now()));
      renderer.renderScene(models, ts, outputY, outputX);
      renderStats.frames++;
      renderStats.ms += performance.now() - t0;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  vscode?.postMessage({ type: "ready" });
})();
