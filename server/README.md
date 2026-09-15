# WiiUltraConnect Server

This is the complete server-side package for WiiUltraConnect. It provides:

- HTTPS/WSS termination through Caddy
- WebSocket signaling on `/ws`
- coturn relay for internet remote-desktop sessions
- Persistent, server-unique usernames for unattended computers

The server does not receive desktop video, audio, remote input, chat, files, access passwords or TURN credentials sent by the app. It keeps a username and a hash of each computer's private device key so it can route connection setup to an online computer.

## Deploy on Utho

1. Install Docker Engine and Docker Compose on an Ubuntu Utho server.
2. Point an A record such as `remote.example.com` to the server's public IPv4 address.
3. Open the following ports in Utho's firewall and the operating-system firewall:

   - TCP `80`, `443`, `3478`
   - UDP `3478`, `49160-49200`

4. Copy `.env.example` to `.env` and set these values:

   ```dotenv
   WUC_DOMAIN=remote.example.com
   PUBLIC_IP=your-public-ipv4
   TURN_USERNAME=your-turn-username
   TURN_PASSWORD=a-long-random-turn-password
   ```

5. Start the services:

   ```sh
   docker compose up -d --build
   docker compose ps
   ```

6. Verify the service:

   ```sh
   curl https://remote.example.com/healthz
   ```

The desktop app needs these values in Advanced settings:

```text
Server URL:  wss://remote.example.com/ws
TURN URL:    turn:remote.example.com:3478?transport=udp
TURN user:   your-turn-username
TURN pass:   a-long-random-turn-password
```

Back up the `signal-data` Docker volume. Caddy retains TLS certificate state in `caddy-data`.
