import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveClaudeCommand } from '../ragdb/claudePath';
import { execClaude, readRegistration } from '../ragdb/registry';
import { InstallDeps } from './install';

/** 真實環境的相依：dotnet --list-runtimes、claude 命令列、~/.claude.json 唯讀一筆註冊。 */
export function realInstallDeps(bundleDir: string, claudeCommand: string): InstallDeps {
  return {
    bundleDir,
    localAppData: process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
    home: os.homedir(),
    runner: execClaude(resolveClaudeCommand(claudeCommand)),
    readRegistration: name => readRegistration(path.join(os.homedir(), '.claude.json'), name),
    dotnetRuntimes: () => new Promise((resolve, reject) => {
      execFile('dotnet', ['--list-runtimes'], { windowsHide: true, timeout: 15_000 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
    }),
  };
}
