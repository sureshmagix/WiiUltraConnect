import { spawn } from 'node:child_process';
import electron from 'electron';
import { createSignalingServer } from '../server/signaling.mjs';

const signalServer = createSignalingServer();
try {
  const addr = await signalServer.listen(8787, '0.0.0.0');
  console.log(`[Dev] Signaling server active on port ${typeof addr === 'object' ? addr.port : 8787}`);
} catch {
  console.log('[Dev] Signaling server port already in use, using existing listener.');
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.'], { stdio: 'inherit', env, windowsHide: false });
child.once('error', error => { console.error(error); process.exit(1); });
child.once('exit', code => {
  void signalServer.close();
  process.exit(code ?? 0);
});

process.once('SIGINT', () => {
  void signalServer.close();
  child.kill();
});
