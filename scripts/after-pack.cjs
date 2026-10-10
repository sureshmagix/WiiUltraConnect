/*
 * electron-builder copies every libnut platform package because libnut lists
 * them as ordinary dependencies.  Shipping them all is both wasteful and can
 * accidentally hide a bad cross-target build.  Keep exactly the target's
 * implementation in app.asar.unpacked.
 */
const fs = require('node:fs');
const path = require('node:path');

function findResources(appOutDir) {
  const candidates = [
    path.join(appOutDir, 'resources'),
    path.join(appOutDir, 'Resources'),
    path.join(appOutDir, 'Contents', 'Resources')
  ];
  if (fs.existsSync(appOutDir)) {
    for (const entry of fs.readdirSync(appOutDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.endsWith('.app')) candidates.push(path.join(appOutDir, entry.name, 'Contents', 'Resources'));
    }
  }
  const found = candidates.find(dir => fs.existsSync(path.join(dir, 'app.asar')));
  if (!found) throw new Error(`Could not locate app resources below ${appOutDir}`);
  return found;
}

exports.default = async function pruneNativeRuntime(context) {
  const platform = context.electronPlatformName;
  const platformPackage = { win32: 'libnut-win32', darwin: 'libnut-darwin', linux: 'libnut-linux' }[platform];
  if (!platformPackage) throw new Error(`Unsupported package platform: ${platform}`);

  const resources = findResources(context.appOutDir);
  const nutRoot = path.join(resources, 'app.asar.unpacked', 'node_modules', '@nut-tree-fork');
  if (!fs.existsSync(nutRoot)) throw new Error(`Native runtime was not unpacked: ${nutRoot}`);

  for (const name of ['libnut-win32', 'libnut-darwin', 'libnut-linux']) {
    if (name !== platformPackage) fs.rmSync(path.join(nutRoot, name), { recursive: true, force: true });
  }
  if (platform !== 'darwin') fs.rmSync(path.join(nutRoot, 'node-mac-permissions'), { recursive: true, force: true });

  const nativeModule = path.join(nutRoot, platformPackage, 'build', 'Release', 'libnut.node');
  if (!fs.existsSync(nativeModule)) throw new Error(`Target native module is missing: ${nativeModule}`);
};
