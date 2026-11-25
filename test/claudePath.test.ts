import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeProbe, resolveClaudeCommand } from '../src/ragdb/claudePath';

const home = path.join('C:', 'Users', 'u');
const ext = (editor: string, name: string): string => path.join(home, editor, 'extensions', name, 'resources', 'native-binary', 'claude.exe');

/** files＝存在的完整檔案路徑；dirs＝資料夾 → 內容。 */
function probe(files: string[], dirs: Record<string, string[]> = {}): ClaudeProbe {
  return { exists: p => files.includes(p), list: d => dirs[d] ?? [] };
}

describe('resolveClaudeCommand', () => {
  it('keeps a full path the user configured', () => {
    expect(resolveClaudeCommand('D:\\tools\\claude.exe', home, '', probe([]))).toBe('D:\\tools\\claude.exe');
  });

  it('keeps the bare name when claude.exe is already on PATH', () => {
    const dir = path.join('C:', 'bin');
    expect(resolveClaudeCommand('claude', home, `${path.join('C:', 'x')}${path.delimiter}${dir}`, probe([path.join(dir, 'claude.exe')]))).toBe('claude');
  });

  it('uses ~/.local/bin/claude.exe before looking at editor extensions', () => {
    const local = path.join(home, '.local', 'bin', 'claude.exe');
    expect(resolveClaudeCommand('claude', home, '', probe([local, ext('.vscode', 'anthropic.claude-code-2.1.1-win32-x64')]))).toBe(local);
  });

  it('falls back to the newest Claude Code extension’s bundled binary (numeric, not alphabetical, version order)', () => {
    const root = path.join(home, '.vscode', 'extensions');
    const old = 'anthropic.claude-code-2.1.99-win32-x64';
    const latest = 'anthropic.claude-code-2.1.331-win32-x64';
    const got = resolveClaudeCommand('claude', home, '', probe([ext('.vscode', old), ext('.vscode', latest)], { [root]: [old, 'other.ext-1.0.0', latest] }));
    expect(got).toBe(ext('.vscode', latest));
  });

  it('also finds VS Code forks and returns the original name when nothing exists', () => {
    const name = 'anthropic.claude-code-2.0.0-win32-x64';
    expect(resolveClaudeCommand('claude', home, '', probe([ext('.vscode-oss', name)], { [path.join(home, '.vscode-oss', 'extensions')]: [name] }))).toBe(ext('.vscode-oss', name));
    expect(resolveClaudeCommand('claude', home, '', probe([]))).toBe('claude');
  });
});
