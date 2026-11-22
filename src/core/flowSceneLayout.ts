import { FlowModel } from './model';

export interface FlowSceneRow { model: FlowModel; y: number; height: number }

/** Only visible lanes occupy space; size active lanes for their actual tool content. */
export function flowSceneRows(models: readonly FlowModel[]): FlowSceneRow[] {
  const sizes = models.filter(model => model.busy || model.isLive || model.source > 0.005 || model.sink > 0.005
    || model.pillList.some(p => p.fade > 0.01))
    .map(model => ({ model, height: Math.max(360, model.columnHeight + 180) }));
  let top = -sizes.reduce((sum, row) => sum + row.height, 0) / 2;
  return sizes.map(({ model, height }) => {
    const row = { model, height, y: top + height / 2 };
    top += height;
    return row;
  });
}

/** Center the shared hand/foot pair on the first visible provider. */
export function sharedOutputY(rows: readonly FlowSceneRow[]): number {
  const row = rows.find(r => r.model.source > 0.005) ?? rows.find(r => r.model.sink > 0.005) ?? rows[0];
  return (row?.y ?? 0) - 44;
}

/**
 * 共用的手／腳整組的 Y 座標。`sharedOutputY` 是階梯式的（第一個可見的 provider 換人、某一列變高，
 * 目標就瞬間換位置），這裡讓目前位置「慢慢滑向」目標：先限速，靠近時再放慢（緩出），不會跳、不會過頭。
 */
export class OutputAnchor {
  /** 靠近比例：越大越快（每秒約剩下 e^-Rate 沒走完）。 */
  static readonly Rate = 2;
  /** 最快每秒走多少世界單位，距離很遠時不會一下衝過去。 */
  static readonly MaxSpeed = 450;
  /** 單次最多當成這麼多秒；久沒畫（閒置）之後的第一張不會因為時間差一次走完。 */
  static readonly MaxStep = 0.1;

  y = 0;
  private ready = false;

  /** 還沒到目標，畫面需要繼續高頻重畫。 */
  isMoving(target: number): boolean {
    return this.ready && Math.abs(target - this.y) > 0.05;
  }

  /** 往目標走一步並回傳目前位置。第一次、`snap`（減少動態）時直接就位。 */
  update(target: number, dt: number, snap = false): number {
    if (!this.ready || snap) { this.y = target; this.ready = true; return this.y; }
    const step = Math.min(Math.max(dt, 0), OutputAnchor.MaxStep);
    const want = (target - this.y) * (1 - Math.exp(-step * OutputAnchor.Rate));
    const cap = OutputAnchor.MaxSpeed * step;
    this.y += Math.max(-cap, Math.min(cap, want));
    if (Math.abs(target - this.y) < 0.05) this.y = target;
    return this.y;
  }
}
