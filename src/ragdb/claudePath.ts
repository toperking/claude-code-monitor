import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ClaudeProbe {
  exists(p: string): boolean;
  list(dir: string): string[];
}

const realProbe: ClaudeProbe = {
  exists: p => fs.existsSync(p),
  list: dir => { try { return fs.readdirSync(dir); } catch { return []; } },
};

/** 資料夾名稱裡的版本號（anthropic.claude-code-2.1.331-win32-x64 → [2,1,331]），沒有就空陣列。 */
function versionOf(name: string): number[] {
  const m = /-(\d+(?:\.\d+)*)/.exec(name);
  return m ? m[1].split('.').map(Number) : [];
}

function newerFirst(a: string, b: string): number {
  const va = versionOf(a); const vb = versionOf(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] ?? 0) - (va[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 找 claude 命令列。很多人只裝了 VS Code 的 Claude Code 擴充功能，PATH 上沒有 claude，
 * 但擴充功能自己帶了 resources/native-binary/claude.exe，用它一樣能 `claude mcp add-json`。
 * 順序：設定的完整路徑 → PATH 上已有 → ~/.local/bin → 各 VS Code 系編輯器擴充功能裡最新版的內建執行檔。
 * 都找不到就原樣回傳設定值（執行時會得到「找不到命令」的清楚錯誤）。
 */
export function resolveClaudeCommand(
  configured: string,
  home = os.homedir(),
  pathEnv = process.env.PATH ?? process.env.Path ?? '',
  probe: ClaudeProbe = realProbe,
): string {
  if (/[\\/]/.test(configured)) return configured;
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    if (probe.exists(path.join(dir, `${configured}.exe`))) return configured;
  }
  const local = path.join(home, '.local', 'bin', `${configured}.exe`);
  if (probe.exists(local)) return local;
  for (const editor of ['.vscode', '.vscode-insiders', '.vscode-oss', '.cursor', '.windsurf']) {
    const root = path.join(home, editor, 'extensions');
    const found = probe.list(root).filter(n => n.startsWith('anthropic.claude-code-')).sort(newerFirst);
    for (const dir of found) {
      const exe = path.join(root, dir, 'resources', 'native-binary', `${configured}.exe`);
      if (probe.exists(exe)) return exe;
    }
  }
  return configured;
}
