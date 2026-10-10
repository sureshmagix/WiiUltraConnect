import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedArtifacts, temporaryInstallerFiles } from '../scripts/verify-release.mjs';

test('release verification requires exact output names and rejects temporary installers', () => {
  // A partial Electron Builder file is never an acceptable substitute for the
  // expected DMG and ZIP pair.
  const files = ['.tempABCDWiiUltraConnect-0.3.0-mac-x64.dmg', 'WiiUltraConnect-0.3.0-mac-x64.dmg'];
  const expected = expectedArtifacts({ platform: 'darwin', arch: 'x64' });
  assert.deepEqual(temporaryInstallerFiles(files), ['.tempABCDWiiUltraConnect-0.3.0-mac-x64.dmg']);
  assert.equal(expected.every(name => files.includes(name)), false);
});
