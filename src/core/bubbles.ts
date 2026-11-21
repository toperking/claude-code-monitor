// 說明泡泡的出現、合併、限流與壽命（對應 C# 的 Core/Flow/BubbleQueue.cs）。
// 泡泡是最容易讓畫面變吵的東西，所以規則集中在這裡並且有單元測試：
// 同時最多 MaxVisible 顆；同一個方塊密集的「工具開始」合併成「名稱 ×N」；
// 名額滿了就先擠掉最舊的「工具開始」，失敗與子代理（較重要）不被它擠掉；淡入淡出各 FadeSeconds 秒。

export type BubbleKind = 'toolStart' | 'failure' | 'agent' | 'status' | 'limit' | 'doc' | 'rag';

/** 不屬於方塊或子代理的固定指向位置。 */
export const BubbleAnchors = {
  /** AI 主節點。 */
  Hub: '@hub',
  /** 右側的 REJECTED 方塊。 */
  Rejected: '@rejected',
  isFixed: (key: string): boolean => key === '@hub' || key === '@rejected',
};

/** 一顆說明泡泡。文字只來自逐字稿裡真實發生的事件，沒有任何虛構內容。 */
export class FlowBubble {
  text: string;
  age = 0;
  /** 密集事件被合併成一顆時的次數。 */
  count = 1;
  constructor(
    readonly kind: BubbleKind,
    readonly anchorKey: string,
    text: string,
    readonly color: string,
    readonly life: number,
    readonly mergeName: string,
  ) {
    this.text = text;
  }

  /** 可見度 0–1：前面淡入、後面淡出，中間維持 1。 */
  alpha(fadeSeconds: number): number {
    return Math.min(1, Math.max(0, Math.min(this.age / fadeSeconds, (this.life - this.age) / fadeSeconds)));
  }
}

export class BubbleQueue {
  static readonly MaxVisible = 3;
  static readonly FadeSeconds = 0.4;
  static readonly ToolStartLife = 4;
  static readonly FailureLife = 8;
  static readonly AgentLife = 6;
  static readonly StatusLife = 5;
  static readonly LimitLife = 10;
  static readonly DocLife = 6;
  static readonly RagLife = 6;
  /** 同一個方塊在這段時間內再次開始工具，就合併進既有的泡泡。 */
  static readonly MergeWindowSeconds = 3;

  private _items: FlowBubble[] = [];

  /** 關掉就不再產生新泡泡（已經在畫面上的會自然淡出）。 */
  enabled = true;

  get items(): readonly FlowBubble[] {
    return this._items;
  }

  add(kind: BubbleKind, anchorKey: string, text: string, color: string, mergeName = ''): void {
    if (!this.enabled) return;

    if (kind === 'toolStart') {
      const same = [...this._items].reverse().find(b => b.kind === 'toolStart' && b.anchorKey === anchorKey && b.age < BubbleQueue.MergeWindowSeconds);
      if (same) {
        same.count++;
        same.text = `${mergeName.length > 0 ? mergeName : same.mergeName} ×${same.count}`;
        same.age = Math.min(same.age, BubbleQueue.FadeSeconds); // 有新事件就把壽命往回拉，持續到事件停下來
        return;
      }
    }

    if (kind === 'doc' || kind === 'rag') {
      // 同一個文件（或同一句 RAG 查詢）同一個動作還在畫面上：不另外再彈一顆，只把壽命拉回（連續重複時不會洗版）
      const same = this._items.find(b => b.kind === kind && b.anchorKey === anchorKey && b.text === text);
      if (same) {
        same.age = Math.min(same.age, BubbleQueue.FadeSeconds);
        return;
      }
    }

    if (this._items.length >= BubbleQueue.MaxVisible) {
      let victim: FlowBubble | undefined;
      for (const b of this._items) if (b.kind === 'toolStart' && (!victim || b.age > victim.age)) victim = b;
      if (victim) this._items.splice(this._items.indexOf(victim), 1);
      else if (kind === 'toolStart') return; // 全是重要泡泡：不用瑣碎的「工具開始」去擠
      else this._items.splice(0, 1);
    }

    const life =
      kind === 'failure' ? BubbleQueue.FailureLife
      : kind === 'agent' ? BubbleQueue.AgentLife
      : kind === 'status' ? BubbleQueue.StatusLife
      : kind === 'limit' ? BubbleQueue.LimitLife
      : kind === 'doc' ? BubbleQueue.DocLife
      : kind === 'rag' ? BubbleQueue.RagLife
      : BubbleQueue.ToolStartLife;
    this._items.push(new FlowBubble(kind, anchorKey, text, color, life, mergeName));
  }

  /** 推進時間；壽命到了、或指向的方塊／子代理已經不在了就移除。 */
  tick(dt: number, anchorExists: (key: string) => boolean): void {
    for (const b of this._items) b.age += dt;
    this._items = this._items.filter(b => !(b.age >= b.life || !anchorExists(b.anchorKey)));
  }
}
