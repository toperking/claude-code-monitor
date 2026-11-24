// 工具方塊「尾巴」的小標籤：每個方塊右邊接幾張小卡，顯示正在執行、或剛結束的呼叫。
// 只有「執行中」與「剛結束」才出現，結束後淡出；全是從真實呼叫紀錄算出來的，不虛構。
// 純函式，不畫圖（繪製在 webview/render.ts）。

import { ToolCallDto, ToolResult } from './types';

/** 一個方塊尾巴最多同時顯示幾張；更早的併成「+N」。 */
export const TailChipMax = 3;
/** 成功後留多久（毫秒）：短，畫面才乾淨。 */
export const TailOkLingerMs = 5000;
/** 失敗後留多久（毫秒）：長一點，讓人來得及看到。 */
export const TailFailLingerMs = 12000;
/** 消失前最後多久（毫秒）用來淡出。 */
export const TailFadeMs = 1000;

export type TailChipState = 'run' | 'ok' | 'fail';

export interface TailChip {
  readonly call: ToolCallDto;
  readonly state: TailChipState;
  /** 0–1；結束後快消失時才小於 1。 */
  readonly alpha: number;
  /** 執行中＝已經跑了幾秒；已結束＝這次花了幾秒。 */
  readonly seconds: number;
}

export interface TailChips {
  /** 舊 → 新（由左到右）。 */
  readonly chips: readonly TailChip[];
  /** 符合條件但放不下的張數。 */
  readonly more: number;
}

export const NoTailChips: TailChips = { chips: [], more: 0 };

/**
 * 算出某個方塊目前該顯示哪些小標籤。
 * @param recent 該方塊最近的呼叫（順序不拘）
 * @param now 目前時間（毫秒時間戳）；0 或負值視為「還沒有時鐘」，不顯示任何標籤
 */
export function tailChips(recent: readonly ToolCallDto[], now: number, max = TailChipMax): TailChips {
  if (now <= 0 || recent.length === 0) return NoTailChips;
  const eligible: TailChip[] = [];
  for (const call of recent) {
    if (call.result === ToolResult.Running) {
      eligible.push({ call, state: 'run', alpha: 1, seconds: Math.max(0, (now - call.time) / 1000) });
      continue;
    }
    const failed = call.result === ToolResult.Failed;
    if (!failed && call.result !== ToolResult.Ok) continue; // 未完成／已中止：沒有結果可顯示，不留標籤
    const linger = failed ? TailFailLingerMs : TailOkLingerMs;
    const age = Math.max(0, now - (call.time + call.durationSeconds * 1000));
    if (age >= linger) continue;
    const alpha = age > linger - TailFadeMs ? (linger - age) / TailFadeMs : 1;
    eligible.push({ call, state: failed ? 'fail' : 'ok', alpha, seconds: call.durationSeconds });
  }
  if (eligible.length === 0) return NoTailChips;
  eligible.sort((a, b) => a.call.time - b.call.time);
  const shown = eligible.slice(-Math.max(1, max));
  return { chips: shown, more: eligible.length - shown.length };
}
