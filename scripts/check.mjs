import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
}
const files = ['electron', 'server', 'src', 'scripts', 'tests'].flatMap(walk).filter(f => /\.(mjs|cjs|js)$/.test(f));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { console.error(result.stderr); process.exit(1); }
}
console.log(`Syntax checked ${files.length} JavaScript files.`);
