# Phase 6B security review and release acceptance

Review date: 2026-10-10. Scope was this checkout and local test environment only. This is an engineering review, not a claim of vulnerability-free software or an independent security assessment. No release, deployment, signing material, or production update metadata was published.

## Actual architecture reviewed

The desktop app creates one direct WebRTC host/viewer session. It has no signaling server, STUN service, TURN service, SSH client/server, tunnel implementation, remote shell, TCP listener, or cloud coordinator in the shipped runtime. Manual connection codes contain SDP with a WebRTC DTLS fingerprint and ICE credentials. The headless Linux agent is a per-user UNIX-domain-socket status service only; it cannot create a remote session, inject input, or listen on a network interface.

The following checks have an architecture-absence result, not a claim that an unimplemented component is secure:

| Area requested | Result | Evidence |
| --- | --- | --- |
| SSH host-key checking and tunnel destination allowlists | Not applicable: no SSH/tunnel implementation | Static review found no SSH client, `child_process` SSH invocation, or tunnel listener. |
| TURN credential issuance, allocations, and relay network policy | Not applicable: no TURN service or credentials | `directIceConfig()` fixes `iceServers: []`; invitation parsing rejects relay candidates. |
| File transfer filesystem roots/reparse races | No application filesystem write path | Received files stay in a browser Blob and are saved only by a user browser download action. The app strips path separators from display names. |
| File resume integrity | Not implemented | Transfers are reliable/ordered WebRTC messages with offsets, exact size, cancellation and receipt acknowledgement. There is no resume protocol to review or advertise. |

## Security control review

| Area | Reviewed behavior | Residual risk |
| --- | --- | --- |
| Pairing, authentication and identity | Codes expire in 10 minutes, have a UUID and complete SDP, and an answer carries a SHA-256 binding to the exact offer. A host accepts one response at a time. The viewer displays a 96-bit code derived from the invitation binding and response SDP; the host validates the pasted response, derives the same code, then must confirm an independent-channel comparison before connecting. WebRTC provides DTLS transport encryption. | Codes are not a persistent identity or a user-authenticated pairing ceremony. A code exchanged through an attacker-controlled channel can still be substituted if people do not compare the verification code through an independent trusted channel. |
| Replay and authorization grants | Expired/replayed/wrong-offer responses fail validation. Control requires a live capture, connected session, a host-native consent dialog, exact display mapping, and a registered emergency shortcut. Disconnect/reconnect clears control; reconnect never restores it. | The host must still recognize and trust the person/device receiving the code. |
| Key storage | No device private key or bookmark-to-identity binding exists. The update verifier ships public Ed25519 keys only; the checked-in key is a disabled development placeholder. | A production update channel cannot be enabled until a real public key is bridged in a signed release and its private half is held only in protected CI secrets. |
| Electron/preload/IPC | Renderer has sandboxing, context isolation, no Node integration and restrictive CSP. Navigation and new windows are denied. Main-process IPC validates the exact local main frame before every privileged handler. The preload bridge exposes only named functions. | Chromium/Electron version maintenance and an independent Electron review remain required. |
| Native input | Input accepts a fixed keyboard/button vocabulary and finite normalized coordinates. Its queue is 128 operations, native calls are serialized by an epoch, and revocation releases held input. | Native input is inherently high impact after a host approves it; UAC/secure desktops and OS accessibility policy remain outside this app's authority. |
| Local agent and background service | The agent uses only a private, owner-only runtime directory and a mode-0600 UNIX socket. It refuses to delete non-socket entries. Service installation/removal require `--i-consent`, are per-user, and the unit now restricts address families to `AF_UNIX`. | Linux target-device/systemd validation is still required. Same-user compromise is not defended by a per-user local socket. |
| Files, parser limits and resource use | Files are capped at 128 MiB, one per direction; chunks and controls are bounded; invalid offsets close the transfer. Chat/session/input have schema, size and rate limits. | A permitted 128 MiB received Blob can still be material on constrained systems. File-content malware scanning is deliberately not implemented. |
| Updates | Metadata has canonical Ed25519 verification, HTTPS/no-credential URLs, platform/architecture matching, sequence/version rollback protection, a 512 KiB metadata cap, SHA-256 and exact-size artifact validation. Downloads now stream to a private exclusive temporary file, cap at 1 GiB, fsync, and atomically hard-link without overwrite. | No production trust root, signing credentials, update origin, or production update-install test is available. Downloads require a filesystem that supports same-directory hard links; failure is safe and leaves no installer. |

## Findings

| ID | Severity | Finding, reproduction, affected code | Remediation / retest | Status and residual risk |
| --- | --- | --- | --- | --- |
| SEC-6B-01 | High | Manual codes do not authenticate a persistent device or person. An active attacker on an untrusted code-exchange channel can substitute an invitation/answer and receive a screen session; host control still requires a local host consent. The earlier offer-only verification display also failed to detect a substituted response. Affected: `src/direct-signaling.js`, `src/peer.js`, `src/app.js`. | The host now validates the pasted response without applying it and derives a six-group code that binds the original invitation and response SDP; it can connect only after the host confirms an independent trusted-channel comparison. Before broader release, add reviewed authenticated-device identity and grant management. | **Partially mitigated; remains and blocks unsupervised/public pilot.** The UX detects invitation/response substitution only when users perform the independent comparison; it is not persistent identity. |
| SEC-6B-02 | Moderate | Update download buffered the whole artifact in memory and used predictable `.partial` plus rename, allowing large-memory pressure and a local final-path race. Affected pre-fix: `electron/update-client.cjs`. | Stream chunks directly to `O_EXCL` private temporary file, hash incrementally, limit an artifact to 1 GiB, fsync, then hard-link to final name (no replacement). Regression tests include size/hash failure and a destination race. | **Fixed and retested** by `tests/update-client.test.mjs`. The update channel itself remains disabled pending credentials. |
| SEC-6B-03 | Moderate | The agent created a predictable fallback runtime directory and unconditionally unlinked its socket path. A local file at that path could be deleted; a permissive pre-existing runtime directory weakened socket isolation. Affected pre-fix: `agent/main.cjs`. | Require an owner-only non-symlink directory and remove only a stale UNIX socket. Split/test the bounded local status server. Add `RestrictAddressFamilies=AF_UNIX` to the consent-installed systemd user unit. | **Fixed and retested** by `tests/agent-status-service.test.mjs`, including oversized input and stop/restart recovery. Same-user local attackers are outside this local permission boundary. |
| SEC-6B-04 | Moderate | Release verification accepted any installer-like file. An interrupted Intel package left a temporary DMG that the prior verifier treated as an installer. Affected pre-fix: `scripts/build-target.mjs`, `scripts/verify-release.mjs`. | Require exact names for every target's expected installer set and reject hidden/temporary installer files. | **Fixed and retested** by `tests/release-verifier.test.mjs`; fresh macOS Intel and Apple Silicon packages pass the tightened verifier. |
| SEC-6B-05 | High in build environment; Moderate in shipped native-input dependency | Full `npm audit` reports 2 high and 16 moderate dependency advisories. The high paths (`brace-expansion`, `http-cache-semantics`) are in Electron Builder's build-time dependency tree. The packaged runtime retains the no-fix `file-type@16.5.4` → Jimp → `@nut-tree-fork/nut-js` path; this app does not pass untrusted image/ASF input to it, but the vulnerable code is present. | `npm audit fix --package-lock-only --dry-run` proposed zero changes; the suggested Electron Builder replacement is not a safe automatic update. Track/vendor remediation with upstream, evaluate a maintained native-input provider, and rerun audit on every release candidate. | **Remaining; blocks production release pending written risk acceptance and remediation plan.** No claim is made that static non-reachability is proof of safety. |
| SEC-6B-06 | High release-control gap | Production metadata signing/notarization/Authenticode and clean-machine install/upgrade/uninstall evidence are unavailable. The checked-in update endpoint is disabled and the public update key is a development placeholder. | Provision protected CI secrets, a real offline-generated Ed25519 update key, signed bridge release, update origin, code-signing/notarization, and clean-device validation. | **Remaining; blocks all distribution pilots.** Local packages are clearly unsigned development artifacts. |

## Tests and commands actually run

| Command | Result |
| --- | --- |
| `npm run check` | Passed; 41 JavaScript files syntax-checked after the final changes. |
| `npm test` | Passed locally: 41 tests, 0 failures. Coverage includes response-bound session-verification and non-connecting host review, malformed-answer flood (400 inputs), input-message flood shutdown, deterministic malformed code/message/binary fuzzing (1,000 cases), file offsets/backpressure, update download size/hash/race handling, SemVer rollback ordering, and local agent oversized-request/restart behavior. |
| `npm audit --omit=dev --audit-level=low` | Completed: 7 moderate findings through the native-input dependency chain; no fix offered. |
| `npm audit --audit-level=low --json` | Completed: 18 findings total (2 high, 16 moderate). High findings are in build tooling; no automatic fix plan was produced. |
| `npm audit fix --package-lock-only --dry-run --json` | Completed: 0 package changes proposed. |
| `npm run dist:mac:silicon`, `npm run dist:mac:intel`, `npm run verify:release` | Passed for the two available macOS package targets. Final verifier required exact DMG and ZIP artifacts and found only the matching native runtime. |
| `hdiutil verify` on both macOS DMGs | Passed. ARM64 app is ad-hoc signed; Intel app is unsigned. Neither has a Developer ID signature/notarization. |
| Packaged-ASAR inspection | Passed: both macOS apps include the updated explicit verifier/client and contain no Electron Builder `app-update.yml` publisher configuration. |
| `npm run smoke` | Harness path fixed. This host has no capturable display, so it now emits `artifacts/serverless/smoke-unavailable.json` and exits 77 with `No displays available`; it is **not** counted as a UI/integration pass. |

## Release acceptance matrix

| Deliverable / feature | Automated evidence | Manual/clean-machine evidence | Acceptance |
| --- | --- | --- | --- |
| Windows x64 desktop | Packaging configuration and native-architecture gate reviewed | Windows build, Authenticode, installer, launch, repair/upgrade/uninstall, control and OS-permission tests unavailable | **Blocked** |
| macOS Intel desktop | Fresh unsigned package, exact-artifact/runtime checks, DMG checksum passed | Clean Intel device install/launch/permissions/upgrade/uninstall and Developer ID/notarization unavailable | **Blocked for distribution**; development artifact only |
| macOS Apple Silicon desktop | Fresh unsigned/ad-hoc package, exact-artifact/runtime checks, DMG checksum passed | Clean Apple Silicon install/launch/permissions/upgrade/uninstall and Developer ID/notarization unavailable | **Blocked for distribution**; development artifact only |
| Ubuntu x64 desktop DEB | Configuration reviewed | Native Linux build, dependency installation, launch, X11/Wayland behavior, package lifecycle unavailable | **Blocked** |
| Ubuntu ARM64 desktop DEB | Gate/configuration reviewed | Native module ABI, native build and clean-machine checks unavailable | **Blocked** |
| Linux x64 headless agent DEB | Local status protocol, crash/restart and service hardening tests passed | Linux package install, explicit service consent, `systemctl --user`, restart, upgrade/remove unavailable | **Blocked** |
| Linux ARM64 headless agent DEB | Gate/configuration reviewed | Native module ABI, build and systemd lifecycle unavailable | **Blocked** |
| Direct screen/chat/files/session logic | Unit/parser/flood/file tests and response-bound session-verification passed; refreshed macOS ARM64/x64 packages were inspected for the revised host review/confirmation gate | Electron requires a host with a capturable display/Screen Recording grant to exercise the visual host-confirmation flow; two-machine user acceptance unavailable | **Component-tested only** |
| Remote control | Input validation, queue/revocation and consent unit tests passed | Real OS input/accessibility and secure-desktop validation unavailable | **Component-tested only** |
| Authenticated updates | Signature/rollback/download tests passed | Production key, signed metadata, HTTPS origin and install/update flow unavailable | **Blocked** |
| SSH/TURN/unattended remote access | Deliberately absent | Not applicable | **Not a product feature** |

## Pilot decision and remaining release requirements

No packaged platform is accepted for an external or end-user limited pilot. A source-based, supervised engineering exercise may use the component-tested direct workflow only between known participants who exchange codes through an independent trusted channel; it is not a release acceptance or a security audit.

Before even a limited distributed pilot, the release owner must complete all of the following:

1. Resolve or formally time-box/accept the dependency findings with an upstream/vendor plan, especially the packaged native-input chain and CI build-tool highs.
2. Implement/review authenticated device/person pairing, or constrain the pilot to an independently authenticated support process with documented code verification.
3. Provision protected CI signing secrets, a real update public key/private key custody process, production update endpoint, signed bridge release and rollback drill.
4. Produce code-signed/notarized installers and validate their signatures on clean target machines.
5. Run clean-machine installation, launch, OS consent, service operation, upgrade, preserving uninstall, destructive data removal, and crash/recovery tests for every proposed platform.
6. Run the full two-app/two-device integration suite on a display-capable, Screen-Recording-authorized host; add an independent security assessment before public or unattended-access claims.
7. Obtain explicit release-owner approval of the exact commit, artifacts, SBOM/notices/checksums, findings disposition, and pilot scope. Do not publish automatically.
