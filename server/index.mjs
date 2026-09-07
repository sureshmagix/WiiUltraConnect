import { createSignalingServer } from './signaling.mjs';
const server = createSignalingServer({
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'null,file://').split(',').map(s => s.trim())
});
const address = await server.listen(Number(process.env.PORT || 8787), process.env.HOST || '127.0.0.1');
console.log(`WiiUltraConnect signaling listening on ${address.address}:${address.port}/signal`);
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, async () => { await server.close(); process.exit(0); });
