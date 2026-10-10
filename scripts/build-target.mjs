import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyPackagedRuntime } from './verify-packaged-runtime.mjs';

const args = process.argv.slice(2);
function value(name) { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; }
const target = value('--target');
const arch = value('--arch');
const dirOnly = args.includes('--dir');
const targets = {
  mac: { host: 'darwin', platform: 'darwin', builderFlag: '--mac', config: 'electron-builder.yml', output: `mac-${arch}`, unpacked: arch === 'x64' ? 'mac' : 'mac-arm64', main: 'electron/main.cjs' },
  win: { host: 'win32', platform: 'win32', builderFlag: '--win', config: 'electron-builder.yml', output: `win-${arch}`, unpacked: 'win-unpacked', main: 'electron/main.cjs' },
  linux: { host: 'linux', platform: 'linux', builderFlag: '--linux', config: 'electron-builder.yml', output: `linux-${arch}`, unpacked: 'linux-unpacked', main: 'electron/main.cjs' },
  'agent-linux': { host: 'linux', platform: 'linux', builderFlag: '--linux', config: 'electron-builder.agent.yml', output: `agent-linux-${arch}`, unpacked: 'linux-unpacked', main: 'agent/main.cjs' }
};

assert.ok(targets[target], `Unknown target ${target}. Use mac, win, linux, or agent-linux.`);
assert.ok(['x64', 'arm64'].includes(arch), '--arch must be x64 or arm64');
if (target === 'win') assert.equal(arch, 'x64', 'Windows installer support is x64 only.');
const config = targets[target];
assert.equal(process.platform, config.host, `${target}/${arch} must be built on ${config.host}; cross-host artifacts are not accepted as release candidates.`);
if (config.host !== 'darwin') assert.equal(process.arch, arch, `${target}/${arch} needs a native ${arch} runner so its native module can be verified.`);

const output = path.join('release', config.output);
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
function expectedArtifacts() {
  if (target === 'mac') return [`WiiUltraConnect-${version}-mac-${arch}.dmg`, `WiiUltraConnect-${version}-mac-${arch}.zip`];
  if (target === 'win') return [`WiiUltraConnect-${version}-windows-x64-setup.exe`];
  if (target === 'linux') return [`wiiultraconnect_${version}_${arch === 'x64' ? 'amd64' : 'arm64'}.deb`];
  return [`wiiultraconnect-agent_${version}_${arch === 'x64' ? 'amd64' : 'arm64'}.deb`];
}
// Each target has an isolated, known build-output directory. Removing it
// prevents a prior architecture/version from entering release materials.
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const builder = process.platform === 'win32' ? 'node_modules/.bin/electron-builder.cmd' : 'node_modules/.bin/electron-builder';
const buildArgs = [config.builderFlag, `--${arch}`, '--config', config.config, `--config.directories.output=${output}`];
if (dirOnly) buildArgs.push('--dir');
const result = spawnSync(builder, buildArgs, { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const appDir = path.join(output, config.unpacked);
const checked = verifyPackagedRuntime({ appDir, platform: config.platform, arch, expectedMain: config.main });
if (!dirOnly) {
  const entries = readdirSync(output);
  const temporary = entries.filter(name => name.startsWith('.temp') || /^\.[A-Za-z0-9_-]+.*\.(exe|dmg|zip|deb)$/i.test(name));
  assert.deepEqual(temporary, [], `Packaging left temporary installer files in ${output}: ${temporary.join(', ')}`);
  for (const artifact of expectedArtifacts()) assert.ok(entries.includes(artifact) && statSync(path.join(output, artifact)).isFile(), `Expected installer was not produced: ${path.join(output, artifact)}`);
}
console.log(`Build verification passed for ${target}/${arch}: ${checked.nativeModule}`);
