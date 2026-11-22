import * as fsp from 'node:fs/promises';

/** 搬移資料庫會用到的檔案操作；全部經過這個介面，測試才能注入「改名失敗」「複製中斷」這類故障。 */
export interface FsOps {
  exists(p: string): Promise<boolean>;
  isDirectory(p: string): Promise<boolean>;
  rename(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  size(p: string): Promise<number>;
  unlink(p: string): Promise<void>;
}

export const realFs: FsOps = {
  exists: async p => fsp.access(p).then(() => true, () => false),
  isDirectory: async p => fsp.stat(p).then(s => s.isDirectory(), () => false),
  rename: (a, b) => fsp.rename(a, b),
  copyFile: (a, b) => fsp.copyFile(a, b),
  size: async p => (await fsp.stat(p)).size,
  unlink: p => fsp.unlink(p),
};

export interface MoveResult {
  /** 實際搬了哪些檔案／資料夾（給使用者看的結果）。 */
  moved: string[];
  /** 沒有致命、但要讓使用者知道的事。 */
  warnings: string[];
  /** 全部搬回原位（註冊失敗時用）。盡力而為，失敗會丟例外。 */
  undo(): Promise<void>;
}

/** 資料庫正在被使用（SQLite 開著的檔案在 Windows 上不能被改名）：什麼都沒有動。 */
export class DatabaseInUseError extends Error {}
/** 搬移失敗，已盡力還原。 */
export class MoveError extends Error {}

const SUFFIXES = ['', '-wal', '-shm'];
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const code = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code;

/** 改名；不同磁碟（EXDEV）就改用「複製、核對大小、刪來源」。複製途中失敗會清掉不完整的目的檔。 */
async function relocate(fs: FsOps, from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
    return;
  } catch (e) {
    if (code(e) !== 'EXDEV') throw e;
  }
  try {
    await fs.copyFile(from, to);
    if ((await fs.size(from)) !== (await fs.size(to))) throw new Error(`複製後大小不一致：${to}`);
  } catch (e) {
    await fs.unlink(to).catch(() => undefined);
    throw e;
  }
  await fs.unlink(from);
}

/**
 * 把資料庫（含 -wal、-shm 與 .bak 備份資料夾）從 oldPath 搬到 newPath（剪下貼上，不留舊檔）。
 * 1. 先把每個檔案改名成「.moving」：Windows 上被 SQLite 開著的檔案不能改名，所以這一步同時是「有沒有人在用」的檢查；
 *    失敗就全部改回來、什麼都沒動，丟 DatabaseInUseError。
 * 2. 再搬到新位置（同磁碟改名、跨磁碟複製加核對）。任何一步失敗都盡力還原，丟 MoveError。
 */
export async function moveDatabase(oldPath: string, newPath: string, fs: FsOps): Promise<MoveResult> {
  const present: string[] = [];
  for (const s of SUFFIXES) if (await fs.exists(oldPath + s)) present.push(s);
  if (!present.includes('')) throw new MoveError(`舊位置沒有資料庫檔案：${oldPath}`);

  // 1. 認領（占用檢查）
  const claimed: string[] = [];
  const unclaim = async (): Promise<void> => {
    for (const s of [...claimed].reverse()) await fs.rename(oldPath + s + '.moving', oldPath + s).catch(() => undefined);
  };
  try {
    for (const s of present) { await fs.rename(oldPath + s, oldPath + s + '.moving'); claimed.push(s); }
  } catch (e) {
    await unclaim();
    throw new DatabaseInUseError(`資料庫正在使用中，沒有搬移任何東西（${message(e)}）。請先結束所有用到 local-rag 的 Claude Code 對話（或在 /mcp 把它斷線），再試一次。`);
  }

  // 2. 搬到新位置
  const placed: string[] = [];
  try {
    for (const s of present) { await relocate(fs, oldPath + s + '.moving', newPath + s); placed.push(s); }
  } catch (e) {
    for (const s of [...placed].reverse()) await relocate(fs, newPath + s, oldPath + s + '.moving').catch(() => undefined);
    await unclaim();
    throw new MoveError(`搬移失敗，已還原到原位：${message(e)}`);
  }

  const moved = present.map(s => newPath + s);
  const warnings: string[] = [];
  let backupMoved = false;
  const oldBak = oldPath + '.bak';
  const newBak = newPath + '.bak';
  if (await fs.isDirectory(oldBak)) {
    if (await fs.exists(newBak)) {
      warnings.push(`備份資料夾沒有搬：目的地已有 ${newBak}。舊的還在 ${oldBak}。`);
    } else {
      try { await fs.rename(oldBak, newBak); backupMoved = true; moved.push(newBak); }
      catch (e) { warnings.push(`備份資料夾沒有搬（${message(e)}）。舊的還在 ${oldBak}。`); }
    }
  }

  return {
    moved,
    warnings,
    undo: async () => {
      if (backupMoved) await fs.rename(newBak, oldBak);
      for (const s of [...present].reverse()) await relocate(fs, newPath + s, oldPath + s);
    },
  };
}
