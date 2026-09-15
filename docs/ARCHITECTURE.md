# Connection architecture — 0.4.0

The app establishes one host/viewer WebRTC connection. The host captures a selected display before creating an SDP offer. Users can exchange the complete invitation and answer themselves. Direct mode defaults to `iceServers: []` and ignores injected/legacy server settings. Explicit Internet mode validates local STUN/TURN settings and passes them to WebRTC; TURN supports authenticated UDP, TCP and TLS endpoints and an optional relay-only policy.

The optional self-hosted signaling service accepts a WebSocket connection only at `/ws`. A controlled computer registers a server-unique username plus an internal high-entropy device key; the service stores the username and only a SHA-256 hash of that key. An operator requests an online computer using that username and a PBKDF2-derived access verifier. The service rate-limits attempts, forwards the verifier to the registered host and relays offer/answer messages only after the host accepts it. It never receives the raw access password, TURN credentials, WebRTC media, data-channel traffic or native input. Renderer CSP permits only WebSocket connections for this opt-in route; HTTP/HTTPS fetches remain blocked.

Manual signaling transports SDP containing DTLS certificate fingerprints and ICE credentials. The response includes a SHA-256 binding to the original offer, protocol version, session UUID and lifetime. Validation bounds code/SDP sizes, requires complete ICE/fingerprint fields and candidates, and checks expiry/role. Version 1 Direct codes reject relays; version 2 Internet codes allow them. Prefix/version mismatches and mode mismatches are rejected before applying SDP. Codes never enable services or supply local server configuration. TURN credentials are encrypted at rest through Electron's safe storage and excluded from generated packets. WebRTC encrypts video/audio and data between the two endpoints, including relayed traffic.

Gathering is bounded to 15 seconds in Direct mode and 45 seconds in Internet mode. Internet mode exports a usable snapshot one second after obtaining a relay candidate (when TURN is configured), or a mapped STUN candidate otherwise, if gathering has not completed sooner. This avoids exhausting viewer ICE checks while unused interfaces or other endpoints time out. Later candidates are not exchanged; if the exported paths fail, try another configured endpoint and exchange new codes. Host connection checks after applying the response are bounded to 30 and 60 seconds respectively. Diagnostics distinguish mapped STUN addresses, missing TURN allocations and available relay addresses; allocation is not proof of end-to-end reachability. ICE errors are reported without echoing server URLs or credentials.

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

Remote input requires active capture, a connected app session, valid display coordinates and successful registration of **Ctrl/Cmd + Alt + Shift + F12**. Manual sessions require a native host consent dialog. Unattended sessions skip that dialog only when the controlled computer is locally configured for unattended access and its locally stored PBKDF2 verifier accepts the incoming request. Revocation invalidates queued work before awaiting native release. Lost displays, crashed renderers and app shutdown revoke permissions. Display scale coordinates convert from Electron DIP to native Windows pixels.

Fullscreen uses the entire session panel so End session, control permission, quality, scaling and chat remain reachable. Pointer coordinates refer to the displayed video image, including letterboxing and scrolled actual-size views. Focus loss, pointer cancellation, window blur and visibility changes release held inputs. OS-reserved shortcuts and secure desktops remain outside the ordinary capture/input boundary.

## Connectivity limits

Local interface and SDP candidate checks report possible public routes; they do not certify remote reachability. CGNAT/private-only endpoints on unrelated networks may need TURN. Direct mode deliberately has no NAT-traversal fallback. Internet mode requires a reachable, correctly configured STUN/TURN service; no hosted relay is bundled or provisioned. A successful allocation still depends on relay permissions/ports, provider availability and the remote path. Restrictive firewalls can also block relay access. Manual codes cannot bypass these restrictions.

References: [WebRTC peer connections](https://webrtc.org/getting-started/peer-connections), [Electron capture permissions](https://www.electronjs.org/docs/latest/api/session), [TURN's role](https://webrtc.org/getting-started/turn-server).
