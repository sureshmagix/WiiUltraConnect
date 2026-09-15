// Test-only UDP relay, bound to one local IPv4 interface. Never shipped by the app.
// Install the isolated fixture: npm install --prefix artifacts/turn-test --ignore-scripts node-turn@0.0.6
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
const require = createRequire(import.meta.url);
let Turn;
try { Turn = require('../artifacts/turn-test/node_modules/node-turn'); }
catch { throw new Error('Install the test fixture first: npm install --prefix artifacts/turn-test --ignore-scripts node-turn@0.0.6'); }
const address = Object.values(networkInterfaces()).flat().find(info => !info.internal && info.family === 'IPv4')?.address;
if (!address) throw new Error('The TURN smoke test requires a local IPv4 interface.');
const server = new Turn({ listeningIps: [address], relayIps: [address], listeningPort: 34780,
  minPort: 34900, maxPort: 34940, authMech: 'long-term', credentials: { 'smoke-user': 'smoke-password' }, debugLevel: 'ERROR' });
let requests = 0;
server.on('message', () => { if (++requests === 1) console.log('TURN fixture received a request.'); });
server.start();
const child = spawn(process.execPath, ['scripts/smoke.mjs'], { stdio: 'inherit', windowsHide: true, env: { ...process.env, WII_SMOKE_TURN: '1', WII_SMOKE_TURN_URL: `turn:${address}:34780?transport=udp` } });
child.once('error', error => { console.error(error); server.stop(); process.exit(1); });
child.once('exit', code => { console.log(`TURN fixture handled ${requests} requests.`); server.stop(); process.exit(code ?? 1); });
process.once('SIGINT', () => { child.kill(); server.stop(); });
