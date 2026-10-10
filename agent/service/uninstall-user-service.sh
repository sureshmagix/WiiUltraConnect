#!/bin/sh
set -eu

if [ "${1:-}" != "--i-consent" ]; then
  echo "Refusing to remove a background service without explicit consent." >&2
  echo "Rerun: $0 --i-consent" >&2
  exit 64
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl is required for the supported user-service flow." >&2
  exit 69
fi

config_home=${XDG_CONFIG_HOME:-"$HOME/.config"}
unit="$config_home/systemd/user/wiiultraconnect-agent.service"
systemctl --user disable --now wiiultraconnect-agent.service || true
rm -f "$unit"
systemctl --user daemon-reload
echo "Removed the per-user WiiUltraConnect agent service."
