import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeRagDb, planRagDb, RagDbDeps } from '../src/ragdb/apply';
import { DatabaseInUseError, FsOps, moveDatabase, MoveError, realFs } from '../src/ragdb/mover';
import { checkNewDbPath, dbFileInFolder, McpRegistration, PathProbe } from '../src/ragdb/plan';
import { ClaudeRunner } from '../src/ragdb/registry';

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'ragdb-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const dir = (...p: string[]): string => { const d = path.join(root, ...p); mkdirSync(d, { recursive: true }); return d; };
const file = (p: string, text: string): string => { writeFileSync(p, text); return p; };
const probe: PathProbe = { exists: existsSync, isDirectory: p => existsSync(p) && statSync(p).isDirectory() };
const err = (code: string): Error => Object.assign(new Error(code), { code });
const ls = (d: string): string[] => readdirSync(d).sort();

/** 在真的檔案系統上包一層：可以讓指定的改名／複製失敗。 */
function faulty(opts: {
  rename?: (a: string, b: string) => Error | null;
  copy?: (a: string, b: string) => Error | null;
  removeDir?: (p: string) => Error | null;
  summary?: (p: string) => string | undefined;
} = {}): FsOps {
  return {
    ...realFs,
    rename: async (a, b) => { const e = opts.rename?.(a, b); if (e) throw e; return realFs.rename(a, b); },
    copyFile: async (a, b) => { const e = opts.copy?.(a, b); if (e) throw e; return realFs.copyFile(a, b); },
    removeDirectory: async p => { const e = opts.removeDir?.(p); if (e) throw e; return realFs.removeDirectory(p); },
    directorySummary: async p => opts.summary?.(p) ?? realFs.directorySummary(p),
  };
}

describe('路徑檢查', () => {
  let old: string;
  const def = path.join('C:', 'Users', 'x', 'LocalRag', 'rag.db');
  beforeEach(() => { old = path.join(root, 'old', 'rag.db'); });

  it('接受：存在的資料夾、.db 結尾、目的地沒有檔案', () => {
    const d = dir('new');
    expect(checkNewDbPath(path.join(d, 'rag.db'), old, def, probe)).toEqual({ ok: true, path: path.join(d, 'rag.db') });
  });

  it.each([
    ['相對路徑', 'rag.db', '完整路徑'],
    ['網路路徑', '\\\\server\\share\\rag.db', '網路'],
    ['不是 .db', path.join('C:', 'data', 'rag.txt'), '.db'],
  ])('拒絕：%s', (_n, input, hint) => {
    const r = checkNewDbPath(input, old, def, probe);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain(hint);
  });

  it('拒絕：資料夾不存在（不會自動建立）', () => {
    const target = path.join(root, 'nope', 'rag.db');
    const r = checkNewDbPath(target, old, def, probe);
    expect(r.ok === false && r.reason).toContain('資料夾不存在');
    expect(existsSync(path.dirname(target))).toBe(false);
  });

  it('拒絕：目的地已有檔案（含 -wal），不覆蓋', () => {
    const d = dir('new');
    file(path.join(d, 'rag.db'), 'x');
    expect(checkNewDbPath(path.join(d, 'rag.db'), old, def, probe).ok).toBe(false);
    const d2 = dir('new2');
    file(path.join(d2, 'rag.db-wal'), 'x');
    expect(checkNewDbPath(path.join(d2, 'rag.db'), old, def, probe).ok).toBe(false);
  });

  it('拒絕：和目前位置相同；空白＝預設位置，已在預設時也拒絕', () => {
    expect(checkNewDbPath(old, old, def, probe).ok).toBe(false);
    expect(checkNewDbPath('', def, def, probe).ok).toBe(false);
  });
});

describe('資料夾挑選後組出檔案路徑', () => {
  it.each([
    ['', 'rag.db'],                              // 還沒設定：用預設檔名
    ['C:\\old\\my.db', 'my.db'],                 // 沿用原本的 .db 檔名
    ['C:\\old\\MY.DB', 'MY.DB'],                 // 副檔名不分大小寫
    ['C:\\old\\folder', 'rag.db'],               // 原本不是 .db 檔：不沿用
    ['C:\\old\\.db', 'rag.db'],                  // 只有副檔名、沒有主檔名：不沿用
  ])('hint=%j → %s', (hint, name) => {
    expect(dbFileInFolder(path.join('D:\\', 'RagData'), hint)).toBe(path.join('D:\\', 'RagData', name));
  });
});

describe('搬移資料庫', () => {
  function setup(withWal = true): { from: string; to: string } {
    const from = path.join(dir('src'), 'rag.db');
    file(from, 'DB-CONTENT');
    if (withWal) file(from + '-wal', 'WAL');
    mkdirSync(from + '.bak');
    file(path.join(from + '.bak', 'b1.db'), 'BACKUP');
    return { from, to: path.join(dir('dst'), 'rag.db') };
  }

  it('剪下貼上：資料庫、-wal、備份資料夾都到新位置，舊位置不留東西', async () => {
    const { from, to } = setup();
    const r = await moveDatabase(from, to, realFs);
    expect(readFileSync(to, 'utf8')).toBe('DB-CONTENT');
    expect(readFileSync(to + '-wal', 'utf8')).toBe('WAL');
    expect(readFileSync(path.join(to + '.bak', 'b1.db'), 'utf8')).toBe('BACKUP');
    expect(ls(path.dirname(from))).toEqual([]);
    expect(r.moved).toContain(to);
  });

  it('資料庫使用中（改名被拒）：丟 DatabaseInUseError，什麼都沒動', async () => {
    const { from, to } = setup();
    const busy = faulty({ rename: a => (a === from + '-wal' ? err('EBUSY') : null) }); // 第二個檔案被占用：第一個已改名的也要改回來
    await expect(moveDatabase(from, to, busy)).rejects.toBeInstanceOf(DatabaseInUseError);
    expect(ls(path.dirname(from))).toEqual(['rag.db', 'rag.db-wal', 'rag.db.bak']);
    expect(readFileSync(from, 'utf8')).toBe('DB-CONTENT');
    expect(ls(path.dirname(to))).toEqual([]);
  });

  it('跨磁碟（改名回 EXDEV）：改用複製、核對、刪來源，內容一致', async () => {
    const { from, to } = setup(false);
    const exdev = faulty({ rename: (_a, b) => (b === to ? err('EXDEV') : null) });
    await moveDatabase(from, to, exdev);
    expect(readFileSync(to, 'utf8')).toBe('DB-CONTENT');
    expect(existsSync(from)).toBe(false);
    expect(existsSync(from + '.moving')).toBe(false);
  });

  it('複製途中失敗：清掉不完整的新檔、舊檔還原，丟 MoveError', async () => {
    const { from, to } = setup();
    const broken = faulty({ rename: (_a, b) => (b === to ? err('EXDEV') : null), copy: () => new Error('磁碟已滿') });
    await expect(moveDatabase(from, to, broken)).rejects.toBeInstanceOf(MoveError);
    expect(readFileSync(from, 'utf8')).toBe('DB-CONTENT');
    expect(readFileSync(from + '-wal', 'utf8')).toBe('WAL');
    expect(ls(path.dirname(to))).toEqual([]);
  });

  it('多個檔案時第二個搬失敗：第一個要搬回來', async () => {
    const { from, to } = setup();
    const fs2 = faulty({ rename: (_a, b) => (b === to + '-wal' ? err('EACCES') : null) });
    await expect(moveDatabase(from, to, fs2)).rejects.toBeInstanceOf(MoveError);
    expect(ls(path.dirname(from))).toEqual(['rag.db', 'rag.db-wal', 'rag.db.bak']);
    expect(ls(path.dirname(to))).toEqual([]);
  });

  it('undo：整組搬回原位', async () => {
    const { from, to } = setup();
    const r = await moveDatabase(from, to, realFs);
    await r.undo();
    expect(ls(path.dirname(from))).toEqual(['rag.db', 'rag.db-wal', 'rag.db.bak']);
    expect(ls(path.dirname(to))).toEqual([]);
  });

  it('目的地已有 .bak：不覆蓋，舊備份留在原處並提醒', async () => {
    const { from, to } = setup();
    mkdirSync(to + '.bak');
    const r = await moveDatabase(from, to, realFs);
    expect(r.warnings.join('')).toContain('備份資料夾沒有搬');
    expect(existsSync(from + '.bak')).toBe(true);
  });

  describe('跨磁碟時的備份資料夾（資料夾不能直接改名搬過去）', () => {
    const crossBak = (to: string) => ({ rename: (_a: string, b: string) => (b.endsWith('.bak') ? err('EXDEV') : null) });

    it('改用複製（含子資料夾），核對一致才刪舊的，沒有警告', async () => {
      const { from, to } = setup();
      mkdirSync(path.join(from + '.bak', 'sub'));
      file(path.join(from + '.bak', 'sub', 'b2.db'), 'BACKUP2');
      const r = await moveDatabase(from, to, faulty(crossBak(to)));
      expect(readFileSync(path.join(to + '.bak', 'b1.db'), 'utf8')).toBe('BACKUP');
      expect(readFileSync(path.join(to + '.bak', 'sub', 'b2.db'), 'utf8')).toBe('BACKUP2');
      expect(existsSync(from + '.bak')).toBe(false);
      expect(r.warnings).toEqual([]);
      expect(r.moved).toContain(to + '.bak');
    });

    it('核對不一致：清掉不完整的新資料夾、保留舊備份、只警告；資料庫本身仍搬成功', async () => {
      const { from, to } = setup();
      const r = await moveDatabase(from, to, faulty({ ...crossBak(to), summary: p => (p === to + '.bak' ? '0:0' : undefined) }));
      expect(readFileSync(to, 'utf8')).toBe('DB-CONTENT');
      expect(existsSync(to + '.bak')).toBe(false);
      expect(readFileSync(path.join(from + '.bak', 'b1.db'), 'utf8')).toBe('BACKUP');
      expect(r.warnings.join('')).toContain('備份資料夾沒有搬');
    });

    it('複製完整但舊資料夾刪不掉：新的保留、舊的也還在，警告使用者手動刪；undo 只刪多的那份', async () => {
      const { from, to } = setup();
      const r = await moveDatabase(from, to, faulty({ ...crossBak(to), removeDir: p => (p === from + '.bak' ? new Error('檔案被占用') : null) }));
      expect(readFileSync(path.join(to + '.bak', 'b1.db'), 'utf8')).toBe('BACKUP');
      expect(existsSync(from + '.bak')).toBe(true);
      expect(r.warnings.join('')).toContain('刪不掉');
      await r.undo();
      expect(readFileSync(path.join(from + '.bak', 'b1.db'), 'utf8')).toBe('BACKUP');
      expect(existsSync(to + '.bak')).toBe(false);
    });

    it('undo：跨磁碟複製過去的備份資料夾，也能複製回來', async () => {
      const { from, to } = setup();
      const fs2 = faulty(crossBak(to));
      const r = await moveDatabase(from, to, fs2);
      expect(existsSync(from + '.bak')).toBe(false);
      await r.undo();
      expect(readFileSync(path.join(from + '.bak', 'b1.db'), 'utf8')).toBe('BACKUP');
      expect(existsSync(to + '.bak')).toBe(false);
      expect(readFileSync(from, 'utf8')).toBe('DB-CONTENT');
    });
  });

  it('舊位置沒有資料庫：丟 MoveError', async () => {
    await expect(moveDatabase(path.join(root, 'none.db'), path.join(dir('d'), 'x.db'), realFs)).rejects.toBeInstanceOf(MoveError);
  });
});

/** 假的 claude 命令列：維護一份記憶體裡的註冊，並記錄呼叫。 */
class FakeCli {
  reg: McpRegistration | null;
  calls: string[][] = [];
  ignoreRemove = false;
  /** 前幾次 add-json 靜默失敗（不寫入）。 */
  failAdds = 0;
  constructor(reg: McpRegistration | null) { this.reg = reg; }
  runner: ClaudeRunner = {
    run: async args => {
      this.calls.push(args);
      if (args[1] === 'remove' && !this.ignoreRemove) this.reg = null;
      if (args[1] === 'add-json') { if (this.failAdds > 0) this.failAdds--; else this.reg = JSON.parse(args[3]) as McpRegistration; }
      return { code: 0, stderr: '' };
    },
  };
}

describe('套用：規劃與執行', () => {
  let def: string; // 預設位置（在暫存資料夾裡）
  const original = (env?: Record<string, string>): McpRegistration => ({ type: 'stdio', command: 'dotnet', args: ['C:\\x\\RagMcp.dll'], ...(env ? { env } : {}) });

  const depsFor = (cli: FakeCli): RagDbDeps => ({
    fs: realFs, probe, runner: cli.runner, defaultPath: def,
    readRegistration: async () => (cli.reg ? (JSON.parse(JSON.stringify(cli.reg)) as McpRegistration) : null),
  });
  beforeEach(() => { def = path.join(dir('LocalRag'), 'rag.db'); file(def, 'DATA'); });

  it('找不到註冊：回原因，不動任何東西', async () => {
    const r = await planRagDb('local-rag', path.join(dir('n'), 'rag.db'), depsFor(new FakeCli(null)));
    expect(r.ok === false && r.reason).toContain('找不到');
  });

  it('規劃：目前用預設位置，新路徑寫進 env.RAG_DB，其餘欄位原樣保留', async () => {
    const target = path.join(dir('n'), 'rag.db');
    const r = await planRagDb('local-rag', target, depsFor(new FakeCli(original({ RAG_ENGINE: 'lexical' }))));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.oldPath).toBe(def);
      expect(r.plan.hasDb).toBe(true);
      expect(r.plan.updated.env).toEqual({ RAG_ENGINE: 'lexical', RAG_DB: target });
      expect(r.plan.updated.command).toBe('dotnet');
      expect(r.plan.updated.args).toEqual(['C:\\x\\RagMcp.dll']);
    }
  });

  it('回到預設位置：移除 RAG_DB；env 空了就整個拿掉', async () => {
    const custom = file(path.join(dir('c'), 'rag.db'), 'DATA'); // 資料庫現在在自訂位置，預設位置是空的
    rmSync(def);
    const r = await planRagDb('local-rag', '', depsFor(new FakeCli(original({ RAG_DB: custom }))));
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.plan.updated.env).toBeUndefined(); expect(r.plan.newPath).toBe(def); expect(r.plan.hasDb).toBe(true); }
  });

  it('回到預設位置但預設位置已有檔案：拒絕，不覆蓋', async () => {
    const custom = file(path.join(dir('c'), 'rag.db'), 'OTHER');
    const r = await planRagDb('local-rag', '', depsFor(new FakeCli(original({ RAG_DB: custom }))));
    expect(r.ok === false && r.reason).toContain('已經有檔案');
    expect(readFileSync(def, 'utf8')).toBe('DATA');
  });

  it('成功：資料庫搬走、註冊改成新路徑、順序是 remove 再 add-json', async () => {
    const target = path.join(dir('n'), 'rag.db');
    const cli = new FakeCli(original());
    const plan = await planRagDb('local-rag', target, depsFor(cli));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const result = await executeRagDb(plan.plan, depsFor(cli));
    expect(result.ok).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('DATA');
    expect(existsSync(def)).toBe(false);
    expect(cli.reg?.env?.RAG_DB).toBe(target);
    expect(cli.calls.map(c => c[1])).toEqual(['remove', 'add-json']);
    expect(cli.calls.every(c => c.includes('-s') && c.includes('user'))).toBe(true);
  });

  it('資料庫使用中：一個 claude 命令都不執行，註冊與檔案都沒動', async () => {
    const target = path.join(dir('n'), 'rag.db');
    const cli = new FakeCli(original());
    const plan = await planRagDb('local-rag', target, depsFor(cli));
    if (!plan.ok) throw new Error('規劃失敗');
    const busy = { ...depsFor(cli), fs: faulty({ rename: () => err('EBUSY') }) };
    const result = await executeRagDb(plan.plan, busy);
    expect(result.ok).toBe(false);
    expect(result.messages.join('')).toContain('使用中');
    expect(cli.calls).toEqual([]);
    expect(readFileSync(def, 'utf8')).toBe('DATA');
    expect(cli.reg).toEqual(original());
  });

  it('重新註冊沒有成功（add-json 沒寫入）：還原原註冊、資料庫搬回原位', async () => {
    const target = path.join(dir('n'), 'rag.db');
    const cli = new FakeCli(original());
    cli.failAdds = 1; // 第一次 add（新內容）失敗；第二次 add（還原）成功
    const plan = await planRagDb('local-rag', target, depsFor(cli));
    if (!plan.ok) throw new Error('規劃失敗');
    const result = await executeRagDb(plan.plan, depsFor(cli));
    expect(result.ok).toBe(false);
    expect(cli.reg).toEqual(original());
    expect(readFileSync(def, 'utf8')).toBe('DATA');
    expect(existsSync(target)).toBe(false);
    expect(result.messages.join('')).toContain('已還原原本的註冊');
  });

  it('移除舊註冊沒有成功（設定檔裡還在）：不再往下，資料庫搬回原位', async () => {
    const target = path.join(dir('n'), 'rag.db');
    const cli = new FakeCli(original());
    cli.ignoreRemove = true;
    const plan = await planRagDb('local-rag', target, depsFor(cli));
    if (!plan.ok) throw new Error('規劃失敗');
    const result = await executeRagDb(plan.plan, depsFor(cli));
    expect(result.ok).toBe(false);
    expect(readFileSync(def, 'utf8')).toBe('DATA');
    expect(existsSync(target)).toBe(false);
    expect(cli.reg?.env).toBeUndefined();
  });

  it('連還原註冊都失敗：明講「無法確認」並附上手動命令，不假裝成功', async () => {
    const target = path.join(dir('n'), 'rag.db');
    const cli = new FakeCli(original());
    cli.failAdds = 2;
    const plan = await planRagDb('local-rag', target, depsFor(cli));
    if (!plan.ok) throw new Error('規劃失敗');
    const result = await executeRagDb(plan.plan, depsFor(cli));
    expect(result.ok).toBe(false);
    expect(cli.reg).toBeNull();
    expect(result.messages.join('')).toContain('無法確認原本的註冊已還原');
    expect(result.messages.join('')).toContain('claude mcp add-json local-rag');
  });

  it('舊位置沒有資料庫檔案：只更新註冊', async () => {
    rmSync(def);
    const target = path.join(dir('n'), 'rag.db');
    const cli = new FakeCli(original());
    const plan = await planRagDb('local-rag', target, depsFor(cli));
    if (!plan.ok) throw new Error('規劃失敗');
    expect(plan.plan.hasDb).toBe(false);
    const result = await executeRagDb(plan.plan, depsFor(cli));
    expect(result.ok).toBe(true);
    expect(cli.reg?.env?.RAG_DB).toBe(target);
  });
});
