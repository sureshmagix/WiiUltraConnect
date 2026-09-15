# WiiUltraConnect 0.4.0

A Windows-focused remote-support app for screen sharing, remote control, chat, files and clipboard text. Its main screen is deliberately simple: enter a remote **username** and **password** to connect, or set your own username/password once for unattended access. Direct mode works without services; Internet mode uses your self-hosted signaling service and TURN relay for NAT/firewall fallback.

## Connect over the internet

The 0.3.0 build deliberately disabled STUN/TURN and could not connect across many home, mobile and CGNAT networks. Changing codes or allowing the app through Windows Firewall does not remove a router's NAT restrictions.

1. Use this updated app on **both computers** and choose **Internet · STUN / TURN** under **Connection network**. Open **Internet server settings**. Allow the app through the Windows Firewall prompt for the network you are using; a new installation or extracted folder can require its own app rule.
2. Keep the prefilled Google STUN URL or enter your provider's STUN URL. STUN alone can help establish direct paths but does not guarantee connectivity.
3. For restrictive networks, enter your TURN provider's URL(s), username and password on each computer. Multiple URLs can be separated by spaces, commas or newlines. For example, `turn:relay.example.com:3478?transport=udp` and `turns:relay.example.com:5349?transport=tcp` show the format; **replace these with a real service**. Only use ports and transports supported by that service. TURN over TCP/TLS can help when client UDP access is blocked.
4. Leave **Use relay only** unchecked for direct-first connectivity with relay fallback. Check it to verify that your TURN service works independently of a direct path.
5. Create and exchange fresh invitation/response codes using the steps below. The connection check should report **TURN relay address obtained** if relay allocation succeeds. The active route shows **TURN Relay** when relaying.

The app does not use a third-party hosted relay. The included `server/` deployment runs your own signaling service and coturn relay. A valid reachable relay and its credentials are required where direct paths fail. TURN credentials stay out of generated codes. Signaling relays setup messages only; WebRTC encrypts video, audio and data between the endpoints, including relayed traffic. Internet codes start with `WUC-INTERNET-2.` and require the updated app on both ends. Direct codes remain `WUC-DIRECT-1.`.

## Unattended access

On the computer you want to control, open **Advanced** once, enter the signaling server and TURN settings, then choose a server-unique username and an access password of at least 12 characters under **This computer**. The app stores its private device key, password verifier and TURN credentials with the operating system's encrypted desktop storage. It can start at Windows sign-in when enabled.

The operator enters the remote username and password under **Control a computer**, then chooses **Connect**. The server rate-limits requests and forwards a derived password verifier to the registered computer. The password itself is never stored or sent to the signaling server. A successful verification starts capture and control automatically; the controlled computer can always stop access with **Ctrl/Cmd + Alt + Shift + F12**, Stop control or End session.

Unattended access is intentionally limited to a logged-in desktop session where WiiUltraConnect is running. It does not bypass the operating-system login screen, UAC/secure desktop, screen-recording/accessibility permissions, or endpoint protection policies.

## Direct mode network requirement

**Server-free does not mean it can connect through every internet network.** Both computers need a reachable direct network path. A shared LAN can work. Public, routable IPv6 at both ends, or directly assigned public IPv4 with suitable routing and firewall permissions, can also work. Private addresses behind NAT, mobile CGNAT, guest-network isolation, and corporate firewalls can prevent it.

The app checks local interfaces and gathered ICE candidates and reports when no public address is visible. A public address is a possibility, not a reachability certificate. It does not automatically change firewall rules or router settings. WebRTC selects dynamic peer ports; forwarding the old port 8787 does not solve this.

Direct mode preserves the **no intermediary server** constraint. Internet mode explicitly permits STUN/TURN; [WebRTC explains the role of TURN](https://webrtc.org/getting-started/turn-server). **Internet operation between two independent networks has not been verified in this workspace.** The machine used here has private IPv4 and link-local IPv6 addresses.

## Connect two computers

1. Open the app on both computers and choose the same Connection network mode. For Internet mode, configure STUN/TURN as described above.
2. On the host, choose **Share this computer**, select a display, then **Create invitation**. Windows can optionally share system audio.
3. Copy the complete invitation and send it privately to your intended partner through a channel you arrange.
4. The viewer chooses **Control a partner**, pastes the invitation, and clicks **Create response**.
5. The viewer returns the complete response to the host. The host pastes it and clicks **Connect**.
6. Once connected, the viewer clicks **Request control**, or the host clicks **Allow control**. The host approves the native permission dialog.
7. The viewer clicks the remote desktop to focus input. **Fullscreen** or **F11** fills the display while keeping the session toolbar available.

Invitations expire after ten minutes; exchange them promptly, because connectivity checks can fail sooner. They contain network addresses, ICE credentials and certificate fingerprints. They are encoded, not encrypted, and must be exchanged privately and authentically. Each response is bound to the exact invitation. A short session label is shown for reference; it is not a remotely searchable computer ID or password.

## Remote workspace

| Feature | Behavior |
| --- | --- |
| Fullscreen | Persistent toolbar with End session, Exit fullscreen, quality, display and shortcut controls; chat/files can open inside fullscreen |
| View size | Fit with correct letterbox input mapping, or native video size with scrolling |
| Remote input | Pointer movement, drag, left/middle/right click, wheel, common physical keys and modifier combinations |
| Emergency stop | **Ctrl/Cmd + Alt + Shift + F12 on the host**, Stop control, viewer Release control, or End session |
| Local input release | Click outside the video, change focus, or Ctrl/Cmd + Shift + Escape on the viewer |
| Remote shortcuts | Explicit Win+D, Alt+Tab, Win+E and Escape buttons; host OS determines their behavior |
| Display switching | Host selects another display live. An approved controller can request a display; the host approves it locally. Switching revokes control. |
| Quality | Economy 2 Mbps/15 FPS, Balanced 4 Mbps/30 FPS, Smooth 8 Mbps/60 FPS; host can start with separate FPS/budget settings |
| Resolution | Capture capped at 3840×2160; actual resolution/FPS depend on screen, hardware, bandwidth and encoder |
| Chat | Bidirectional text, rendered without HTML interpretation; up to 4,000 characters per message |
| Files | Bidirectional, recipient acceptance, progress, cancellation, receipt acknowledgement, and explicit Save file; 128 MiB per file |
| Clipboard | Send up to 16,000 text characters; recipient previews and explicitly accepts; no background clipboard synchronization |
| Audio | Optional Windows system audio; viewer explicitly unmutes playback |
| Screenshot | Save the currently decoded video frame as a PNG |
| Diagnostics | Local address assessment, selected route, resolution, FPS, ICE round-trip time and video Mbps |
| Interrupted connection | Revoke input immediately, allow 15 seconds for the existing path to recover; fresh codes after terminal failure |

Only one host/viewer pair exists per app instance. Additional instances can establish separate pairs; this is not a multi-viewer room or centralized computer directory. One emergency-stop shortcut must be available for each actively controlled host desktop. There is no access to login/UAC secure desktops, remote reboot/reconnect, remote printing, full IME/layout translation, automatic updates, or claim of complete UltraViewer feature parity. [UltraViewer's own feature overview](https://www.ultraviewer.net/en/) includes multi-computer support that differs from this one-to-one design.

## Deploy your Utho server

See the separate [server deployment guide](server/README.md). In the app use `wss://your-domain/ws` for Server URL and `turn:your-domain:3478?transport=udp` with the same TURN username/password on both computers. Start with **Always use relay** enabled to verify that the deployed relay is usable, then disable it for direct-first operation.

The server persists a unique username and a hash of each device key. It neither stores access passwords nor desktop/video/input/file content. Back up the Docker volume named `signal-data`; losing it only requires re-saving unattended access on each controlled computer.

## Run and build

Requires Node.js 22.14+ and a graphical desktop:

```sh
npm ci
npm run dev
```

`npm start` also launches the app. Old `WII_SIGNAL_URL`, `WII_ICE_SERVERS` and relay environment settings are ignored; use the Internet and unattended settings in the app. The self-hosted signaling service is deployed from `server/`.

```sh
npm run check
npm test
npm run smoke
npm run smoke -- 60
npm run pack
node scripts/verify-package.cjs
npm run dist:win
```

An additional integration test runs a temporary, authenticated UDP relay on one local IPv4 interface and forces both peers through it. Its fixture is isolated from app dependencies and is never packaged:

```sh
npm install --prefix artifacts/turn-test --ignore-scripts node-turn@0.0.6
node scripts/smoke-turn.mjs
```

The Windows unpacked app is `release/win-unpacked/WiiUltraConnect.exe`. Keep the entire folder together. Distribution builds produce an NSIS installer and ZIP. Builds are unsigned; no signing credentials or update service are configured. Other OS targets require their respective build/test environments.

## Permissions and validation

Windows uses Electron capture and nut.js native input. macOS needs Screen Recording and Accessibility permission. Linux capture depends on the desktop environment; native input requires X11 and is disabled on Wayland. Elevated/secure OS surfaces can reject input.

The native input provider is an optional dependency. Without it, viewing/chat/files still work and control reports a clear error. The pinned provider retains seven moderate audit entries through its Jimp/file-type parser dependency. Incoming files are not passed to this image parser; a compatible upstream fix is still required.

See [validation results](docs/VALIDATION.md) for exactly what has been exercised, including the limits of local testing, and [architecture](docs/ARCHITECTURE.md) for the connection and permission boundaries. Test screenshots/reports are generated under `artifacts/serverless/`. App data uses the `WiiUltraConnect` user-data directory; messages and transfer state are kept in memory.

No project license has been selected. Third-party dependencies retain their own licenses.
