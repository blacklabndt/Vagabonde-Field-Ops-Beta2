// Local-only synthetic reproductions. No real network calls or persisted browser data.
// Run: node docs/reviews/beta-stability-app-repro.mjs
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const report = readFileSync(new URL('./2026-09-12-beta-stability-codex-app.md', import.meta.url), 'utf8');
const snippets = [...report.matchAll(/```js\r?\n([\s\S]*?)```/g)].map(match => match[1]);
if (snippets.length !== 3) throw new Error(`Expected 3 reproductions, found ${snippets.length}`);
const cwd = fileURLToPath(new URL('../../vite-app/', import.meta.url));
for (const [index, input] of snippets.entries()) {
  console.log(`APP-${index + 1} local reproduction`);
  const result = spawnSync(process.execPath, ['--input-type=module'], {
    input, cwd, encoding: 'utf8', timeout: 10000
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log('All three confirmed behaviors reproduced; no live requests made.');
