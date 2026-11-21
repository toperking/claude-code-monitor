import { describe, expect, it } from 'vitest';
import { BubbleAnchors, BubbleQueue } from '../src/core/bubbles';

const add = (q: BubbleQueue, kind: Parameters<BubbleQueue['add']>[0], anchor: string, text: string, merge = ''): void =>
  q.add(kind, anchor, text, '#fff', merge);

describe('BubbleQueue', () => {
  it('同時最多 3 顆；名額滿了先擠掉最舊的「工具開始」', () => {
    const q = new BubbleQueue();
    add(q, 'toolStart', 'A', 'a'); q.tick(1, () => true);
    add(q, 'toolStart', 'B', 'b'); q.tick(1, () => true);
    add(q, 'toolStart', 'C', 'c');
    add(q, 'toolStart', 'D', 'd');
    expect(q.items).toHaveLength(3);
    expect(q.items.map(b => b.text)).toEqual(['b', 'c', 'd']); // 最舊的 a 被擠掉
  });

  it('全是重要泡泡時，瑣碎的「工具開始」不能擠掉它們（直接被拒絕）', () => {
    const q = new BubbleQueue();
    add(q, 'failure', 'A', 'f1'); add(q, 'agent', 'B', 'ag'); add(q, 'doc', 'C', 'doc');
    add(q, 'toolStart', 'D', 'start');
    expect(q.items.map(b => b.kind)).toEqual(['failure', 'agent', 'doc']);
  });

  it('重要泡泡進來時，如果沒有「工具開始」可擠，就擠掉最舊的那一顆', () => {
    const q = new BubbleQueue();
    add(q, 'failure', 'A', 'f1'); add(q, 'agent', 'B', 'ag'); add(q, 'doc', 'C', 'doc');
    add(q, 'status', BubbleAnchors.Hub, 'st');
    expect(q.items.map(b => b.text)).toEqual(['ag', 'doc', 'st']);
  });

  it('同一個方塊 3 秒內密集的「工具開始」合併成「名稱 ×N」並把壽命拉回', () => {
    const q = new BubbleQueue();
    add(q, 'toolStart', 'Bash', 'Bash ▸ ls', 'Bash');
    q.tick(2, () => true);
    add(q, 'toolStart', 'Bash', 'Bash ▸ pwd', 'Bash');
    add(q, 'toolStart', 'Bash', 'Bash ▸ git', 'Bash');
    expect(q.items).toHaveLength(1);
    expect(q.items[0].text).toBe('Bash ×3');
    expect(q.items[0].age).toBeLessThanOrEqual(BubbleQueue.FadeSeconds);
  });

  it('超過合併窗口就另外彈一顆', () => {
    const q = new BubbleQueue();
    add(q, 'toolStart', 'Bash', 'one', 'Bash');
    q.tick(BubbleQueue.MergeWindowSeconds + 0.1, () => true);
    add(q, 'toolStart', 'Bash', 'two', 'Bash');
    expect(q.items).toHaveLength(2);
  });

  it('同一份文件同一個動作還在畫面上時不重複堆疊，只把壽命拉回', () => {
    const q = new BubbleQueue();
    add(q, 'doc', 'Read', '文件 README.md · 讀取');
    q.tick(3, () => true);
    add(q, 'doc', 'Read', '文件 README.md · 讀取');
    expect(q.items).toHaveLength(1);
    expect(q.items[0].age).toBeLessThanOrEqual(BubbleQueue.FadeSeconds);
  });

  it('各種泡泡的壽命：工具開始 4、失敗 8、子代理 6、狀態 5、額度 10、文件 6 秒', () => {
    const life = (kind: Parameters<BubbleQueue['add']>[0]): number => {
      const q = new BubbleQueue(); add(q, kind, 'A', 't'); return q.items[0].life;
    };
    expect([life('toolStart'), life('failure'), life('agent'), life('status'), life('limit'), life('doc')]).toEqual([4, 8, 6, 5, 10, 6]);
  });

  it('壽命到了、或指向的方塊不在了就移除；固定位置不會消失', () => {
    const q = new BubbleQueue();
    add(q, 'failure', 'gone', 'x');
    add(q, 'status', BubbleAnchors.Hub, 'hub');
    q.tick(0.1, k => BubbleAnchors.isFixed(k));
    expect(q.items.map(b => b.text)).toEqual(['hub']);
    q.tick(BubbleQueue.StatusLife + 0.1, () => true);
    expect(q.items).toHaveLength(0);
  });

  it('淡入淡出各 0.4 秒，中間維持 1', () => {
    const q = new BubbleQueue();
    add(q, 'failure', 'A', 'x');
    const b = q.items[0];
    expect(b.alpha(0.4)).toBe(0);
    q.tick(0.2, () => true); expect(b.alpha(0.4)).toBeCloseTo(0.5);
    q.tick(1, () => true); expect(b.alpha(0.4)).toBe(1);
    q.tick(BubbleQueue.FailureLife - 1.2 - 0.2, () => true); expect(b.alpha(0.4)).toBeCloseTo(0.5);
  });

  it('關掉就不再產生新泡泡', () => {
    const q = new BubbleQueue();
    q.enabled = false;
    add(q, 'failure', 'A', 'x');
    expect(q.items).toHaveLength(0);
  });
});
