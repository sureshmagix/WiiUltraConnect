# Validation — 0.3.0

Application validation was originally recorded on Windows, Node.js 22.14.0 and Electron 44.2.0 on 10–11 September 2026. Phase 6A packaging validation below was performed on macOS Apple Silicon with Node.js 22.22.0 and Electron 44.2.0 on 9 October 2026. These are local implementation checks, not an internet or cross-platform certification.

| Check | Result |
| --- | --- |
| JavaScript syntax | Passed, 35 files |
| Automated unit/regression tests | 29 passed |
| Capture before invitation; invalid/expired/mismatched codes; concurrent/repeated response guards | Passed |
| Real host and viewer app UI, isolated bridges | Passed (viewer uses a test-only bridge) |
| Real desktop capture and decoded WebRTC video | 1920×1080 at 30 FPS and 60 FPS capture targets passed |
| Four data channels; readiness gating and teardown | Passed |
| ICE configuration | Empty ICE-server list; direct host candidates; no relay or server-reflexive candidates |
| Service requests | No HTTP/HTTPS/WebSocket requests observed; requests blocked and WebSocket constructors replaced with throwing stubs during integration testing |
| Old signaling/ICE environment settings | Ignored, including invalid values |
| Chat both directions and HTML-safe rendering | Passed |
| Files both directions, explicit acceptance, SHA-256 byte comparison, receiver acknowledgement and Save file | Passed |
| Clipboard both directions | Passed; no clipboard write before explicit acceptance (OS clipboard replaced with a test double) |
| Control before consent | Blocked |
| Host consent denial, approval, viewer request and release | Passed; native dialogs use scripted test responses |
| Host emergency shortcut registration | Passed with Ctrl/Cmd + Alt + Shift + F12 |
| Fullscreen Chromium pointer/keyboard events → ViewerInput → WebRTC → trusted host IPC → InputController | Passed with final OS input calls recorded by a test double |
| Long-held key heartbeat and focus-loss release | Passed |
| Fullscreen bounds and persistent controls | Passed in viewer UI and with the production Electron permission handler |
| Fit/actual-size views, chat during fullscreen, exit fullscreen | Passed |
| Viewer quality requests | Updated host capture to 15 FPS during the session |
| Live display replacement | Recaptured the current display and replaced its video track while preserving the data channels |
| Native input bindings | Loaded inside Electron; real key enum mapping and mouse position query passed |
| Unpacked Windows build | Passed; packaged source compared byte-for-byte with the working tree |
| Windows distribution build | NSIS installer and portable ZIP created successfully; application signature is NotSigned |
| Dependency audit | Seven moderate entries through the bundled nut.js → Jimp → file-type dependency chain; no compatible automatic fix |

## Phase 6A packaging and update checks

| Check | Result |
| --- | --- |
| Electron Builder configuration and target wrapper | Passed locally; configuration is parsed by Electron Builder 26.15.3 and output is isolated per target. |
| Native runtime pruning/inspection | Passed for macOS arm64 and x64 outputs. Only `libnut-darwin` and the macOS permission helper remain; the universal native module contains both requested slices. |
| macOS Apple Silicon installer | Passed package build, ZIP content inspection, and `hdiutil verify` on `WiiUltraConnect-0.3.0-mac-arm64.dmg`. It is explicitly unsigned development output. |
| macOS Intel installer | Passed cross-package build from Apple Silicon, ZIP content inspection, and `hdiutil verify` on `WiiUltraConnect-0.3.0-mac-x64.dmg`. It was not launched on an Intel clean machine. |
| Release materials | Passed: SHA-256 checksums, third-party notices, and a CycloneDX 1.5 SBOM with 405 locked npm components were generated for the two locally built macOS targets. |
| Authenticated metadata verifier | Passed: Ed25519 signature, credential-free HTTPS-only URL, platform/architecture selection, safe artifact-name validation, size/SHA-256 matching, persistent rollback state, and SemVer sequence/version rollback tests are covered by the current automated suite. |
| No-key release metadata behavior | Passed: metadata generation without a private key emits only `UNSIGNED-DEVELOPMENT-ONLY.json`, which the verifier/application do not accept as a trusted envelope. |
| Implicit publisher/update origin | Passed: both macOS app bundles were inspected after packaging and contain no Electron Builder `app-update.yml`; the checked-in endpoint configuration keeps the explicit update action disabled. |
| Windows x64 NSIS installer/signature/repair/uninstall | Pending: requires a Windows x64 clean machine and protected signing certificate. |
| Ubuntu x64 desktop DEB | Pending: requires an Ubuntu x64 build and clean-machine install/launch/upgrade/uninstall test. |
| Ubuntu ARM64 desktop DEB | Pending: the architecture gate must observe an ARM64 `libnut.node` on a native runner before an artifact can be considered supported. |
| Headless Linux agent DEBs and explicit user service | Pending: requires Ubuntu x64/ARM64 target machines to install, consent to `systemctl --user`, test status, disable service, upgrade, and remove. |
| Signed production metadata/download/notarization | Pending: no protected signing credentials or authorized update origin were available in this workspace. |
| GitHub workflow publication boundary | Passed by configuration review: workflow has `contents: read`, uploads only expiring review artifacts, and contains no release/publish step. |

The smoke runner launches two Electron windows and exchanges codes directly through its test runner. It does not start a signaling service. Actual desktop video and encrypted WebRTC data use local peer sockets. Native input injection is mocked to avoid typing into other applications on the user's desktop; real native bindings are loaded and queried separately.

The earlier 60 FPS run covers screen capture, decoding, fullscreen pointer/keyboard delivery, consent, files, clipboard, quality/display changes and teardown. The final 30 FPS run additionally verifies held-key heartbeats and waits for the completed fullscreen transition before injecting input.

Reports are generated under `artifacts/serverless/`, including `smoke-report-30fps.json`, `smoke-report-60fps.json`, and `ui-ready.png`. The displayed frame rate is a capture target, not a guarantee of decoded FPS. RTT is the ICE candidate-pair round trip, not total input-to-screen latency.

## Required target-device checks

- **Direct internet operation between two independent networks has not been verified.** This workspace exposes private IPv4 and link-local IPv6 interfaces. Public addresses and firewall/routing permissions on both peers are still required for a reachable direct internet path.
- Actual physical mouse/keyboard control of a second computer, keyboard layouts/IME, mixed-DPI/rotated displays and switching between distinct physical monitors require device testing.
- Windows loopback audio and secure/UAC desktop behavior are not certified by the local smoke test.
- macOS installer contents and disk-image integrity were tested locally; clean-machine installation, first launch, OS permissions, repair/upgrade, and uninstall remain pending on both macOS architectures.
- Linux installers and permissions remain pending on matching Linux systems.
- Multiple independent app instances, long-duration sessions, real packet loss and address changes need further target-network validation.
- The locally built macOS artifacts are unsigned development artifacts. Protected CI signing/notarization and a production Ed25519 update key/origin remain pending. No unattended remote-access service, remote login/UAC access, multi-viewer room, or remote printing is implemented.

## Phase 6B security and acceptance checks

The release-gating review, findings, exact commands, dependency-audit results, and platform/feature matrix are in [SECURITY_REVIEW_AND_RELEASE_ACCEPTANCE.md](SECURITY_REVIEW_AND_RELEASE_ACCEPTANCE.md). The Phase 6B local test suite passed 41 tests, including response-bound session-verification, parser fuzzing, malformed-response/input floods, update artifact races, and local-agent restart. The available macOS ARM64/x64 outputs were rebuilt and passed exact-artifact/runtime verification and `hdiutil verify`, but remain unsigned development artifacts without clean-machine acceptance. The Electron smoke harness now records an explicit unavailable result on this host (`No displays available`, exit 77) rather than resembling a pass; a display-capable, Screen-Recording-authorized test machine is still required.

## Fixes established by regression testing

The previous code started separate per-device signaling servers, used public STUN while claiming arbitrary internet connectivity, registered sessions before capturing video, ignored errors after host registration, and could retain stale UI/session state. Those paths were replaced with complete direct invitation/response setup and bounded lifecycle cleanup.

Expanded integration tests also exposed two independent usability failures: Windows rejected the reserved Ctrl+Shift+Esc emergency shortcut, preventing remote control, and the Electron permission handler omitted fullscreen. Both are fixed and covered.
