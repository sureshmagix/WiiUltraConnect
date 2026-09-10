# Direct architecture — 0.3.0

The app establishes one host/viewer WebRTC connection. The host captures a selected display before creating an SDP offer. ICE gathering completes with the fixed configuration `iceServers: []`; users exchange the complete invitation and answer themselves. No WebSocket, HTTP signaling server, STUN, TURN or public-IP discovery endpoint exists in the runtime code. The renderer CSP prohibits HTTP/HTTPS/WebSocket fetches; Blob access remains available for file downloads.

Manual signaling transports SDP containing DTLS certificate fingerprints and ICE credentials. The response includes a SHA-256 binding to the original offer, session UUID and lifetime. Validation bounds code/SDP sizes, requires complete ICE/fingerprint fields and candidates, checks expiry/role, and rejects relay candidates. Codes are not authenticated identities; their external exchange must be trusted. WebRTC encrypts video/audio and data between the two endpoints.

## Lifecycle

Host: `new → gathering → awaiting-answer → connecting → connected`.

Viewer: `new → gathering → awaiting-host → connected`.

A connection event that occurs while gathering must not be overwritten by a waiting state. The host accepts one matching answer; malformed answers leave the invitation available for retry. An established session does not expire with the invitation. All four channels and the peer connection must be ready before collaboration/input controls become available.

On a transient disconnect, input is revoked and the existing connection gets 15 seconds to recover. Recovered connections require new host control consent. There is no automatic ICE restart or resumption across fresh addresses; terminal failures require new codes. End session aborts gathering, timers, transfers, tracks, channels and held input. Generation checks prevent late capture or consent completions from reviving an ended session.

## Peer channels and media

| Channel | Responsibility |
| --- | --- |
| `chat` | Bounded, text-only messages |
| `files` | Explicit offer/accept, 16 KiB binary chunks, offsets, drain backpressure, timeout/cancel and receipt acknowledgement |
| `input` | Host control state and viewer pointer/key/wheel/release/held-input heartbeat |
| `session` | Control request/release, validated display metadata/requests, quality requests and explicit clipboard offers |

All channels use reliable, ordered delivery. Input queues are bounded; congested pointer moves are discarded, while a stalled key/button path ends the session to release input. Native operations are serialized and invalidated by a consent epoch. Heartbeats preserve deliberate long holds while a separate watchdog releases inputs after inactivity.

Host video uses `replaceTrack` for live monitor changes. The replacement completes before the old video track stops, and the negotiated audio track is preserved. Capture selection and display changes revoke input before changing coordinate mapping. Quality requests adjust both capture constraints and sender bitrate/frame-rate limits.

Files are limited to 128 MiB each. Each direction permits one in-flight transfer. The UI retains at most 256 MiB of received file Blobs and prunes old finished rows. Saving is separate from receipt; no received file is executed or opened automatically. Clipboard transfer is text-only and never replaces the recipient clipboard without a local click.

## Native boundaries

The renderer is sandboxed, context-isolated and has no Node integration. Navigation/new windows are blocked. Main validates IPC sender, main frame and exact local page URL. Capture requests must originate from that frame and match a selected, not-yet-granted screen. There is no fallback to an unselected display.

Remote input requires active capture, a connected app session, a native host consent dialog, valid display coordinates and successful registration of **Ctrl/Cmd + Alt + Shift + F12**. The previous Ctrl+Shift+Esc shortcut is reserved by Windows and blocked remote-control enablement. Revocation invalidates queued work before awaiting native release. Lost displays, crashed renderers and app shutdown revoke permissions. Display scale coordinates convert from Electron DIP to native Windows pixels.

Fullscreen uses the entire session panel so End session, control permission, quality, scaling and chat remain reachable. Pointer coordinates refer to the displayed video image, including letterboxing and scrolled actual-size views. Focus loss, pointer cancellation, window blur and visibility changes release held inputs. OS-reserved shortcuts and secure desktops remain outside the ordinary capture/input boundary.

## Connectivity limits

Local interface and SDP candidate checks report possible public routes; they do not probe or certify remote reachability. CGNAT/private-only endpoints on unrelated networks generally cannot connect without another reachable path. Removing intermediary services deliberately removes NAT-traversal fallback. This is a network constraint, not an unresolved promise that manual codes can bypass.

References: [WebRTC peer connections](https://webrtc.org/getting-started/peer-connections), [Electron capture permissions](https://www.electronjs.org/docs/latest/api/session), [TURN's role](https://webrtc.org/getting-started/turn-server).
