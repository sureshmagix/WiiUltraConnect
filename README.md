# WiiUltraConnect Direct

**Wii Ultra Connect — Direct edition, version 0.2.0-serverless.1.**

This separate edition runs with **zero external services**. It starts no signaling server, configures no STUN or TURN servers, and sends screen video, chat, files and approved remote input directly between the host and viewer. Connection setup uses manually exchanged invitation and response codes.

Development branch: **`codex/serverless-direct`**. The original version remains on **`main`**. This branch has a different application ID, user-data folder and build output folder so both editions can coexist.

## Internet connectivity requirement

Removing every external service does not remove NAT or firewall restrictions. The peers need a reachable direct network path. A public, routable IPv6 address with suitable firewall rules, or a directly assigned public IPv4 address, can provide that path. A private LAN works when peer traffic is allowed.

**This is not guaranteed to connect two arbitrary home, mobile or corporate networks.** With no STUN, the app cannot discover a router's public address/port mapping. With no TURN, it cannot relay around restrictive NAT/CGNAT or blocked peer traffic. It does not configure routers, open firewall rules, establish a VPN, or perform UPnP. Copying codes does not solve an unreachable network path. ICE chooses dynamic ports, so forwarding the old signaling port 8787 is not a solution for this edition.

The app reports a direct-connect failure rather than contacting a fallback service. Internet traversal across two independent networks has **not** been validated locally. See [WebRTC peer connection documentation](https://webrtc.org/getting-started/peer-connections) for the underlying ICE/NAT distinction.

## Run

Requires Node.js 22.14+ and a graphical desktop:

```sh
git switch codex/serverless-direct
npm ci
npm run dev
```

`npm run dev` launches only the desktop app. `npm start` also launches only the app and can open a second instance for a local test. There is no `npm run signal` command in this edition. The previous edition's `WII_SIGNAL_URL`, `WII_ICE_SERVERS` and `WII_RELAY_ONLY` settings are deliberately ignored.

## Connect the host and viewer

1. **Host:** choose a display and 30/60 FPS, then click **Create invitation**. Wait for network address gathering to complete.
2. **Host:** copy the complete `WUC-DIRECT-1.…` code and give it privately to the viewer using a channel you arrange yourself. The app does not send it through any service.
3. **Viewer:** choose **Connect to host**, paste the host code and click **Create response**.
4. **Viewer:** copy the generated response and return it to the host promptly.
5. **Host:** paste the viewer response and click **Connect directly**. The peers connect without further signaling.
6. Chat and files are available after all data channels open. Incoming files require acceptance; **Delivered** means complete reassembly at the receiver, and **Save file** is a separate action.
7. Remote input starts disabled. The host can click **Allow remote control** and approve the native dialog. Click **Stop control**, use **Ctrl/Cmd + Shift + Escape** on the host, or end the session to revoke control.

Codes contain network addresses, ICE credentials and certificate fingerprints. They are encoded, **not encrypted**, and do not prove a person's identity; exchange them privately and authentically with your intended peer. Each response is bound to the exact host invitation using SHA-256. Codes expire after ten minutes, are single-session, and become unusable once their app session closes. Exchange them promptly: WebRTC's own connectivity checks can fail earlier than the code expiry. A new session needs a new invitation and response.

Malformed or unrelated responses can be corrected without replacing the waiting host invitation. Ending a session releases tracks, channels, transfer buffers and granted input. Disconnects require fresh codes; resume and automatic ICE restarts are not implemented.

## What is included

- Electron display capture at selectable 30/60 FPS, with 1080p capture caps and 2/4/8 Mbps sender budgets. Actual delivered resolution/FPS adapt to hardware and network conditions.
- Direct WebRTC video plus separate reliable channels for text chat, files and input.
- 16 KiB file chunks, backpressure, byte-offset validation, cancellation, receiver acknowledgement, and a 128 MiB per-file limit. Recent received Blobs have a combined 256 MiB retention budget.
- Normalized pointer coordinates with letterbox correction, mapped to the captured monitor. Windows includes DIP-to-native-pixel conversion.
- Host approval, emergency revocation, held-key/button cleanup, bounded input queues, and an idle held-input watchdog.
- Separate build output under `release/serverless/`, application ID `com.wiiultraconnect.direct`, and user-data folder `WiiUltraConnect Direct`.

## Native input and supported environments

The adapter tries official `@nut-tree/nut-js` first, then the optional pinned community `@nut-tree-fork/nut-js`. Official prebuilt nut.js packages require registry access; the fork is a separate distribution. Installing software/build dependencies may require package-registry access; **zero external services refers to the running app and its connection flow**, not dependency installation.

| Platform | Capture | Input |
| --- | --- | --- |
| Windows | Electron desktop capture | nut.js; privileged/secure desktops may reject input |
| macOS | Screen Recording permission | Accessibility permission for the running app |
| Linux X11 | Electron desktop capture | nut.js with X11 libraries, including libXtst |
| Linux Wayland | Depends on PipeWire/desktop portals | Disabled in this native adapter |

Missing native bindings leave screen sharing, chat and files available. `npm ci --omit=optional` installs without the community input provider. Display changes revoke input; a captured source without a usable monitor ID remains view-only. Mixed-DPI, rotated and multiple-monitor configurations require target-device testing. Keyboard mapping covers common physical keys but not full IME, layout translation or all OS shortcuts.

The optional input provider retains the existing Jimp/file-type dependency chain with **seven moderate audit entries** arising from a malformed-ASF parser advisory. The app does not pass received files into this parser. A compatible upstream dependency update is still needed; no breaking override has been forced. See [the advisory](https://github.com/advisories/GHSA-5v7r-6r5c-r473) and [nut.js installation](https://nutjs.dev/docs/installation).

## Test and build

```sh
npm run check
npm test
npm run smoke
npm run smoke -- 60
npm run pack
node scripts/verify-package.cjs
```

The smoke test launches hidden Electron windows, uses real display capture and WebRTC, and manually relays the invitation/response through the test runner. It starts **no network listener**. It verifies an empty ICE-server configuration, direct candidates, bidirectional chat/files, invalid-response recovery, disabled input before consent and disconnect cleanup. HTTP/HTTPS/WebSocket service requests are blocked and asserted absent. Native bindings load but no real mouse or keyboard input is injected.

Reports and a UI screenshot are written to `artifacts/serverless/`. The 30/60 FPS values describe capture settings, not a guaranteed decoded frame rate. See [local validation](docs/VALIDATION.md).

`npm run pack` creates an unpacked application in `release/serverless/`. On Windows, run `release/serverless/win-unpacked/WiiUltraConnect Direct.exe`; keep the entire folder together. `npm run dist` provides NSIS, DMG or AppImage targets on their respective build systems. Signing/notarization and target-OS distribution testing are separate release work; no signing credentials or update service are configured here.

## Source map

| File | Responsibility |
| --- | --- |
| `src/direct-signaling.js` | Offline code format, validation, expiry, offer binding and ICE gathering |
| `src/peer.js` | Direct negotiation, video, channels, stats and lifecycle |
| `src/app.js` | Invitation/response UI and session controls |
| `electron/main.cjs` | Capture, isolated app identity and native consent |
| `electron/input-controller.cjs` | Native input validation, ordering and cleanup |
| `src/file-transfer.js` | Chunking, backpressure, acceptance and reassembly |
| `src/viewer-input.js` | Viewer pointer and keyboard capture |

Read the [architecture](docs/ARCHITECTURE.md) for the direct connection sequence. The server-based architecture and its deployment instructions remain in the Git history of `main`.

## License

No project license has been selected. Third-party dependencies retain their own licenses. Choose an appropriate project license before distributing this code publicly.
