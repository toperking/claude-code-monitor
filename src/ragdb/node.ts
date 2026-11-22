import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RagDbDeps } from './apply';
import { realFs } from './mover';
import { execClaude, readRegistration } from './registry';

/** 真實環境的相依：~/.claude.json 唯讀讀取一筆註冊、execFile 執行 claude、預設資料庫在 %LOCALAPPDATA%\LocalRag\rag.db。 */
export function realRagDbDeps(claudeCommand: string): RagDbDeps {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const claudeJson = path.join(os.homedir(), '.claude.json');
  return {
    fs: realFs,
    probe: { exists: p => fs.existsSync(p), isDirectory: p => fs.existsSync(p) && fs.statSync(p).isDirectory() },
    runner: execClaude(claudeCommand),
    readRegistration: name => readRegistration(claudeJson, name),
    defaultPath: path.join(local, 'LocalRag', 'rag.db'),
  };
}
