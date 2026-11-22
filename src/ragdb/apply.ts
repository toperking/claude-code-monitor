import * as path from 'node:path';
import { DatabaseInUseError, FsOps, moveDatabase, MoveResult } from './mover';
import { checkNewDbPath, McpRegistration, PathProbe } from './plan';
import { ClaudeRunner } from './registry';

export interface RagDbDeps {
  fs: FsOps;
  probe: PathProbe;
  runner: ClaudeRunner;
  readRegistration(name: string): Promise<McpRegistration | null>;
  /** 預設資料庫位置（%LOCALAPPDATA%\LocalRag\rag.db）。 */
  defaultPath: string;
}

export interface RagDbPlan {
  name: string;
  oldPath: string;
  newPath: string;
  /** 舊位置真的有資料庫檔案（沒有的話只改註冊）。 */
  hasDb: boolean;
  original: McpRegistration;
  updated: McpRegistration;
}

export type PlanResult = { ok: true; plan: RagDbPlan } | { ok: false; reason: string };
export interface ApplyResult { ok: boolean; messages: string[] }

/** 目前註冊使用的資料庫位置：env 的 RAG_DB，沒有就是預設。 */
export function currentDbPath(reg: McpRegistration, defaultPath: string): string {
  const v = reg.env?.RAG_DB;
  return typeof v === 'string' && v.trim() !== '' ? v : defaultPath;
}

/** 只規劃、不動任何東西：讀目前註冊、檢查新路徑、算出新的註冊內容。 */
export async function planRagDb(name: string, input: string, deps: RagDbDeps): Promise<PlanResult> {
  const original = await deps.readRegistration(name);
  if (!original) return { ok: false, reason: `在 Claude Code 的使用者設定（~/.claude.json）裡找不到名為「${name}」的 MCP 伺服器。請確認名稱（設定 claudeMonitor.ragServerName），或先註冊它。` };

  const oldPath = currentDbPath(original, deps.defaultPath);
  const check = checkNewDbPath(input, oldPath, deps.defaultPath, deps.probe);
  if (!check.ok) return { ok: false, reason: check.reason };

  const env = { ...(original.env ?? {}) };
  if (path.normalize(check.path).toLowerCase() === path.normalize(deps.defaultPath).toLowerCase()) delete env.RAG_DB; // 回到預設就不要多留一個環境變數
  else env.RAG_DB = check.path;
  const updated: McpRegistration = { ...original, ...(Object.keys(env).length > 0 ? { env } : {}) };
  if (Object.keys(env).length === 0) delete updated.env;

  return { ok: true, plan: { name, oldPath, newPath: check.path, hasDb: await deps.fs.exists(oldPath), original, updated } };
}

const sameRegistration = (a: McpRegistration | null, b: McpRegistration): boolean =>
  a !== null && a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args) && (a.env?.RAG_DB ?? '') === (b.env?.RAG_DB ?? '');

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 執行：① 搬資料庫（失敗就什麼都沒改）→ ② 移除舊註冊 → ③ 用新內容註冊 → ④ 讀回確認。
 * ②③④ 任何一步不對：還原原本的註冊，再把資料庫搬回原位。每一步都重新讀設定檔確認，不相信結束碼。
 */
export async function executeRagDb(plan: RagDbPlan, deps: RagDbDeps): Promise<ApplyResult> {
  const messages: string[] = [];
  const asJson = (r: McpRegistration): string => JSON.stringify(r);

  let move: MoveResult | null = null;
  if (plan.hasDb) {
    try {
      move = await moveDatabase(plan.oldPath, plan.newPath, deps.fs);
      messages.push(`已搬移資料庫：${plan.oldPath} → ${plan.newPath}`);
      messages.push(...move.warnings.map(w => `注意：${w}`));
    } catch (e) {
      return { ok: false, messages: [message(e), e instanceof DatabaseInUseError ? '註冊沒有改。' : '註冊沒有改，資料庫已盡力還原。'] };
    }
  } else {
    messages.push(`舊位置沒有資料庫檔案（${plan.oldPath}），只更新註冊；新位置會在 local-rag 第一次寫入時建立。`);
  }

  const rollback = async (reason: string): Promise<ApplyResult> => {
    const out = [...messages, reason];
    await deps.runner.run(['mcp', 'add-json', plan.name, asJson(plan.original), '-s', 'user']).catch(() => undefined);
    const restored = sameRegistration(await deps.readRegistration(plan.name), plan.original);
    out.push(restored ? '已還原原本的註冊。' : `⚠ 無法確認原本的註冊已還原！請手動執行：claude mcp add-json ${plan.name} '${asJson(plan.original)}' -s user`);
    if (move) {
      try { await move.undo(); out.push('已把資料庫搬回原位。'); }
      catch (e) { out.push(`⚠ 資料庫搬回原位失敗：${message(e)}。資料庫目前在 ${plan.newPath}。`); }
    }
    return { ok: false, messages: out };
  };

  try {
    await deps.runner.run(['mcp', 'remove', plan.name, '-s', 'user']);
    if (await deps.readRegistration(plan.name)) return await rollback('移除舊註冊失敗，設定檔裡它還在。');
    await deps.runner.run(['mcp', 'add-json', plan.name, asJson(plan.updated), '-s', 'user']);
    if (!sameRegistration(await deps.readRegistration(plan.name), plan.updated)) return await rollback('重新註冊後讀回的內容和預期不同。');
  } catch (e) {
    return await rollback(`重新註冊時發生錯誤：${message(e)}`);
  }

  messages.push(`已重新註冊「${plan.name}」，資料庫位置：${plan.newPath}`);
  messages.push('已經開著、用到 local-rag 的 Claude Code 對話要重新連線（/mcp）或重開才會改用新位置。');
  messages.push('RagCli（命令列工具）不吃這個註冊：要用同一個資料庫，請另外設定環境變數 RAG_DB。');
  return { ok: true, messages };
}
