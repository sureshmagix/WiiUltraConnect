import { spawnSync } from 'node:child_process';

const targets = process.platform === 'darwin'
  ? [['mac', 'arm64'], ['mac', 'x64']]
  : process.platform === 'win32'
    ? [['win', 'x64']]
    : [['linux', process.arch], ['agent-linux', process.arch]];

for (const [target, arch] of targets) {
  const result = spawnSync(process.execPath, ['scripts/build-target.mjs', '--target', target, '--arch', arch], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
