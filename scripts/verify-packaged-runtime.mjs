import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { extractFile, listPackage } = require('@electron/asar');

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

export function findResources(appDir) {
  const candidates = [
    path.join(appDir, 'resources'),
    path.join(appDir, 'Resources'),
    path.join(appDir, 'Contents', 'Resources')
  ];
  if (existsSync(appDir)) {
    for (const entry of readdirSync(appDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.endsWith('.app')) candidates.push(path.join(appDir, entry.name, 'Contents', 'Resources'));
    }
  }
  const result = candidates.find(candidate => existsSync(path.join(candidate, 'app.asar')));
  assert.ok(result, `Could not find resources/app.asar below ${appDir}`);
  return result;
}

export function nativeArchitecture(file) {
  const bytes = readFileSync(file);
  assert.ok(bytes.length >= 24, `${file} is too small to be a native binary`);
  // ELF e_machine is little endian at byte 18.
  if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    const machine = bytes.readUInt16LE(18);
    return ({ 62: 'x64', 183: 'arm64' })[machine] || `elf-${machine}`;
  }
  // PE uses an offset at 0x3c followed by the COFF machine field.
  if (bytes.subarray(0, 2).equals(Buffer.from('MZ'))) {
    const offset = bytes.readUInt32LE(0x3c);
    assert.ok(offset + 6 <= bytes.length && bytes.subarray(offset, offset + 4).equals(Buffer.from('PE\0\0')), `${file} is not a PE image`);
    const machine = bytes.readUInt16LE(offset + 4);
    return ({ 0x8664: 'x64', 0xaa64: 'arm64' })[machine] || `pe-${machine}`;
  }
  // Mach-O thin (little endian) and universal/fat headers (big endian).
  const magicLE = bytes.readUInt32LE(0);
  if (magicLE === 0xfeedfacf) {
    const cpu = bytes.readUInt32LE(4);
    return ({ 0x01000007: 'x64', 0x0100000c: 'arm64' })[cpu] || `macho-${cpu}`;
  }
  const magicBE = bytes.readUInt32BE(0);
  if (magicBE === 0xcafebabe || magicBE === 0xcafebabf) {
    const count = bytes.readUInt32BE(4);
    const entryBytes = magicBE === 0xcafebabf ? 32 : 20;
    const architectures = new Set();
    for (let index = 0; index < count; index += 1) {
      const offset = 8 + index * entryBytes;
      assert.ok(offset + 4 <= bytes.length, `${file} has a truncated fat Mach-O header`);
      const cpu = bytes.readUInt32BE(offset);
      const mapped = ({ 0x01000007: 'x64', 0x0100000c: 'arm64' })[cpu];
      if (mapped) architectures.add(mapped);
    }
    return [...architectures].sort().join('+') || 'macho-fat-unknown';
  }
  return 'unknown';
}

function assertRuntimeExecutable(appDir, platform) {
  if (platform === 'darwin') {
    const executableDir = path.join(appDir, 'Contents', 'MacOS');
    assert.ok(existsSync(executableDir) && readdirSync(executableDir).some(name => statSync(path.join(executableDir, name)).isFile()), 'Mac app executable is missing');
  } else if (platform === 'win32') {
    assert.ok(readdirSync(appDir).some(name => /\.exe$/i.test(name)), 'Windows Electron executable is missing');
  } else {
    assert.ok(readdirSync(appDir).some(name => statSync(path.join(appDir, name)).isFile() && !name.includes('.')), 'Linux Electron executable is missing');
  }
}

export function verifyPackagedRuntime({ appDir, platform, arch, expectedMain }) {
  assert.ok(['win32', 'darwin', 'linux'].includes(platform), `Unsupported platform ${platform}`);
  assert.ok(['x64', 'arm64'].includes(arch), `Unsupported architecture ${arch}`);
  const resources = findResources(appDir);
  const archive = path.join(resources, 'app.asar');
  const metadata = JSON.parse(extractFile(archive, 'package.json'));
  assert.equal(metadata.productName, 'WiiUltraConnect');
  if (expectedMain) assert.equal(metadata.main, expectedMain, 'Packaged entry point differs from the target configuration');
  assert.ok(!listPackage(archive).some(file => /^\/(server|scripts|tests)\//.test(file)), 'Server or test-only code must not ship');

  const expectedPackage = { win32: 'libnut-win32', darwin: 'libnut-darwin', linux: 'libnut-linux' }[platform];
  const nutRoot = path.join(resources, 'app.asar.unpacked', 'node_modules', '@nut-tree-fork');
  assert.ok(existsSync(nutRoot), 'Unpacked native runtime is missing');
  const platformPackages = readdirSync(nutRoot).filter(name => name.startsWith('libnut-'));
  assert.deepEqual(platformPackages, [expectedPackage], `Expected only ${expectedPackage}, found ${platformPackages.join(', ') || 'none'}`);
  if (platform === 'darwin') assert.ok(existsSync(path.join(nutRoot, 'node-mac-permissions')), 'macOS permission helper is missing');
  else assert.ok(!existsSync(path.join(nutRoot, 'node-mac-permissions')), 'macOS permission helper shipped on a non-macOS target');

  const nativeModule = path.join(nutRoot, expectedPackage, 'build', 'Release', 'libnut.node');
  assert.ok(existsSync(nativeModule), `Missing ${expectedPackage} native module`);
  const actualArch = nativeArchitecture(nativeModule);
  const accepted = platform === 'darwin' ? actualArch.split('+').includes(arch) : actualArch === arch;
  assert.ok(accepted, `Native module architecture ${actualArch} does not support ${platform}/${arch}`);
  const runtimeRoot = platform === 'darwin' ? path.dirname(path.dirname(resources)) : appDir;
  assertRuntimeExecutable(runtimeRoot, platform);
  return { resources, nativeModule, actualArch };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const appDir = option('--app-dir');
  const platform = option('--platform');
  const arch = option('--arch');
  const expectedMain = option('--main');
  assert.ok(appDir && platform && arch, 'Usage: verify-packaged-runtime --app-dir <path> --platform <platform> --arch <arch> [--main <entry>]');
  const result = verifyPackagedRuntime({ appDir, platform, arch, expectedMain });
  console.log(`Verified bundled Electron runtime and ${result.actualArch} native module: ${path.resolve(appDir)}`);
}
