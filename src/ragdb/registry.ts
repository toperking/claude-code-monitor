import { execFile } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import { McpRegistration } from './plan';

/**
 * 唯讀：從 ~/.claude.json 的 mcpServers 取出「指定名稱」那一筆 stdio 伺服器的註冊內容。
 * 只取這一筆；檔案裡的其他內容（專案紀錄、其他伺服器）不讀取、不記錄、不外傳。找不到或格式不對回 null。
 */
export async function readRegistration(claudeJsonPath: string, name: string): Promise<McpRegistration | null> {
  let text: string;
  try { text = await fsp.readFile(claudeJsonPath, 'utf8'); } catch { return null; }
  let data: unknown;
  try { data = JSON.parse(text); } catch { return null; }
  const entry = (data as { mcpServers?: Record<string, unknown> } | null)?.mcpServers?.[name];
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.command !== 'string' || e.command.length === 0) return null;
  const args = Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === 'string') : [];
  const env = e.env && typeof e.env === 'object' ? Object.fromEntries(Object.entries(e.env as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string> : undefined;
  return { ...e, command: e.command, args, ...(env ? { env } : {}) };
}

/** 執行 `claude` 命令列。結果不靠結束碼判斷（使用者的 hook 可能在 stderr 吐雜訊），呼叫端要重新讀設定檔確認。 */
export interface ClaudeRunner {
  run(args: string[]): Promise<{ code: number | null; stderr: string }>;
}

/** 用 execFile（參數陣列、不經 shell），不會有字串拼接的注入問題。 */
export function execClaude(command: string, timeoutMs = 60_000): ClaudeRunner {
  return {
    run: args => new Promise((resolve, reject) => {
      execFile(command, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
        const err = error as NodeJS.ErrnoException | null;
        if (err && err.code === 'ENOENT') { reject(new Error(`找不到命令「${command}」。請到設定「claudeMonitor.ragClaudeCommand」填入 claude 的完整路徑。`)); return; }
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stderr: String(stderr ?? '') });
      });
    }),
  };
}
