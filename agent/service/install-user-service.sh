#!/bin/sh
set -eu

if [ "${1:-}" != "--i-consent" ]; then
  echo "Refusing to install a background service without explicit consent." >&2
  echo "Review docs/INSTALLATION.md, then rerun: $0 --i-consent" >&2
  exit 64
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl is required for the supported user-service flow." >&2
  exit 69
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
config_home=${XDG_CONFIG_HOME:-"$HOME/.config"}
unit_dir="$config_home/systemd/user"
mkdir -p "$unit_dir"
install -m 0644 "$script_dir/wiiultraconnect-agent.service" "$unit_dir/wiiultraconnect-agent.service"
systemctl --user daemon-reload
systemctl --user enable --now wiiultraconnect-agent.service
echo "Installed and started the per-user WiiUltraConnect agent service."
