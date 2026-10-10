import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { verifyEnvelope, artifactFor, verifyArtifactFile } = require('../electron/update-verifier.cjs');
function value(name) { const index = process.argv.indexOf(name); return index === -1 ? undefined : process.argv[index + 1]; }

const metadataPath = value('--metadata');
const artifactPath = value('--artifact');
const platform = value('--platform');
const arch = value('--arch');
const format = value('--format');
const target = value('--target') || 'desktop';
assert.ok(metadataPath && artifactPath && platform && arch, 'Usage: verify-update-artifact --metadata <json> --artifact <file> --platform <platform> --arch <arch> [--format <format>] [--target desktop|agent]');
const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
const keyring = JSON.parse(readFileSync('build/update-keys.json', 'utf8'));
const verified = verifyEnvelope(metadata, keyring, {});
const artifact = artifactFor(verified.signed, { target, platform, arch, format });
verifyArtifactFile(artifactPath, artifact);
console.log(`Verified signed update artifact ${artifact.name} with ${verified.verifiedKeyId}.`);
