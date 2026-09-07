import { spawn } from 'node:child_process';
import electron from 'electron';
import { createSignalingServer } from '../server/signaling.mjs';
const server = createSignalingServer();
try { await server.listen(8787); } catch (error) {
  console.error(`Cannot start local signaling: ${error.message}. Use npm start if a server is already running.`);
  process.exit(1);
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { stdio: 'inherit', env, windowsHide: false });
child.once('error', async error => { console.error(error); await server.close(); process.exit(1); });
child.once('exit', async code => { await server.close(); process.exit(code ?? 0); });
process.once('SIGINT', () => child.kill());
