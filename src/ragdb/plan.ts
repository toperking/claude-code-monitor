import * as path from 'node:path';

/** ~/.claude.json 的 mcpServers 裡一筆 stdio 伺服器的註冊內容（只認我們需要的欄位，其餘原樣帶著走）。 */
export interface McpRegistration {
  type?: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

/** 路徑檢查會用到的檔案系統查詢（同步、唯讀；測試時換成假的）。 */
export interface PathProbe {
  exists(p: string): boolean;
  isDirectory(p: string): boolean;
}

export type PathCheck = { ok: true; path: string } | { ok: false; reason: string };

const fail = (reason: string): PathCheck => ({ ok: false, reason });

/**
 * 使用者在資料夾挑選器選了資料夾後，組出資料庫檔案的完整路徑：
 * 沿用 hint（目前設定或已輸入的路徑）的檔名（要是 .db），沒有就用 rag.db。
 */
export function dbFileInFolder(folder: string, hint: string): string {
  const name = path.basename(hint.trim());
  return path.join(folder, path.extname(name).toLowerCase() === '.db' && name.length > 3 ? name : 'rag.db');
}

/** Windows 的路徑不分大小寫。 */
export function samePath(a: string, b: string): boolean {
  const n = (p: string): string => path.normalize(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

/**
 * 檢查使用者填的新資料庫路徑。空白＝回到預設位置。
 * 原則：寧可拒絕也不猜——不自動建資料夾、不覆蓋既有檔案、不接受網路路徑。
 */
export function checkNewDbPath(input: string, oldPath: string, defaultPath: string, probe: PathProbe): PathCheck {
  const raw = input.trim();
  const target = raw === '' ? defaultPath : raw;

  if (/^[\\/]{2}/.test(target)) return fail('不能使用網路路徑（\\\\主機\\…）：SQLite 的 WAL 模式放在網路磁碟上容易損壞。請改用本機磁碟。');
  if (!path.isAbsolute(target)) return fail('請填完整路徑，例如 D:\\RagData\\rag.db。');

  const full = path.normalize(target);
  if (path.extname(full).toLowerCase() !== '.db') return fail('檔名要以 .db 結尾，例如 D:\\RagData\\rag.db。');
  if (samePath(full, oldPath)) return fail(raw === '' ? '目前已經是預設位置，不需要搬移。' : '和目前的位置相同，不需要搬移。');

  const dir = path.dirname(full);
  if (!probe.isDirectory(dir)) return fail(`資料夾不存在：${dir}。請先自己建立這個資料夾（不會自動建立）。`);
  for (const suffix of ['', '-wal', '-shm']) {
    if (probe.exists(full + suffix)) return fail(`目的地已經有檔案：${full + suffix}。為避免覆蓋，請換一個檔名，或先自己移走它。`);
  }
  return { ok: true, path: full };
}
