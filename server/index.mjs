import { createSignalingServer } from './signaling.mjs';

const port = Number(process.env.PORT || process.env.WII_PORT || 8787);
const host = process.env.HOST || '0.0.0.0';

const server = createSignalingServer();
const addr = await server.listen(port, host);
console.log(`WiiUltraConnect signaling server listening on ${typeof addr === 'object' ? `${addr.address}:${addr.port}` : addr}`);

const shutdown = async () => {
  console.log('Shutting down signaling server...');
  await server.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
