/*
 * A deliberately narrow, local-only companion for managed Linux desktops.
 * It exposes status over a per-user UNIX socket.  It has no listener on the
 * network, no session protocol, and cannot grant remote control by itself.
 */
const { app } = require('electron');
const { defaultRuntimeDir } = require('./runtime.cjs');
const { startLocalStatusService } = require('./status-service.cjs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('headless');

const metadata = require('../package.json');
const args = new Set(process.argv.slice(1));
const runtimeDir = defaultRuntimeDir();
let socketPath = `${runtimeDir}/wiiultraconnect-agent.sock`;

function status() {
  return {
    product: 'WiiUltraConnectAgent',
    version: metadata.version,
    pid: process.pid,
    platform: process.platform,
    architecture: process.arch,
    socket: socketPath,
    capabilities: {
      localStatus: true,
      networkListener: false,
      unattendedRemoteControl: false,
      nativeInput: process.env.XDG_SESSION_TYPE === 'x11'
    },
    note: 'The agent does not accept remote sessions. Open the desktop app and approve every control session there.'
  };
}

function printOnce() {
  process.stdout.write(`${JSON.stringify(status())}\n`);
  app.quit();
}

function startService() {
  const service = startLocalStatusService({
    runtimeDir,
    status,
    onError: error => { console.error(`agent socket error: ${error.message}`); app.exit(1); }
  });
  socketPath = service.socketPath;
  const stop = () => service.stop(() => app.quit());
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

app.whenReady().then(() => {
  if (args.has('--once') || args.has('--status')) return printOnce();
  if (args.has('--service')) return startService();
  console.error('Usage: wiiultraconnect-agent --once | --service');
  app.exit(64);
});
