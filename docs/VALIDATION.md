# Validation — 0.3.1

Validated locally on Windows, Node.js 22.14.0 and Electron 44.2.0 on 10–11 September 2026, with the Internet-mode update checked on 11 September. These are local implementation checks, not an internet or cross-platform certification.

| Check | Result |
| --- | --- |
| JavaScript syntax | Passed, 24 files |
| Automated unit/regression tests | 33 passed |
| Internet configuration and codes | Opt-in STUN/TURN, URL/credential validation, relay policy, v2 code round-trip, mode mismatch rejection, invitation binding and exclusion of TURN credentials passed |
| Internet candidate gathering | Usable candidate snapshot exports before stalled interfaces finish; cancellation during snapshot collection passed |
| Authenticated UDP TURN integration | Passed using the actual host/viewer UIs with relay-only policy, relay candidates at both ends, decoded 1920×1080 video, all four data channels, chat/files/clipboard and control-permission checks |
| Capture before invitation; invalid/expired/mismatched codes; concurrent/repeated response guards | Passed |
| Real host and viewer app UI, isolated bridges | Passed (viewer uses a test-only bridge) |
| Real desktop capture and decoded WebRTC video | 1920×1080 at 30 FPS and 60 FPS capture targets passed |
| Four data channels; readiness gating and teardown | Passed |
| Direct-mode ICE configuration | Empty ICE-server list; direct host candidates; no relay or server-reflexive candidates |
| Direct-mode service requests | No HTTP/HTTPS/WebSocket requests observed; requests blocked and WebSocket constructors replaced with throwing stubs during direct integration testing |
| Unattended broker | Local WebSocket server registers device keys by hash, rate-limits access requests, requires host approval and relays only the approved offer/answer exchange |
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
| Dependency audit | Seven moderate entries through the optional nut.js → Jimp → file-type dependency chain; no compatible automatic fix |

The default smoke runner launches two Electron windows and exchanges codes directly through its test runner. It does not start a signaling service. Actual desktop video and encrypted WebRTC data use local peer sockets. Native input injection is mocked to avoid typing into other applications on the user's desktop; real native bindings are loaded and queried separately.

`scripts/smoke-turn.mjs` adds a test-only, authenticated UDP TURN fixture bound to one local IPv4 interface, installed separately under `artifacts/turn-test`. The fixture is never shipped in the app. The test selects Internet and relay-only on both actual app UIs and exercises the same collaboration checks. This is not a public TURN deployment or an independent-network test.

Local network inspection for this report found private Ethernet IPv4 `10.0.0.158`, no routable IPv6, and existing TCP/UDP inbound Allow rules for this project's Electron executable and the previous packaged app on Private/Public profiles. No firewall or router settings were changed. This does not certify the partner's firewall, the router, or the path between them.

The earlier 60 FPS run covers screen capture, decoding, fullscreen pointer/keyboard delivery, consent, files, clipboard, quality/display changes and teardown. The final 30 FPS run additionally verifies held-key heartbeats and waits for the completed fullscreen transition before injecting input.

Reports are generated under `artifacts/serverless/`, including `smoke-report-30fps.json`, `smoke-report-60fps.json`, and `ui-ready.png`. The displayed frame rate is a capture target, not a guarantee of decoded FPS. RTT is the ICE candidate-pair round trip, not total input-to-screen latency.

The current 0.3.1 Direct and TURN integration runs use a 30 FPS capture target. TURN results and the Internet UI screenshot are under `artifacts/internet/`. Before intentional teardown, no session errors are allowed. After End session, a single data-channel shutdown error is accepted because abrupt remote DTLS/SCTP closure can arrive before the channel-close event through the relay.

## Required target-device checks

- **Internet operation between two independent networks has not been verified.** Direct mode still needs a reachable direct path. Internet mode needs real, reachable STUN/TURN services; no public TURN credentials were provided. TCP/TLS TURN and provider expiry/quota/firewall behavior need testing with the chosen service.
- Actual physical mouse/keyboard control of a second computer, keyboard layouts/IME, mixed-DPI/rotated displays and switching between distinct physical monitors require device testing.
- Windows loopback audio and secure/UAC desktop behavior are not certified by the local smoke test.
- macOS/Linux permissions and installers were not tested on those operating systems.
- Multiple independent app instances, long-duration sessions, real packet loss and address changes need further target-network validation.
- The build is unsigned. Unattended access requires a logged-in desktop session with the app running; remote login/UAC access, multi-viewer rooms, remote printing and automatic updates are not implemented.

## Fixes established by regression testing

The previous code started separate per-device signaling servers, used public STUN while claiming arbitrary internet connectivity, registered sessions before capturing video, ignored errors after host registration, and could retain stale UI/session state. Those paths were replaced with complete direct invitation/response setup and bounded lifecycle cleanup.

Expanded integration tests also exposed two independent usability failures: Windows rejected the reserved Ctrl+Shift+Esc emergency shortcut, preventing remote control, and the Electron permission handler omitted fullscreen. Both are fixed and covered.

Internet-mode integration exposed another timing issue: waiting for every interface to finish gathering could exhaust viewer ICE checks before the response was exported. Internet mode now exports once a usable relay/mapped candidate has been collected, with a short window for additional candidates. Direct mode retains full gathering. A late playback rejection also no longer replaces a terminal connection error after the stream has been cleared.
