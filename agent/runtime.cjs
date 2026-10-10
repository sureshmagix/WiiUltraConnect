const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function defaultRuntimeDir(env = process.env, uid = process.getuid?.()) {
  return env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `wiiultraconnect-${uid ?? 'user'}`);
}

function ensurePrivateRuntimeDir(directory, uid = process.getuid?.()) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Agent runtime path is not a real directory: ${directory}`);
  // The agent is only packaged for Linux, but leave non-POSIX test hosts
  // functional.  A private parent directory prevents other local accounts
  // from connecting before the UNIX socket's mode is tightened.
  if (process.platform !== 'win32') {
    if (uid !== undefined && stat.uid !== uid) throw new Error(`Agent runtime directory is not owned by this user: ${directory}`);
    if ((stat.mode & 0o077) !== 0) throw new Error(`Agent runtime directory must not be accessible by group or other users: ${directory}`);
  }
  return directory;
}

function prepareSocketPath(runtimeDir, socketName = 'wiiultraconnect-agent.sock') {
  ensurePrivateRuntimeDir(runtimeDir);
  const socketPath = path.join(runtimeDir, socketName);
  try {
    const stat = fs.lstatSync(socketPath);
    // Only a stale UNIX domain socket is safe for this process to remove. A
    // regular file, FIFO, directory, or symlink is an unexpected local state
    // and must not be silently deleted.
    if (!stat.isSocket() || stat.isSymbolicLink()) throw new Error(`Refusing to replace a non-socket agent entry: ${socketPath}`);
    fs.unlinkSync(socketPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return socketPath;
}

module.exports = { defaultRuntimeDir, ensurePrivateRuntimeDir, prepareSocketPath };
