import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPackagedRuntime } from './verify-packaged-runtime.mjs';

const targets = [
  { output: 'mac-arm64', app: 'mac-arm64', platform: 'darwin', arch: 'arm64', main: 'electron/main.cjs' },
  { output: 'mac-x64', app: 'mac', platform: 'darwin', arch: 'x64', main: 'electron/main.cjs' },
  { output: 'win-x64', app: 'win-unpacked', platform: 'win32', arch: 'x64', main: 'electron/main.cjs' },
  { output: 'linux-x64', app: 'linux-unpacked', platform: 'linux', arch: 'x64', main: 'electron/main.cjs' },
  { output: 'linux-arm64', app: 'linux-unpacked', platform: 'linux', arch: 'arm64', main: 'electron/main.cjs' },
  { output: 'agent-linux-x64', app: 'linux-unpacked', platform: 'linux', arch: 'x64', main: 'agent/main.cjs' },
  { output: 'agent-linux-arm64', app: 'linux-unpacked', platform: 'linux', arch: 'arm64', main: 'agent/main.cjs' }
];
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
export function expectedArtifacts(target) {
  if (target.platform === 'darwin') return [`WiiUltraConnect-${version}-mac-${target.arch}.dmg`, `WiiUltraConnect-${version}-mac-${target.arch}.zip`];
  if (target.platform === 'win32') return [`WiiUltraConnect-${version}-windows-x64-setup.exe`];
  const packageName = target.main === 'agent/main.cjs' ? 'wiiultraconnect-agent' : 'wiiultraconnect';
  return [`${packageName}_${version}_${target.arch === 'x64' ? 'amd64' : 'arm64'}.deb`];
}
export function temporaryInstallerFiles(entries) {
  return entries.filter(name => name.startsWith('.temp') || /^\.[A-Za-z0-9_-]+.*\.(exe|dmg|zip|deb)$/i.test(name));
}

export function verifyRelease(root = '.') {
  let verified = 0;
  for (const target of targets) {
    const output = path.join(root, 'release', target.output);
    const appDir = path.join(output, target.app);
    if (!existsSync(appDir)) continue;
    const entries = readdirSync(output);
    assert.deepEqual(temporaryInstallerFiles(entries), [], `${target.output} contains temporary installer file(s)`);
    const installers = expectedArtifacts(target);
    for (const artifact of installers) assert.ok(entries.includes(artifact) && statSync(path.join(output, artifact)).isFile(), `${target.output} is missing expected installer ${artifact}`);
    verifyPackagedRuntime({ appDir, platform: target.platform, arch: target.arch, expectedMain: target.main });
    console.log(`Verified ${target.output}: ${installers.join(', ')}`);
    verified += 1;
  }
  if (!verified) console.log('No release target directories exist yet; nothing to verify.');
  return verified;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) verifyRelease();
