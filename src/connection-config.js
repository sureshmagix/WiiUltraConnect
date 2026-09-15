import { directIceConfig, candidateAddresses } from './direct-signaling.js';
import { networkSummary } from './protocol.js';

function serverUrls(value = '', kind) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error(`${kind} server URLs are too long.`);
  const urls = [...new Set(value.trim().split(/[\s,]+/).filter(Boolean))];
  if (urls.length > 8) throw new Error(`Use at most eight ${kind} server URLs.`);
  for (const url of urls) {
    // ICE URIs are not HTTP URLs. Reject paths, userinfo and arbitrary query parameters.
    const match = /^(stun|turn|turns):(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?(?:\?transport=(udp|tcp))?$/i.exec(url);
    if (!match || (kind === 'STUN' ? match[1].toLowerCase() !== 'stun' || match[4] : !/^turns?$/i.test(match[1])) ||
        match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535) || /^turns$/i.test(match[1]) && match[4]?.toLowerCase() === 'udp') {
      throw new Error(`Invalid ${kind} URL. Use ${kind === 'STUN' ? 'stun:hostname:3478' : 'turn:hostname:3478 or turns:hostname:5349?transport=tcp'}.`);
    }
  }
  return urls;
}

export function connectionConfig(settings = {}) {
  const mode = settings.mode ?? 'direct';
  if (mode === 'direct') return directIceConfig();
  if (mode !== 'internet') throw new Error('Choose Direct or Internet connection mode.');
  const stun = serverUrls(settings.stunUrls, 'STUN'), turn = serverUrls(settings.turnUrls, 'TURN');
  const iceServers = [];
  if (stun.length) iceServers.push({ urls: stun });
  if (turn.length) {
    if (typeof settings.username !== 'string' || !settings.username.trim() || settings.username.length > 512 ||
        typeof settings.credential !== 'string' || !settings.credential || settings.credential.length > 2048) {
      throw new Error('Enter the TURN username and password supplied by your relay provider.');
    }
    iceServers.push({ urls: turn, username: settings.username.trim(), credential: settings.credential });
  }
  if (settings.relayOnly && !turn.length) throw new Error('Relay-only mode requires a TURN server, username and password.');
  if (!iceServers.length) throw new Error('Internet mode requires a STUN or TURN server. Enter your provider’s connection details.');
  return { iceServers, iceTransportPolicy: settings.relayOnly ? 'relay' : 'all', bundlePolicy: 'max-bundle' };
}

export function hasTurn(config) {
  return config.iceServers.some(server => (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => /^turns?:/i.test(url)));
}

export function connectionDiagnostics(sdp, mode, config) {
  const summary = networkSummary(candidateAddresses(sdp));
  const relay = /^a=candidate:.*\btyp\s+relay\b/im.test(sdp);
  const mapped = /^a=candidate:.*\btyp\s+srflx\b/im.test(sdp);
  if (mode !== 'internet') return { ...summary, relay: false };
  const message = relay
    ? 'TURN relay address obtained. Internet fallback is available; the connection still needs to reach your partner.'
    : hasTurn(config)
      ? 'No TURN relay address obtained. Check the relay URL, credentials and network access before trying again.'
      : mapped
        ? 'STUN discovered a mapped address. Direct internet access may work, but restrictive NAT/CGNAT can still require a TURN relay.'
        : 'No STUN mapped address obtained. Check STUN access or configure a TURN relay; local addresses alone may not work across internet networks.';
  return { ...summary, relay, message };
}

export function connectionFailure(mode, config, localSdp = '', remoteSdp = '') {
  if (mode !== 'internet') return 'Direct connection failed. Use Internet mode on both computers with a TURN relay for networks behind NAT/CGNAT, or provide a reachable direct path. New codes alone cannot fix a blocked network path.';
  if (!hasTurn(config) && !/\btyp\s+relay\b/i.test(remoteSdp)) return 'Internet connection failed without a TURN relay. STUN alone cannot traverse every NAT/CGNAT network. Configure TURN on both computers, then exchange new codes.';
  if (hasTurn(config) && !/\btyp\s+relay\b/i.test(localSdp)) return 'The TURN server did not provide a relay address. Check its URL, username, password and expiry. Try your provider’s TURN over TCP/TLS endpoint if UDP is blocked, then exchange new codes.';
  return 'Internet connection failed despite an available relay address. Check TURN permissions, relay ports and firewall access at both ends. Try your provider’s TURN over TCP/TLS endpoint, then exchange new codes.';
}
