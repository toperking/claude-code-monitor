import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installRagMcpSkill } from '../src/skill/install';

const homes: string[] = [];
async function home(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rag-skill-test-'));
  homes.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe('RAG MCP skill installation', () => {
  it('creates both AI skills with the guide and remains idempotent', async () => {
    const root = await home();
    await Promise.all(['.claude', '.codex'].map(agent => fs.mkdir(path.join(root, agent))));
    const result = await installRagMcpSkill('local-rag', root);
    expect(result).toContain('Claude Code');
    expect(result).toContain('Codex');
    for (const agent of ['.claude', '.codex']) {
      const dir = path.join(root, agent, 'skills', 'rag-mcp');
      expect(await fs.readFile(path.join(dir, 'rag-MCP.md'), 'utf8')).toContain('rag_search');
      expect(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8')).toContain('[rag-MCP.md](rag-MCP.md)');
    }
    const entry = path.join(root, '.codex', 'skills', 'rag-mcp', 'SKILL.md');
    const before = await fs.readFile(entry, 'utf8');
    await installRagMcpSkill('local-rag', root);
    expect(await fs.readFile(entry, 'utf8')).toBe(before);
  });

  it('keeps an existing skill and does not overwrite a custom guide', async () => {
    const root = await home();
    await fs.mkdir(path.join(root, '.codex'));
    const dir = path.join(root, '.claude', 'skills', 'rag-mcp');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), 'existing skill\n');
    await installRagMcpSkill('local-rag', root);
    expect(await fs.readFile(path.join(dir, 'SKILL.md.claude-monitor.bak'), 'utf8')).toBe('existing skill\n');
    await fs.writeFile(path.join(dir, 'rag-MCP.md'), 'my guide');
    await expect(installRagMcpSkill('local-rag', root)).rejects.toThrow('自訂內容');
    expect(await fs.readFile(path.join(dir, 'rag-MCP.md'), 'utf8')).toBe('my guide');
  });

  it('rejects invalid MCP names before writing', async () => {
    const root = await home();
    await expect(installRagMcpSkill('bad\nname', root)).rejects.toThrow('MCP 名稱');
    await expect(fs.stat(path.join(root, '.claude'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('skips an AI whose user folder does not exist', async () => {
    const root = await home();
    await fs.mkdir(path.join(root, '.claude'));
    const result = await installRagMcpSkill('local-rag', root);
    expect(result).toContain('已略過：Codex');
    expect(await fs.readFile(path.join(root, '.claude', 'skills', 'rag-mcp', 'rag-MCP.md'), 'utf8')).toContain('rag_search');
    await expect(fs.stat(path.join(root, '.codex'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not create an AI folder when neither tool is installed', async () => {
    const root = await home();
    expect(await installRagMcpSkill('local-rag', root)).toContain('沒有安裝任何技能');
    expect(await fs.readdir(root)).toEqual([]);
  });
});
