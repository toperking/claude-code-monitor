import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { McpRegistration } from '../ragdb/plan';
import { ClaudeRunner } from '../ragdb/registry';

/** 打包在擴充功能 ragmcp/ 裡的檔案（RagMcp 框架相依發佈 + Windows 的 SQLite 原生函式庫）。 */
export const BundleFiles = [
  'Microsoft.Data.Sqlite.dll',
  'Rag.dll',
  'RagMcp.dll',
  'RagMcp.deps.json',
  'RagMcp.runtimeconfig.json',
  'SQLitePCLRaw.batteries_v2.dll',
  'SQLitePCLRaw.core.dll',
  'SQLitePCLRaw.provider.e_sqlite3.dll',
  path.join('runtimes', 'win-x64', 'native', 'e_sqlite3.dll'),
];

export interface InstallDeps {
  /** 擴充功能內打包好的 ragmcp 資料夾。 */
  bundleDir: string;
  /** %LOCALAPPDATA%（LocalRag 放這裡）。 */
  localAppData: string;
  /** 使用者主目錄（~/.codex）。 */
  home: string;
  runner: ClaudeRunner;
  readRegistration(name: string): Promise<McpRegistration | null>;
  /** `dotnet --list-runtimes` 的輸出；找不到 dotnet 就丟錯。 */
  dotnetRuntimes(): Promise<string>;
}

export interface InstallOptions {
  name: string;
  /** 使用者在設定指定的資料庫完整路徑；空字串＝用預設位置（不設 RAG_DB）。 */
  dbPath: string;
  /** config.json 不存在時，roots.project 要指到的資料夾。 */
  projectRoot: string;
}

export interface InstallPlan {
  name: string;
  targetDir: string;
  dllPath: string;
  configPath: string;
  configExists: boolean;
  projectRoot: string;
  registration: McpRegistration;
  /** Claude Code 目前的註冊：none＝沒有、same＝已相同、different＝會被取代。 */
  claude: 'none' | 'same' | 'different';
  existingClaude: McpRegistration | null;
  codexToml: string;
  /** codex：no-folder＝沒有 ~/.codex、has-entry＝已有同名設定（不動）、add＝會附加。 */
  codex: 'no-folder' | 'has-entry' | 'add';
  dotnetOk: boolean;
  dotnetDetail: string;
}

export interface InstallResult { ok: boolean; messages: string[] }

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** `dotnet --list-runtimes` 輸出裡是否有 Microsoft.NETCore.App 8 以上。 */
export function hasDotnet8(output: string): boolean {
  return output.split(/\r?\n/).some(line => {
    const m = /^Microsoft\.NETCore\.App (\d+)\./.exec(line.trim());
    return m !== null && Number(m[1]) >= 8;
  });
}

/** TOML 的 [mcp_servers.<name>] 區段（含引號寫法）是否已存在。 */
export function codexHasEntry(toml: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*\\[mcp_servers\\.(?:"${escaped}"|'${escaped}'|${escaped})(?:\\.[^\\]]+)?\\]`, 'm').test(toml);
}

function assertTomlSafe(value: string, label: string): void {
  if (/['\r\n]/.test(value)) throw new Error(`${label} 含有單引號或換行，無法安全寫入 Codex 設定：${value}`);
}

/** 附加到 ~/.codex/config.toml 的區段（TOML 單引號字串＝不處理跳脫，Windows 路徑可直接寫）。 */
export function codexBlock(name: string, reg: McpRegistration): string {
  assertTomlSafe(name, 'MCP 名稱');
  assertTomlSafe(reg.command, '命令');
  reg.args.forEach(a => assertTomlSafe(a, '參數'));
  const lines = ['', `[mcp_servers.${name}]`, `command = '${reg.command}'`, `args = [${reg.args.map(a => `'${a}'`).join(', ')}]`];
  const env = Object.entries(reg.env ?? {});
  if (env.length > 0) {
    lines.push('', `[mcp_servers.${name}.env]`);
    for (const [k, v] of env) { assertTomlSafe(v, k); lines.push(`${k} = '${v}'`); }
  }
  return lines.join('\n') + '\n';
}

async function readIfExists(file: string): Promise<string | null> {
  try { return await fs.readFile(file, 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}

async function sha(file: string): Promise<string | null> {
  try { return createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}

async function writeAtomically(file: string, content: string): Promise<void> {
  const temp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try { await fs.writeFile(temp, content, 'utf8'); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}

const sameReg = (a: McpRegistration | null, b: McpRegistration): boolean =>
  a !== null && a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args) && (a.env?.RAG_DB ?? '') === (b.env?.RAG_DB ?? '');

/** 只規劃、不動任何東西：檢查 .NET、打包檔案、目前兩邊的註冊狀態。 */
export async function planInstall(opts: InstallOptions, deps: InstallDeps): Promise<InstallPlan> {
  for (const f of BundleFiles) {
    if (await sha(path.join(deps.bundleDir, f)) === null) throw new Error(`擴充功能內缺少 ${f}（打包不完整），請重新安裝擴充功能。`);
  }
  const targetDir = path.join(deps.localAppData, 'LocalRag', 'bin', 'RagMcp');
  const dllPath = path.join(targetDir, 'RagMcp.dll');
  const configPath = path.join(deps.localAppData, 'LocalRag', 'config.json');

  let dotnetOk = false;
  let dotnetDetail: string;
  try {
    const out = await deps.dotnetRuntimes();
    dotnetOk = hasDotnet8(out);
    dotnetDetail = dotnetOk ? '已安裝 .NET 8 以上的執行環境' : '找不到 Microsoft.NETCore.App 8 以上的版本，請先安裝 .NET 8 Runtime';
  } catch { dotnetDetail = '找不到 dotnet 命令，請先安裝 .NET 8 Runtime'; }

  const env = opts.dbPath.trim() !== '' ? { RAG_DB: opts.dbPath.trim() } : undefined;
  const existingClaude = await deps.readRegistration(opts.name);
  // 已有註冊就保留它的資料庫位置（RAG_DB），只換成這份程式的路徑
  const keepEnv = existingClaude?.env ?? env;
  const registration: McpRegistration = { type: 'stdio', command: 'dotnet', args: [dllPath], ...(keepEnv && Object.keys(keepEnv).length > 0 ? { env: keepEnv } : {}) };

  const codexDir = path.join(deps.home, '.codex');
  const hasCodexDir = await fs.stat(codexDir).then(s => s.isDirectory()).catch(() => false);
  const codexToml = path.join(codexDir, 'config.toml');
  let codex: InstallPlan['codex'] = 'no-folder';
  if (hasCodexDir) codex = codexHasEntry(await readIfExists(codexToml) ?? '', opts.name) ? 'has-entry' : 'add';

  return {
    name: opts.name, targetDir, dllPath, configPath, configExists: await readIfExists(configPath) !== null,
    projectRoot: opts.projectRoot, registration,
    claude: existingClaude === null ? 'none' : sameReg(existingClaude, registration) ? 'same' : 'different',
    existingClaude, codexToml, codex, dotnetOk, dotnetDetail,
  };
}

async function copyBundle(plan: InstallPlan, deps: InstallDeps, messages: string[]): Promise<void> {
  let copied = 0;
  for (const f of BundleFiles) {
    const from = path.join(deps.bundleDir, f);
    const to = path.join(plan.targetDir, f);
    if (await sha(from) === await sha(to)) continue; // 內容相同就不動（也避開正在使用中的檔案被鎖）
    await fs.mkdir(path.dirname(to), { recursive: true });
    try { await fs.copyFile(from, to); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') throw new Error(`${to} 正在使用中，無法更新。請先關閉用到 local-rag 的 Claude Code／Codex 對話後再試。`);
      throw e;
    }
    copied++;
  }
  messages.push(copied > 0 ? `已安裝 RagMcp 程式（更新 ${copied} 個檔案）：${plan.targetDir}` : `RagMcp 程式已是最新：${plan.targetDir}`);
}

async function ensureConfig(plan: InstallPlan, messages: string[]): Promise<void> {
  if (plan.configExists) { messages.push(`config.json 已存在，沒有改動：${plan.configPath}`); return; }
  await fs.mkdir(path.dirname(plan.configPath), { recursive: true });
  const config = { roots: { project: plan.projectRoot }, deny: [], maxFilesPerCall: 20, maxChunksPerCall: 500, maxChunksPerHour: 5000 };
  await writeAtomically(plan.configPath, JSON.stringify(config, null, 2) + '\n');
  messages.push(`已建立 config.json（可索引根目錄 project = ${plan.projectRoot}）：${plan.configPath}`);
}

async function registerClaude(plan: InstallPlan, deps: InstallDeps, messages: string[]): Promise<boolean> {
  if (plan.claude === 'same') { messages.push(`Claude Code：「${plan.name}」已註冊，內容相同。`); return true; }
  const asJson = (r: McpRegistration): string => JSON.stringify(r);
  const rollback = async (reason: string): Promise<boolean> => {
    messages.push(`Claude Code：${reason}`);
    if (plan.existingClaude) {
      await deps.runner.run(['mcp', 'add-json', plan.name, asJson(plan.existingClaude), '-s', 'user']).catch(() => undefined);
      messages.push(sameReg(await deps.readRegistration(plan.name), plan.existingClaude) ? 'Claude Code：已還原原本的註冊。' : `⚠ 無法確認已還原！請手動執行：claude mcp add-json ${plan.name} '${asJson(plan.existingClaude)}' -s user`);
    }
    return false;
  };
  try {
    if (plan.existingClaude) {
      await deps.runner.run(['mcp', 'remove', plan.name, '-s', 'user']);
      if (await deps.readRegistration(plan.name)) return await rollback('移除舊註冊失敗，設定檔裡它還在。');
    }
    await deps.runner.run(['mcp', 'add-json', plan.name, asJson(plan.registration), '-s', 'user']);
    if (!sameReg(await deps.readRegistration(plan.name), plan.registration)) return await rollback('註冊後讀回的內容和預期不同。');
  } catch (e) { return await rollback(`註冊時發生錯誤：${message(e)}`); }
  messages.push(`Claude Code：已註冊「${plan.name}」。已開著的對話要輸入 /mcp 重新連線，或開新對話。`);
  return true;
}

async function registerCodex(plan: InstallPlan, messages: string[]): Promise<boolean> {
  if (plan.codex === 'no-folder') { messages.push('Codex：找不到 ~/.codex，略過。'); return true; }
  if (plan.codex === 'has-entry') { messages.push(`Codex：${plan.codexToml} 已有「${plan.name}」設定，沒有改動。`); return true; }
  try {
    const old = await readIfExists(plan.codexToml);
    const block = codexBlock(plan.name, plan.registration);
    if (old !== null && await readIfExists(plan.codexToml + '.claude-monitor.bak') === null) await fs.copyFile(plan.codexToml, plan.codexToml + '.claude-monitor.bak');
    await writeAtomically(plan.codexToml, (old === null ? '' : old.replace(/\s*$/, '\n')) + block);
    const check = await readIfExists(plan.codexToml);
    if (check === null || !codexHasEntry(check, plan.name)) throw new Error('寫入後讀回沒有看到設定');
    messages.push(`Codex：已在 ${plan.codexToml} 加入「${plan.name}」${old !== null ? '（原檔備份為 config.toml.claude-monitor.bak）' : ''}。新開 Codex 工作階段後生效。`);
    return true;
  } catch (e) { messages.push(`Codex：${message(e)}`); return false; }
}

/** 執行：複製程式 → 建 config.json → 註冊 Claude Code → 註冊 Codex。各步獨立回報，任何一步失敗就說明哪一步。 */
export async function executeInstall(plan: InstallPlan, deps: InstallDeps): Promise<InstallResult> {
  const messages: string[] = [];
  if (!plan.dotnetOk) return { ok: false, messages: [plan.dotnetDetail, '沒有做任何變更。'] };
  try { await copyBundle(plan, deps, messages); await ensureConfig(plan, messages); }
  catch (e) { return { ok: false, messages: [...messages, message(e), '沒有改動任何註冊。'] }; }
  const claudeOk = await registerClaude(plan, deps, messages);
  const codexOk = await registerCodex(plan, messages);
  return { ok: claudeOk && codexOk, messages };
}
