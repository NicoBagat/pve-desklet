#!/usr/bin/env bash
# Install the desklet for the current user on Linux Mint (Cinnamon edition).
#
#   ./install.sh          copy the desklet into ~/.local/share/cinnamon/desklets
#   ./install.sh --link   symlink instead (edit in the repo, then reload the desklet)
#
# Also offers to create the API token file (~/.config/pve-desklet/token, mode 600).
set -euo pipefail

UUID="pve-desklet@nicobagat"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$UUID"
DEST_DIR="$HOME/.local/share/cinnamon/desklets"
DEST="$DEST_DIR/$UUID"
TOKEN_FILE="$HOME/.config/pve-desklet/token"

if [[ ! -f "$SRC/metadata.json" ]]; then
    echo "error: $SRC not found — run this from the project checkout" >&2
    exit 1
fi

mkdir -p "$DEST_DIR"
rm -rf -- "$DEST"
if [[ "${1:-}" == "--link" ]]; then
    ln -s "$SRC" "$DEST"
    echo "Linked $DEST -> $SRC"
else
    cp -r "$SRC" "$DEST"
    echo "Copied desklet to $DEST"
fi

if [[ -f "$TOKEN_FILE" ]]; then
    chmod 600 "$TOKEN_FILE"
    echo "Token file already present: $TOKEN_FILE (permissions set to 600)"
else
    install -d -m 700 "$(dirname "$TOKEN_FILE")"
    read -rsp "Paste the API token as user@realm!tokenid=secret (empty to skip): " token
    echo
    if [[ -n "$token" ]]; then
        (umask 077 && printf '%s\n' "$token" > "$TOKEN_FILE")
        echo "Saved $TOKEN_FILE"
    else
        echo "Skipped — create $TOKEN_FILE (mode 600) before enabling the desklet."
    fi
fi

cat <<EOF

Next:
  1. Right-click the desktop -> Add Desklets -> "Proxmox VE Monitor" -> +
  2. Right-click the desklet -> Configure… -> set the API URL(s)
  If you are updating an already-running desklet, remove and re-add it
  (or restart Cinnamon with Ctrl+Alt+Esc) to load the new code.
EOF
