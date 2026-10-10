# Installation, repair, update, and removal

Use a signed production artifact whenever one is available. If an artifact directory contains `BUILD_STATUS.txt` saying **UNSIGNED DEVELOPMENT ARTIFACT**, use it only for testing in a trusted environment.

## Desktop application

### Windows x64

Supported operating systems are Windows 10 22H2 x64 and Windows 11 x64. Run `WiiUltraConnect-<version>-windows-x64-setup.exe` from the reviewed release bundle. The assisted NSIS installer defaults to a per-user install and requests elevation only if the person installing selects an all-users/elevated path. The application includes its Electron runtime and x64 native-input module.

PowerShell verification and install:

```powershell
Get-FileHash .\WiiUltraConnect-<version>-windows-x64-setup.exe -Algorithm SHA256
Get-AuthenticodeSignature .\WiiUltraConnect-<version>-windows-x64-setup.exe
Start-Process -Wait .\WiiUltraConnect-<version>-windows-x64-setup.exe
```

Run the same or a newer installer to repair application files or upgrade. This preserves `%APPDATA%\WiiUltraConnect`. During uninstall, the uninstaller asks whether to remove that directory; choose **No** to preserve settings/session history for reinstall, or **Yes** to remove it. An all-users install can prompt for administrator approval; no background service is installed.

### macOS Intel and Apple Silicon

Supported operating systems are macOS 12.0+ on the matching x86_64 or arm64 artifact. Open the matching DMG, drag `WiiUltraConnect.app` to Applications, then launch it. The app includes the Electron runtime and its universal native-input module.

```sh
shasum -a 256 WiiUltraConnect-<version>-mac-arm64.dmg
hdiutil attach WiiUltraConnect-<version>-mac-arm64.dmg
# Drag WiiUltraConnect.app to /Applications in Finder, then detach the mounted DMG.
codesign --verify --deep --strict --verbose=2 /Applications/WiiUltraConnect.app
spctl --assess --type execute --verbose=4 /Applications/WiiUltraConnect.app
```

For a repair or upgrade, replace `/Applications/WiiUltraConnect.app` with the newer app; this preserves `~/Library/Application Support/WiiUltraConnect`. To uninstall, move the app to Trash. Preserve data by stopping there, or make the explicit destructive choice below after quitting the app:

```sh
rm -rf "$HOME/Library/Application Support/WiiUltraConnect"
```

macOS asks for Screen Recording before sharing and Accessibility before the host allows control. Approval is per person and per device; installing does not grant either permission.

### Ubuntu desktop DEB

Supported desktop candidates are Ubuntu 22.04 LTS and 24.04 LTS x64 with glibc 2.35+. The x64 DEB contains the Electron runtime and matching x64 native module; `apt` installs only the declared OS runtime libraries. ARM64 is not a supported release until the package's native-module architecture and clean-machine checks pass.

```sh
sha256sum wiiultraconnect_<version>_amd64.deb
dpkg-deb --info wiiultraconnect_<version>_amd64.deb
sudo apt install ./wiiultraconnect_<version>_amd64.deb
wiiultraconnect
```

Re-run `sudo apt install ./wiiultraconnect_<new-version>_amd64.deb` for repair or upgrade; user data is preserved at `~/.config/WiiUltraConnect`. Remove the package while preserving data with `sudo apt remove wiiultraconnect`. To remove the package and make the separate explicit choice to delete user data:

```sh
sudo apt purge wiiultraconnect
rm -rf "$HOME/.config/WiiUltraConnect"
```

Linux remote input requires an X11 session. Wayland support is capture/viewing-dependent and remote input is intentionally disabled. No package installer enables a system or user service.

## Headless Linux agent

The headless agent DEB is for Ubuntu 22.04/24.04 x64. It embeds Electron as its runtime and exposes only a per-user UNIX-socket status service. It does not listen on the network, accept a remote session, bypass desktop consent, or provide unattended access. ARM64 remains pending the native-module gate and target-device validation.

```sh
sudo apt install ./wiiultraconnect-agent_<version>_amd64.deb
/opt/WiiUltraConnectAgent/wiiultraconnect-agent --once
```

Installing the DEB deliberately does **not** install or start a background service. Review the unit, then give explicit consent to install a least-privilege user service; no `sudo` is required for this flow:

```sh
cat /opt/WiiUltraConnectAgent/resources/agent-service/wiiultraconnect-agent.service
/opt/WiiUltraConnectAgent/resources/agent-service/install-user-service.sh --i-consent
systemctl --user status wiiultraconnect-agent.service
```

To remove the service, first make the same explicit consent choice, then remove the package. This avoids a stale user service referencing an uninstalled binary:

```sh
/opt/WiiUltraConnectAgent/resources/agent-service/uninstall-user-service.sh --i-consent
sudo apt purge wiiultraconnect-agent
```

## Signed updates

The app checks updates only after the person selects **Check updates** and only in a production build configured with a HTTPS update metadata URL. It verifies the Ed25519 metadata signature, monotonic sequence/version, artifact platform/architecture, byte size, and SHA-256 before saving an installer in the Downloads directory. The app never silently installs an update: close the app and run the verified installer (or use the platform's DEB command) after download.

If a build says updates are not configured, it is a development/offline build. Download a reviewed signed installer manually; do not bypass this by accepting an unsigned metadata file.

## Clean-machine acceptance checklist

For every platform actually available to the release owner, use a fresh VM or device with no Node.js, npm, Cargo, or source checkout. Verify the checksum/signature, install, launch, grant only requested OS permissions, complete one host/viewer connection, exercise service status where applicable, upgrade over the prior version, and test both data-preserving and data-removing uninstall paths. Record the result in [VALIDATION.md](VALIDATION.md). A CI archive is not clean-machine certification.
