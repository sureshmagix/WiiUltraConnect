import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const output = process.argv[2];
assert.ok(output, 'Usage: write-build-status <release-directory>');
const signed = process.env.WII_SIGNING_PRESENT === 'true';
const platform = process.env.WII_BUILD_PLATFORM || 'unknown platform';
const detail = signed
  ? `Signing credentials were supplied for ${platform}. Verify the signature/notarization result in the build log before distribution.`
  : `UNSIGNED DEVELOPMENT ARTIFACT: no signing credentials were supplied for ${platform}. Do not represent this artifact as a production release.`;
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, 'BUILD_STATUS.txt'), `${detail}\n`);
