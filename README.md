# WiiUltraConnect 0.3.0

A direct, one-to-one desktop support app for screen sharing, fullscreen mouse/keyboard control, chat, files and clipboard text. No signaling, STUN, TURN, public-IP lookup, account, or relay service is started or contacted by the app. Connection setup uses a host invitation and a viewer response exchanged by the users.

## Internet access: the unavoidable network requirement

**Server-free does not mean it can connect through every internet network.** Both computers need a reachable direct network path. A shared LAN can work. Public, routable IPv6 at both ends, or directly assigned public IPv4 with suitable routing and firewall permissions, can also work. Private addresses behind NAT, mobile CGNAT, guest-network isolation, and corporate firewalls can prevent it.

The app checks local interfaces and gathered ICE candidates and reports when no public address is visible. A public address is a possibility, not a reachability certificate. It does not automatically change firewall rules or router settings. WebRTC selects dynamic peer ports; forwarding the old port 8787 does not solve this.

This follows the requested **no intermediary server** constraint. General connectivity between arbitrary networks would require relaxing that constraint; [WebRTC explains the role of TURN](https://webrtc.org/getting-started/turn-server). **Internet operation between two independent networks has not been verified in this workspace.** The machine used here has private IPv4 and link-local IPv6 addresses.

## Connect two computers

1. Open the app on both computers.
2. On the host, choose **Share this computer**, select a display, then **Create invitation**. Windows can optionally share system audio.
3. Copy the complete invitation and send it privately to your intended partner through a channel you arrange.
4. The viewer chooses **Control a partner**, pastes the invitation, and clicks **Create response**.
5. The viewer reads the response-bound verification code to the host through a separate trusted channel (for example, a known phone number). The host pastes the response, clicks **Verify response and show code**, compares the matching code, confirms the comparison, then clicks **Connect directly**.
6. Once connected, the viewer clicks **Request control**, or the host clicks **Allow control**. The host approves the native permission dialog.
7. The viewer clicks the remote desktop to focus input. **Fullscreen** or **F11** fills the display while keeping the session toolbar available.

Invitations expire after ten minutes; exchange them promptly, because connectivity checks can fail sooner. They contain network addresses, ICE credentials and certificate fingerprints. They are encoded, not encrypted, and must be exchanged privately and authentically. The displayed verification code is a short rendering of the invitation and validated response binding: it helps detect a substituted response only when people compare it over an independent trusted channel. It is not a saved device identity, password, or a substitute for authenticated device pairing.

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

Only one host/viewer pair exists per app instance. Additional instances can establish separate pairs; this is not a multi-viewer room or centralized computer directory. One emergency-stop shortcut must be available for each actively controlled host desktop. There is no unattended remote-access service, access to login/UAC secure desktops, remote reboot/reconnect, remote printing, full IME/layout translation, unattended update installation, or claim of complete UltraViewer feature parity. Signed updates, when a production channel is configured, are checked only when the user chooses the in-app action and still require them to run the verified installer. [UltraViewer's own feature overview](https://www.ultraviewer.net/en/) includes multi-computer support that differs from this one-to-one design.

## Run and build

Requires Node.js 22.14+ and a graphical desktop:

```sh
npm ci
npm run dev
```

`npm start` also launches the app. Old `WII_SIGNAL_URL`, `WII_ICE_SERVERS` and relay environment settings are ignored. There is no signaling-server command.

```sh
npm run check
npm test
npm run smoke
npm run smoke -- 60
npm run dist:mac:silicon       # on macOS
npm run verify:release
```

See [Build and release](docs/BUILD_AND_RELEASE.md) for the target matrix, exact artifact locations, native-runtime checks, checksums/SBOM, signing, and authenticated-update process. See [Installation](docs/INSTALLATION.md) for repair, upgrade, service consent, and data-removal choices. Builds without protected signing credentials are explicitly labeled unsigned development artifacts.

## Permissions and validation

Windows uses Electron capture and nut.js native input. macOS needs Screen Recording and Accessibility permission. Linux capture depends on the desktop environment; native input requires X11 and is disabled on Wayland. Elevated/secure OS surfaces can reject input.

The native input provider is bundled with each target and pruning/verification prevents foreign-platform modules from shipping. The pinned provider retains seven moderate audit entries through its Jimp/file-type parser dependency. Incoming files are not passed to this image parser; a compatible upstream fix is still required.

See [validation results](docs/VALIDATION.md) for exactly what has been exercised, including the limits of local testing, and [architecture](docs/ARCHITECTURE.md) for the connection and permission boundaries. Test screenshots/reports are generated under `artifacts/serverless/`. App data uses the `WiiUltraConnect` user-data directory; messages and transfer state are kept in memory.

No project license has been selected. Third-party dependencies retain their own licenses.
