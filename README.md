# WiiUltraConnect

**Wii Ultra Connect** is an Electron desktop application for one host and one viewer to share a screen, exchange messages and files, and optionally control the host mouse and keyboard.

Built with Electron, WebRTC, a Node.js WebSocket signaling server, and an optional nut.js native input provider. The signaling server coordinates connections; screen video, chat, files, and input travel over the WebRTC peer connection, directly or through a configured TURN relay.

## Features

- **Screen sharing:** select a display, target 30 or 60 FPS at up to 1080p, and choose a 2/4/8 Mbps video budget.
- **Private invitations:** each session admits one viewer and ends when either peer leaves.
- **Session chat:** exchange messages over a WebRTC data channel without persistent chat storage.
- **File transfer:** send files in either direction, with explicit acceptance, progress, cancellation, and a separate save action. Maximum size: 128 MiB per file.
- **Optional remote control:** the host explicitly approves mouse and keyboard access in a native dialog and can revoke it with **Ctrl/Cmd + Shift + Escape**.
- **Desktop packaging:** Electron Builder targets Windows NSIS, macOS DMG, and Linux AppImage. Platform permissions and testing limitations are described below.

Version **0.1.0** is an early implementation. See [current scope and limits](#current-scope-and-limits) before deploying it beyond local testing.

## Contents

- [Run locally](#run-locally)
- [Connect two computers](#connect-two-computers)
- [Configuration](#configuration)
- [Native input and platform setup](#native-input-and-platform-setup)
- [Validation and packaging](#validation-and-packaging)
- [Current scope and limits](#current-scope-and-limits)
- [Troubleshooting](#troubleshooting)
- [Project map](#project-map)
- [Contributing](#contributing)
- [License](#license)

## Run locally

Requires **Node.js 22.14 or later**, npm, Git, and a graphical desktop. Install the project on both computers for a two-device session.

```sh
git clone https://github.com/sureshmagix/WiiUltraConnect.git
cd WiiUltraConnect
npm ci
npm run dev
```

`npm ci` installs the versions recorded in `package-lock.json`, including Electron's platform binary. `dev` starts the local WebSocket signaling server on `127.0.0.1:8787` and opens WiiUltraConnect. Keep that process running during the session.

To try both roles on one computer, open another terminal in the project directory and run:

```sh
npm start
```

`npm start` opens only the desktop app; it expects an already running signaling server. If a launcher sets `ELECTRON_RUN_AS_NODE`, clear it before using `npm start` so Electron starts as a desktop app.

### Start a session

1. In the host app, select a display, choose 30 or 60 FPS, and click **Start sharing**.
2. Copy the private invitation. In the other app, select **Connect to host**, paste it, and connect.
3. Use **Conversation** for chat and **Files** to send a file. The receiver must accept before bytes are sent, then click **Save file** after receipt.
4. On the host, click **Allow remote control** and confirm the native dialog. The viewer clicks the shared video to focus keyboard input.
5. Click **Stop control**, press **Ctrl/Cmd + Shift + Escape** on the host, or end the session to revoke input.

An invitation admits one viewer. Ending the session or losing a signaling connection invalidates the invitation; start a new session to reconnect. Messages are in-memory, and received files are retained only until dismissed, evicted from recent history, or the app exits. File transfer does not execute or automatically open received content.

## Connect two computers

Run the signaling server on a machine both devices can reach. For a trusted LAN, in PowerShell:

```powershell
$env:HOST = '0.0.0.0'
npm run signal
```

On both devices, expand **Connection settings** and set the server to `ws://SERVER_LAN_IP:8787/signal`, then run `npm start`. Allow the signaling port through the server's firewall. `127.0.0.1` points to the current computer, so it cannot connect two separate machines.

For internet use, terminate TLS at a reverse proxy and expose **WSS**, including WebSocket upgrade forwarding to `/signal`. Keep invitations private: they are bearer credentials. The signaling service is trusted with room secrets and SDP fingerprints; this version has no independent peer identity verification. WSS protects signaling in transit. WebRTC encrypts media and data on the peer transport, including when relayed through TURN.

STUN alone cannot connect every NAT/firewall combination. Configure an operator-controlled TURN server on both peers:

```powershell
$env:WII_SIGNAL_URL = 'wss://connect.example.com/signal'
$env:WII_ICE_SERVERS = '[{"urls":"stun:stun.example.com:3478"},{"urls":["turn:turn.example.com:3478?transport=udp","turns:turn.example.com:5349?transport=tcp"],"username":"SHORT_LIVED_USERNAME","credential":"SHORT_LIVED_PASSWORD"}]'
npm start
```

Use short-lived TURN credentials issued by your infrastructure. Do not commit credentials. Shell environment examples are configuration placeholders; no hosted signaling or TURN service is provisioned by this project.

## Configuration

Set environment variables in the terminal that launches the relevant process. The app does not automatically load `.env` files. `HOST`, `PORT`, and `ALLOWED_ORIGINS` configure `npm run signal`; `npm run dev` uses its built-in local server defaults. The `WII_*` settings configure the desktop app, and **Connection settings** can override its signaling URL for a session.

| Setting | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Signaling bind address |
| `PORT` | `8787` | Signaling port |
| `ALLOWED_ORIGINS` | `null,file://` | Comma-separated allowed browser origins; Electron file origins are supported |
| `WII_SIGNAL_URL` | `ws://127.0.0.1:8787/signal` | Desktop's initial signaling address |
| `WII_ICE_SERVERS` | `[{"urls":"stun:stun.l.google.com:19302"}]` | JSON array of WebRTC ICE servers |
| `WII_RELAY_ONLY` | unset | Set to `1` to require TURN relay |

`GET /health` returns a small health response. The server keeps room state in memory, supports up to 1,000 rooms / 2,000 sockets, limits individual signaling payloads, checks roles, limits per-socket traffic, and expires rooms after eight hours. For an exposed service, add authentication, per-IP connection/admission limits, observability, and TLS at the gateway. Multi-instance signaling needs shared room ownership or sticky routing; it is not implemented here.

## Native input and platform setup

The input adapter first tries official `@nut-tree/nut-js`, then the pinned optional community package `@nut-tree-fork/nut-js`. The community fork is included because the official prebuilt package requires access to the nut.js registry. These are separate distributions; the fork is not represented as an official release. You can install an official package using your nut.js registry access, or supply your own build. See [official installation](https://nutjs.dev/docs/installation) and [source build instructions](https://github.com/nut-tree/nut.js#installation).

If the optional native dependency fails to install or load, screen sharing, chat and file transfer still work. Attempting to grant control explains the missing provider. To install without the community input provider:

```sh
npm ci --omit=optional
```

The Electron smoke test currently requires the community input provider because it verifies that provider's native binding.

| Platform | Screen sharing | Remote input |
| --- | --- | --- |
| Windows | Electron desktop capture | nut.js; elevated/system secure desktops may reject input |
| macOS | Grant Screen Recording permission; restarting the app may be necessary | Grant Accessibility permission to the running app; packaged builds need their own grant |
| Linux X11 | Electron desktop capture | nut.js with required X11 libraries, including libXtst |
| Linux Wayland | Capture depends on the PipeWire/desktop portal setup | Disabled in this adapter; use an X11 session |

On Debian/Ubuntu X11, install required system libraries as appropriate for your distribution, including `libxtst6`. Source builds may additionally need development headers and a compiler toolchain. A portal-selected source without a usable display ID remains view-only because its absolute coordinates cannot be mapped safely.

Normalized viewer coordinates are mapped to the **selected display**, including a negative monitor origin. Windows converts Electron DIP coordinates to native screen pixels. macOS/Linux use desktop coordinates exposed by Electron and the provider. Mixed DPI, rotation and multi-monitor alignment need validation on each target system. Window-only capture is deliberately not offered because this implementation maps input to full displays.

## Validation and packaging

### Development commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local signaling server and one desktop app |
| `npm start` | Open a desktop app using an existing signaling server |
| `npm run signal` | Start the standalone signaling server |
| `npm run check` | Check JavaScript syntax |
| `npm test` | Run the automated protocol, signaling, and input tests |
| `npm run smoke` | Run the Electron integration smoke test at 30 FPS |
| `npm run smoke -- 60` | Run the same smoke test with a 60 FPS target |
| `npm run pack` | Build an unpacked desktop app |
| `npm run dist` | Build an installer for the current platform |

Run the automated checks before submitting changes:

```sh
npm run check
npm test
```

For desktop integration checks and packaging:

```sh
npm run smoke
npm run smoke -- 60
npm run pack
node scripts/verify-package.cjs
npm run dist
```

- `check`: syntax checks app, server, scripts and tests.
- `test`: signaling integration, file protocol and backpressure, pointer mapping, consent gate and queued input revocation tests with fake native input.
- `smoke`: opens hidden Electron test windows; captures the real host display, connects a real WebRTC viewer, verifies chat and bidirectional files, compares file bytes with SHA-256, checks native binding loading without injecting inputs, and checks teardown. Requires a graphical desktop and screen-capture permission. Writes `artifacts/ui-ready.png` and `artifacts/smoke-report.json`.
- `pack`: creates an unpacked app under `release/` for the current OS. `verify-package.cjs` compares the Windows packaged app with current source; pass an alternate `app.asar` path for other platforms.
- `dist`: creates an installer: Windows NSIS, macOS DMG, Linux AppImage. Build on each target OS/architecture and configure your signing/notarization credentials before distributing signed releases. No signing credentials or update service are included.

Packaged apps contain the desktop client. Run the signaling server separately from the source checkout or your own server deployment, and configure both clients to use it. Generated installers, unpacked apps, smoke-test artifacts, local environment files, and `node_modules/` are excluded from Git.

The Windows smoke run is recorded in `artifacts/smoke-report.json` when it passes. macOS/Linux, internet TURN traversal, real remote pointer/keyboard injection, mixed-DPI desktops and signed installers require additional target-device testing; local protocol tests do not establish those outcomes.

## Current scope and limits

- One host, one viewer, screen video only. No microphone/system audio, unattended access, reconnect/resume, clipboard sync or account directory.
- Targets 30 or 60 FPS at up to 1080p and a selectable 2/4/8 Mbps video budget. Actual FPS and latency depend on hardware/network conditions. File traffic still shares the transport with video; separate channels do not reserve bandwidth.
- Files are accepted explicitly, limited to 128 MiB each, sent in 16 KiB chunks, and reassembled into a bounded in-memory Blob. One outgoing and one incoming transfer can run at once. Recent received Blobs have a combined 256 MiB retention budget, after which the oldest save links are removed; progress redraws are throttled to reduce contention with video. Use a streaming-to-disk receiver for larger files.
- File `Delivered` means the receiver acknowledged complete reassembly; it does not mean the file has been saved to disk. Partial transfers are discarded on cancellation or disconnect.
- Keyboard events use a fixed mapping of browser `code` values to nut.js keys, with separate press/release. Alphabetic keys, digits, navigation, modifiers, punctuation and F1–F12 are covered. IME/text composition, numpad keys, media keys and full layout translation are not implemented. OS-reserved shortcuts may be intercepted locally. Repeated browser keydown events are ignored; held native keys rely on the host OS's repeat behavior.
- Native input can affect the full desktop, even though pointer coordinates target the selected display. Host consent, a persistent control indicator, queue invalidation, held-key/button cleanup and an emergency shortcut are implemented. An idle held input is released after roughly 2.5–3.5 seconds as a fallback if release messages are lost.
- The optional community nut.js dependency currently pulls in Jimp/file-type with a moderate malformed-ASF parser advisory (`npm audit`). The app does not use that image/file parser for received data. A compatible upstream dependency fix is still needed; avoid silently forcing a breaking major override. See [GHSA-5v7r-6r5c-r473](https://github.com/advisories/GHSA-5v7r-6r5c-r473). Omitting the optional provider avoids that dependency chain and disables native input unless an alternative provider is installed.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| `npm run dev` cannot bind port 8787 | If the local signaling server is already running, use `npm start`. Otherwise stop the process using that port, or launch `npm run signal` with a different `PORT` and configure the desktop app's URL. |
| Two computers cannot connect | Both clients must use the same reachable signaling URL. Use the server's LAN address instead of `127.0.0.1`, and check firewall rules and WebSocket proxy forwarding. |
| An invitation no longer works | End the old session and start sharing again. Invitations expire on disconnect or room expiry, and each room admits only one viewer. |
| Internet signaling works but video never connects | Configure reachable TURN servers and valid credentials on both peers; STUN alone cannot traverse every network. |
| No display or screen-capture permission | Check OS screen-recording permissions and restart the app after granting them. On Wayland, check the PipeWire/desktop portal setup. |
| Remote control is unavailable | Check that the native input provider loads, that the selected display can be mapped, and that required OS permissions are granted. Linux remote input requires X11. |
| A received file says `Delivered` but is not on disk | The receiver still needs to click **Save file**. Delivery confirms in-memory reassembly. |

## Project map

```text
electron/main.cjs              Privileged capture, permissions and input consent
electron/preload.cjs           Narrow, context-isolated IPC bridge
electron/input-controller.cjs  Validated, serialized native input and release cleanup
server/index.mjs               Standalone signaling server entry point
server/signaling.mjs           Room discovery, authenticated join, SDP/ICE forwarding
src/peer.js                    RTCPeerConnection lifecycle, video tuning, chat and channels
src/file-transfer.js           Accepted chunked transfer, backpressure and reassembly
src/viewer-input.js            Viewer pointer/keyboard capture with letterbox correction
src/protocol.js                Shared validation and binary framing
src/app.js                     User interface and session lifecycle
src/index.html                Desktop interface markup
src/styles.css, src/compact.css  Desktop interface styling
scripts/                      Development, validation, smoke testing and package checks
tests/                        Automated signaling, protocol, file and input tests
docs/ARCHITECTURE.md           Architecture, protocols, media pipeline and consent model
```

Read the [architecture guide](docs/ARCHITECTURE.md) for signaling and data-channel flows, capture behavior, file framing, and remote-input validation.

## Contributing

Use [GitHub Issues](https://github.com/sureshmagix/WiiUltraConnect/issues) for reproducible bug reports and feature proposals. Include the operating system, Node.js version, steps to reproduce, and relevant logs with invitations and credentials removed.

For code changes, create a branch, keep `package-lock.json` in sync when dependencies change, and run `npm run check` and `npm test`. Run the desktop smoke test when changing capture, peer connections, chat, files, or Electron integration. Describe the platforms tested and any remaining limitations in the pull request.

## License

No license file is included yet. Contact the [repository owner](https://github.com/sureshmagix) about licensing and reuse.
