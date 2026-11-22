// Read-only smoke probe. Prints aggregate counts, never transcript content.
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';
import * as path from 'node:path';
const output = buildSync({ entryPoints: [fileURLToPath(new URL('../src/core/codexScanner.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
const module = { exports: {} };
new Function('module', 'exports', 'require', output)(module, module.exports, createRequire(import.meta.url));
const scanner = new module.exports.CodexScanner(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const start = performance.now();
await scanner.refresh();
const first = scanner.snapshotCalls().length;
await scanner.refresh();
const sessions = scanner.snapshotSessions();
console.log(JSON.stringify({ found: scanner.found, sessions: sessions.length, calls: first,
  afterRescan: scanner.snapshotCalls().length, models: [...new Set(sessions.map(s => s.model))],
  elapsedMs: Math.round(performance.now() - start) }));
