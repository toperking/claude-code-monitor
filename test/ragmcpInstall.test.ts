import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { McpRegistration } from '../src/ragdb/plan';
import { BundleFiles, codexBlock, codexHasEntry, executeInstall, hasDotnet8, InstallDeps, planInstall } from '../src/ragmcp/install';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))); });

/** 假的 claude：把 add-json／remove 套用到記憶體裡的「註冊表」，讓 readRegistration 讀得回來。 */
function fakeDeps(bundle: string, local: string, home: string, opts: { registry?: Map<string, McpRegistration>; dotnet?: string | Error; failAdd?: boolean } = {}): InstallDeps & { registry: Map<string, McpRegistration>; calls: string[][] } {
  const registry = opts.registry ?? new Map<string, McpRegistration>();
  const calls: string[][] = [];
  return {
    bundleDir: bundle, localAppData: local, home, registry, calls,
    runner: {
      async run(args) {
        calls.push(args);
        if (args[1] === 'remove') registry.delete(args[2]);
        else if (args[1] === 'add-json' && !opts.failAdd) registry.set(args[2], JSON.parse(args[3]) as McpRegistration);
        return { code: 0, stderr: '' };
      },
    },
    readRegistration: async name => registry.get(name) ?? null,
    dotnetRuntimes: async () => { const d = opts.dotnet ?? 'Microsoft.NETCore.App 8.0.22 [C:\\dotnet]'; if (d instanceof Error) throw d; return d; },
  };
}

async function env(): Promise<{ bundle: string; local: string; home: string; project: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ragmcp-test-'));
  dirs.push(root);
  const bundle = path.join(root, 'bundle');
  for (const f of BundleFiles) {
    const p = path.join(bundle, f);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, `content of ${f}`);
  }
  const local = path.join(root, 'local');
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  await Promise.all([local, home, project].map(d => fs.mkdir(d)));
  return { bundle, local, home, project };
}

describe('打包進擴充功能的 RagMcp', () => {
  it('ragmcp 資料夾含所有必要檔案（沒有就代表打包會漏檔）', async () => {
    const dir = fileURLToPath(new URL('../ragmcp', import.meta.url));
    for (const f of BundleFiles) expect((await fs.stat(path.join(dir, f))).size).toBeGreaterThan(0);
  });
});

describe('hasDotnet8', () => {
  it('needs Microsoft.NETCore.App 8 or newer', () => {
    expect(hasDotnet8('Microsoft.NETCore.App 8.0.22 [C:\\x]')).toBe(true);
    expect(hasDotnet8('Microsoft.NETCore.App 6.0.36 [x]\nMicrosoft.NETCore.App 10.0.1 [x]')).toBe(true);
    expect(hasDotnet8('Microsoft.NETCore.App 6.0.36 [x]\nMicrosoft.AspNetCore.App 9.0.1 [x]')).toBe(false);
    expect(hasDotnet8('')).toBe(false);
  });
});

describe('Codex config.toml helpers', () => {
  it('detects an existing section in plain, quoted and nested-table forms', () => {
    expect(codexHasEntry('[mcp_servers.local-rag]\ncommand = "x"', 'local-rag')).toBe(true);
    expect(codexHasEntry('[mcp_servers."local-rag"]', 'local-rag')).toBe(true);
    expect(codexHasEntry('[mcp_servers.local-rag.env]\nRAG_DB = "x"', 'local-rag')).toBe(true);
    expect(codexHasEntry('[mcp_servers.other]\n', 'local-rag')).toBe(false);
    expect(codexHasEntry('# [mcp_servers.local-rag]\n', 'local-rag')).toBe(false);
  });

  it('writes Windows paths as TOML literal strings and refuses unsafe values', () => {
    const block = codexBlock('local-rag', { command: 'dotnet', args: ['C:\\a\\RagMcp.dll'], env: { RAG_DB: 'D:\\ragData\\rag.db' } });
    expect(block).toContain("args = ['C:\\a\\RagMcp.dll']");
    expect(block).toContain("[mcp_servers.local-rag.env]\nRAG_DB = 'D:\\ragData\\rag.db'");
    expect(() => codexBlock('local-rag', { command: 'dotnet', args: ["C:\\it's\\x.dll"] })).toThrow('單引號');
  });
});

describe('local-rag install', () => {
  it('installs the program, config.json and both registrations, and is idempotent', async () => {
    const e = await env();
    await fs.mkdir(path.join(e.home, '.codex'));
    await fs.writeFile(path.join(e.home, '.codex', 'config.toml'), 'model = "x"\n');
    const deps = fakeDeps(e.bundle, e.local, e.home);
    const plan = await planInstall({ name: 'local-rag', dbPath: 'D:\\ragData\\rag.db', projectRoot: e.project }, deps);
    expect(plan).toMatchObject({ claude: 'none', codex: 'add', dotnetOk: true, configExists: false });

    const result = await executeInstall(plan, deps);
    expect(result.ok).toBe(true);
    for (const f of BundleFiles) expect(await fs.readFile(path.join(plan.targetDir, f), 'utf8')).toBe(`content of ${f}`);
    const cfg = JSON.parse(await fs.readFile(plan.configPath, 'utf8')) as { roots: { project: string } };
    expect(cfg.roots.project).toBe(e.project);
    expect(deps.registry.get('local-rag')).toMatchObject({ command: 'dotnet', args: [plan.dllPath], env: { RAG_DB: 'D:\\ragData\\rag.db' } });
    const toml = await fs.readFile(path.join(e.home, '.codex', 'config.toml'), 'utf8');
    expect(toml.startsWith('model = "x"\n')).toBe(true);
    expect(codexHasEntry(toml, 'local-rag')).toBe(true);
    expect(await fs.readFile(path.join(e.home, '.codex', 'config.toml.claude-monitor.bak'), 'utf8')).toBe('model = "x"\n');

    const again = await planInstall({ name: 'local-rag', dbPath: 'D:\\ragData\\rag.db', projectRoot: e.project }, deps);
    expect(again).toMatchObject({ claude: 'same', codex: 'has-entry', configExists: true });
    const second = await executeInstall(again, deps);
    expect(second.ok).toBe(true);
    expect(await fs.readFile(path.join(e.home, '.codex', 'config.toml'), 'utf8')).toBe(toml); // 沒有重複附加
  });

  it('changes nothing when .NET 8 is missing', async () => {
    const e = await env();
    const deps = fakeDeps(e.bundle, e.local, e.home, { dotnet: new Error('ENOENT') });
    const plan = await planInstall({ name: 'local-rag', dbPath: '', projectRoot: e.project }, deps);
    expect(plan.dotnetOk).toBe(false);
    const result = await executeInstall(plan, deps);
    expect(result.ok).toBe(false);
    expect(deps.calls).toEqual([]);
    await expect(fs.stat(plan.targetDir)).rejects.toThrow();
  });

  it('replaces a different registration but keeps its RAG_DB, and restores it when registering fails', async () => {
    const e = await env();
    const original: McpRegistration = { type: 'stdio', command: 'dotnet', args: ['D:\\old\\RagMcp.dll'], env: { RAG_DB: 'E:\\keep\\rag.db' } };
    const deps = fakeDeps(e.bundle, e.local, e.home, { registry: new Map([['local-rag', original]]) });
    const plan = await planInstall({ name: 'local-rag', dbPath: '', projectRoot: e.project }, deps);
    expect(plan.claude).toBe('different');
    expect(plan.registration.env?.RAG_DB).toBe('E:\\keep\\rag.db');
    expect((await executeInstall(plan, deps)).ok).toBe(true);
    expect(deps.registry.get('local-rag')?.args).toEqual([plan.dllPath]);

    const failing = fakeDeps(e.bundle, e.local, e.home, { registry: new Map([['local-rag', original]]), failAdd: true });
    const failPlan = await planInstall({ name: 'local-rag', dbPath: '', projectRoot: e.project }, failing);
    const result = await executeInstall(failPlan, failing);
    expect(result.ok).toBe(false);
    expect(result.messages.join('\n')).toContain('註冊後讀回的內容和預期不同');
  });

  it('keeps an existing config.json and leaves a Codex entry that is already there alone', async () => {
    const e = await env();
    await fs.mkdir(path.join(e.home, '.codex'));
    const toml = '[mcp_servers.local-rag]\ncommand = "dotnet"\n';
    await fs.writeFile(path.join(e.home, '.codex', 'config.toml'), toml);
    await fs.mkdir(path.join(e.local, 'LocalRag'), { recursive: true });
    await fs.writeFile(path.join(e.local, 'LocalRag', 'config.json'), '{"roots":{"mine":"X"}}');
    const deps = fakeDeps(e.bundle, e.local, e.home);
    const plan = await planInstall({ name: 'local-rag', dbPath: '', projectRoot: e.project }, deps);
    expect(plan).toMatchObject({ configExists: true, codex: 'has-entry' });
    await executeInstall(plan, deps);
    expect(await fs.readFile(plan.configPath, 'utf8')).toBe('{"roots":{"mine":"X"}}');
    expect(await fs.readFile(path.join(e.home, '.codex', 'config.toml'), 'utf8')).toBe(toml);
  });

  it('refuses when the bundle is incomplete', async () => {
    const e = await env();
    await fs.rm(path.join(e.bundle, 'Rag.dll'));
    await expect(planInstall({ name: 'local-rag', dbPath: '', projectRoot: e.project }, fakeDeps(e.bundle, e.local, e.home))).rejects.toThrow('Rag.dll');
  });
});
