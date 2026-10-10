import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

const output = process.argv[2] || 'build/update-endpoint.json';
const metadataUrl = process.env.WII_UPDATE_METADATA_URL;
assert.ok(metadataUrl, 'Set WII_UPDATE_METADATA_URL to configure an update-enabled release build.');
let parsed;
try { parsed = new URL(metadataUrl); } catch { throw new Error('WII_UPDATE_METADATA_URL must be a valid HTTPS URL.'); }
assert.equal(parsed.protocol, 'https:', 'WII_UPDATE_METADATA_URL must use HTTPS.');
assert.ok(!parsed.username && !parsed.password && !parsed.hash, 'WII_UPDATE_METADATA_URL must not contain credentials or a fragment.');
writeFileSync(output, `${JSON.stringify({ metadataUrl: parsed.toString(), channel: process.env.WII_UPDATE_CHANNEL || 'stable' }, null, 2)}\n`, { mode: 0o644 });
console.log(`Configured signed-update endpoint in ${output}.`);
