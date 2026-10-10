# Build and release

This repository builds self-contained Electron distributions. End users do not need Node.js, npm, Cargo, a compiler, or an SDK. The packaged Electron executable supplies the JavaScript runtime; the matching `@nut-tree-fork/libnut-*` module is unpacked beside it and is verified before an installer is accepted.

No command in this document publishes a GitHub Release, writes to an update origin, or exports a certificate/private key.

## Locked build inputs

- Node.js **22.14.0** and npm are required for release builds. Use `npm ci --include=optional`; do not substitute `npm install` in CI.
- `package-lock.json` locks all npm inputs. GitHub Actions are pinned to full commit IDs in [package.yml](../.github/workflows/package.yml).
- Build each target on its matching OS. Windows and Linux also require a native matching-CPU runner; the wrapper rejects other combinations because their native module must match exactly. macOS can package either requested architecture on macOS because the native module is universal, but the final Intel/Apple-Silicon acceptance run must occur on the matching hardware. Every build inspects the final unpacked Electron app for the required `libnut` platform binary and CPU architecture.
- The target command clears only its explicit `release/<target>` build-output directory before packaging, preventing stale architecture/version artifacts from entering a release manifest. It never deletes another target's directory or publishes an artifact.
- Set `SOURCE_DATE_EPOCH` consistently when the underlying Electron tooling supports reproducible timestamps. Record the Electron, Node, npm, and host-image versions with the build artifacts. Installer byte-for-byte reproducibility still depends on upstream Electron/NSIS/DMG tools honoring that timestamp.

## Supported build matrix and output locations

`<version>` is the `version` in `package.json`. Each command writes only below its target directory.

| Deliverable | Accepted build host | Command | Installer artifacts | Unpacked inspection directory |
| --- | --- | --- | --- | --- |
| Windows x64 | Windows x64 | `npm run dist:win` | `release/win-x64/WiiUltraConnect-<version>-windows-x64-setup.exe` | `release/win-x64/win-unpacked` |
| macOS Intel | macOS (macOS x64 runner in CI; Apple Silicon packaging is permitted) | `npm run dist:mac:intel` | `release/mac-x64/WiiUltraConnect-<version>-mac-x64.dmg` and `.zip` | `release/mac-x64/mac` |
| macOS Apple Silicon | macOS (Apple Silicon runner in CI) | `npm run dist:mac:silicon` | `release/mac-arm64/WiiUltraConnect-<version>-mac-arm64.dmg` and `.zip` | `release/mac-arm64/mac-arm64` |
| Ubuntu x64 DEB | Ubuntu x64 | `npm run dist:linux:x64` | `release/linux-x64/wiiultraconnect_<version>_amd64.deb` | `release/linux-x64/linux-unpacked` |
| Ubuntu ARM64 DEB | Ubuntu ARM64 | `npm run dist:linux:arm64` | `release/linux-arm64/wiiultraconnect_<version>_arm64.deb` | `release/linux-arm64/linux-unpacked` |
| Headless Linux agent x64 | Ubuntu x64 | `npm run dist:agent:linux:x64` | `release/agent-linux-x64/wiiultraconnect-agent_<version>_amd64.deb` | `release/agent-linux-x64/linux-unpacked` |
| Headless Linux agent ARM64 | Ubuntu ARM64 | `npm run dist:agent:linux:arm64` | `release/agent-linux-arm64/wiiultraconnect-agent_<version>_arm64.deb` | `release/agent-linux-arm64/linux-unpacked` |

The macOS `libnut` module is a universal binary and is accepted only when it contains the requested x64 or arm64 slice. Windows and Linux modules must have exactly the requested architecture. Packaging removes the other platform modules instead of shipping a multi-platform native tree.

## Build commands

Run the initial checks on every build host:

```sh
npm ci --include=optional
npm run check
npm test
```

Then run exactly one native target command from the table. For a local native-host convenience build, `npm run dist` builds the two macOS outputs on macOS, the Windows output on Windows, or the desktop and agent Linux outputs for the host architecture on Linux.

After builds:

```sh
npm run verify:release
node scripts/generate-release-materials.mjs \
  --input release/win-x64 \
  --input release/mac-x64 \
  --input release/mac-arm64 \
  --input release/linux-x64 \
  --input release/agent-linux-x64 \
  --output release/materials
```

The last command creates these reviewable release materials:

- `release/materials/SHA256SUMS`
- `release/materials/THIRD_PARTY_NOTICES.md`
- `release/materials/wiiultraconnect.sbom.cdx.json` (CycloneDX 1.5)

Only list target directories actually built in the command. The files are intentionally generated outside installer directories, so stale installer files cannot silently enter a checksum list.

## OS and architecture policy

The exact release policy is:

| Family | Minimum supported version / architecture | Runtime facts |
| --- | --- | --- |
| Windows | Windows 10 22H2 x64; Windows 11 x64 | Per-user NSIS install by default. Remote input can be blocked at UAC/secure desktop. |
| macOS Intel | macOS 12.0 (Monterey) or later, x86_64 | Requires Screen Recording for sharing and Accessibility for control. |
| macOS Apple Silicon | macOS 12.0 or later, arm64 | Same permissions; the bundle is native arm64. |
| Ubuntu desktop x64 | Ubuntu 22.04 LTS or 24.04 LTS, x86_64, glibc 2.35+ | X11 is required for remote input. Wayland viewing/capture depends on the desktop portal and remote input is disabled. |
| Ubuntu desktop ARM64 | Ubuntu 22.04 LTS or 24.04 LTS, arm64, glibc 2.35+ | **Pending native-agent ABI validation.** The build gate will reject an x64 `libnut.node`; do not claim ARM64 support from a CI archive alone. |
| Headless Linux agent | Ubuntu 22.04/24.04 x64; ARM64 pending the same gate | Local UNIX-socket status agent only; it is not unattended remote access. |

The desktop Linux DEB declares the Electron/GTK/X11/audio dependencies explicitly: `libasound2`, `libatk-bridge2.0-0`, `libatk1.0-0`, `libatspi2.0-0`, `libc6 (>= 2.35)`, `libcairo2`, `libdrm2`, `libgbm1`, `libglib2.0-0`, `libgtk-3-0`, `libnspr4`, `libnss3`, `libpango-1.0-0`, `libx11-6`, `libx11-xcb1`, `libxcb1`, `libxcomposite1`, `libxdamage1`, `libxext6`, `libxfixes3`, `libxkbcommon0`, `libxrandr2`, `libxss1`, `libxtst6`, and `xdg-utils`. The agent DEB declares its smaller Electron/runtime set. These are OS packages, not developer prerequisites.

## Code signing and notarization

The public workflow is least privilege (`contents: read`) and creates only expiring Actions review artifacts. It does not create a GitHub Release or upload anything to an update host.

Protected CI secrets are the only supported credential source:

| Target | Protected secret names | Result when present |
| --- | --- | --- |
| Windows | `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD` | Electron Builder Authenticode-signs the executable and NSIS installer; Windows update signature verification remains enabled. |
| macOS | `MACOS_CSC_LINK`, `MACOS_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Electron Builder signs with hardened runtime and notarizes when Apple credentials are complete. |
| Update metadata | `WII_UPDATE_SIGNING_KEY` | Signs release metadata with Ed25519; this is used only in an authorized release environment. |

If a platform certificate is absent, the build succeeds only as an **unsigned development artifact** and writes `BUILD_STATUS.txt` beside the installer. It must not be represented as a production release. Credentials are never committed, printed, uploaded as artifacts, or passed to pull-request builds from forks.

## Authenticated update metadata

The app has an explicit “Check updates” action. It remains disabled for the checked-in development configuration because [update-endpoint.json](../build/update-endpoint.json) has no URL. An authorized release pipeline must configure a dedicated HTTPS metadata URL **before packaging**; it must not point at arbitrary redirectors or HTTP:

```sh
export WII_UPDATE_METADATA_URL='https://updates.example.invalid/wiiultraconnect/wiiultraconnect-update.json'
npm run configure:update-endpoint
# Now run the reviewed platform packaging command. Fresh CI workspaces discard this generated endpoint configuration after the job.
```

`electron/update-verifier.cjs` accepts only canonical JSON signed by an embedded Ed25519 public key from `build/update-keys.json`. Each artifact has an HTTPS URL, platform, architecture, format, exact byte size, and SHA-256. The download is written only after its size and hash match. The accepted metadata sequence and highest accepted version are stored in the user's application data and reject lower sequences or versions on later checks.

To create metadata after all target artifacts have been reviewed, use an authorized, protected release environment:

```sh
export WII_UPDATE_BASE_URL='https://updates.example.invalid/wiiultraconnect'
export WII_UPDATE_SEQUENCE='42'             # monotonically increasing; never reuse
export WII_UPDATE_PUBLISHED_AT='2026-10-09T00:00:00.000Z'
export WII_UPDATE_KEY_ID='release-2026-bootstrap'
# Inject WII_UPDATE_SIGNING_KEY from the protected CI secret, never a file in this checkout.
node scripts/generate-update-metadata.mjs \
  --input release/win-x64 \
  --input release/mac-x64 \
  --input release/mac-arm64 \
  --input release/linux-x64 \
  --output release/update
```

Without `WII_UPDATE_SIGNING_KEY`, the command writes `UNSIGNED-DEVELOPMENT-ONLY.json`; the app will never trust it. With the key, it writes `wiiultraconnect-update.json`. Verify an individual artifact before publication:

```sh
node scripts/verify-update-artifact.mjs \
  --metadata release/update/wiiultraconnect-update.json \
  --artifact release/linux-x64/wiiultraconnect_<version>_amd64.deb \
  --platform linux --arch x64 --format deb
```

### Key rotation and rollback response

The trust root is compiled into each release; metadata cannot introduce its own key. Rotate by adding the new public key (with non-overlapping `keyId`, validity period, and `release-metadata` purpose) to a bridge application release, then sign that bridge release's metadata with the currently trusted key and OS code-signing certificate. The bridge accepts both keys; sign subsequent metadata with the new key, and remove the old key only in a later signed application release. If a key is compromised, stop publishing metadata from it, ship a newly code-signed installer containing a replacement key through an out-of-band trusted channel, and advance the update sequence. Never lower a sequence to “roll back”; publish a fixed higher-version/higher-sequence release instead.

The checked-in bootstrap key is a non-production placeholder. Provision a real offline-generated Ed25519 keypair, save the private half only in the protected CI secret store, and replace the public half through the signed bridge procedure before enabling a public update URL.

## Required release authorization gate

Before publishing any installer or metadata, an authorized release owner must approve: the exact Git commit/tag, supported-target validation evidence, code-signing/notarization result, `SHA256SUMS`, SBOM/notices, artifact verification, update sequence, and destination URL. This repository deliberately contains no release-publish job.
