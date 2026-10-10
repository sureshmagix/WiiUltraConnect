import { spawn } from 'node:child_process';
import electron from 'electron';
// There is intentionally no signaling listener, STUN service or TURN relay in this test.
const env = { ...process.env, WII_SMOKE: '1', WII_SMOKE_FPS: process.argv[2] === '60' ? '60' : '30', WII_SIGNAL_URL: 'unused-legacy-setting', WII_ICE_SERVERS: 'invalid-legacy-setting' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['scripts/smoke-main.cjs'], { env, stdio: 'inherit', windowsHide: true });
const timeout = setTimeout(() => child.kill(), 60_000);
child.on('error', error => { console.error(error); clearTimeout(timeout); process.exit(1); });
child.on('exit', code => {
  clearTimeout(timeout);
  // 77 is an explicit unavailable-environment result written by
  // smoke-main.cjs. Preserve it so a caller cannot mistake a headless/TCC
  // skip for a successful Electron integration test.
  if (code === 77) console.error('Electron smoke test is unavailable on this host; see artifacts/serverless/smoke-unavailable.json.');
  process.exit(code ?? 1);
});
