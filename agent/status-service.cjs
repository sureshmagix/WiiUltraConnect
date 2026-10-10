const fs = require('node:fs');
const net = require('node:net');
const { prepareSocketPath } = require('./runtime.cjs');

const MAX_REQUEST_BYTES = 1024;

function startLocalStatusService({ runtimeDir, status, socketName, onError = () => {} }) {
  const socketPath = prepareSocketPath(runtimeDir, socketName);
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    let request = '';
    let served = false;
    socket.on('data', chunk => {
      if (served) return;
      request += chunk;
      if (request.length > MAX_REQUEST_BYTES) { served = true; socket.destroy(); return; }
      if (!request.includes('\n')) return;
      served = true;
      // Status is deliberately the sole protocol verb. Do not trim arbitrary
      // control text into a valid command.
      if (request === 'status\n' || request === 'status\r\n') socket.end(`${JSON.stringify(status(socketPath))}\n`);
      else socket.end('{"error":"unsupported command"}\n');
    });
    socket.once('error', () => {});
  });
  server.on('error', onError);
  server.listen(socketPath, () => {
    try { fs.chmodSync(socketPath, 0o600); } catch (error) { server.close(() => onError(error)); }
  });
  const stop = callback => server.close(error => {
    try { fs.unlinkSync(socketPath); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') error ||= unlinkError; }
    callback?.(error);
  });
  return { server, socketPath, stop };
}

module.exports = { MAX_REQUEST_BYTES, startLocalStatusService };
