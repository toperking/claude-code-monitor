// 建置：① 擴充功能主機（Node，cjs）→ dist/extension.js  ② Webview（瀏覽器，iife）→ media/webview.js
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const shared = { bundle: true, sourcemap: false, minify: false, logLevel: 'info' };

const targets = [
  { ...shared, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'] },
  { ...shared, entryPoints: ['src/webview/main.ts'], outfile: 'media/webview.js', platform: 'browser', format: 'iife', target: 'chrome110' },
];

if (watch) {
  for (const t of targets) await (await esbuild.context(t)).watch();
} else {
  for (const t of targets) await esbuild.build(t);
}
