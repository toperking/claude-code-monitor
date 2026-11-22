import { FlowModel } from './model';

export interface FlowSceneRow { model: FlowModel; y: number; height: number }

/** Provider groups in a shared world, with enough room for robots and expanded tools. */
export function flowSceneRows(models: readonly FlowModel[]): FlowSceneRow[] {
  const sizes = models.map(model => ({ model, height: Math.max(600, model.columnHeight + 240) }));
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
