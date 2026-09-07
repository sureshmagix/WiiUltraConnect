import { spawn } from 'node:child_process';
import electron from 'electron';
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// No HTTP/WebSocket listener or service is started by the direct edition.
const child = spawn(electron, ['.'], { stdio: 'inherit', env, windowsHide: false });
child.once('error', error => { console.error(error); process.exit(1); });
child.once('exit', code => process.exit(code ?? 0));
process.once('SIGINT', () => child.kill());
