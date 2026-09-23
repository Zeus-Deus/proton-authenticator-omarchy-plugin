#!/usr/bin/env bash
# Installs, updates, or switches to the packaged Proton Authenticator helper.
#
# Run by the panel inside Omarchy's floating terminal, so every step is visible
# and sudo is typed by the user into that terminal, never by the shell. It only
# uses Omarchy's own package commands plus `systemctl --user`, and never touches
# Proton's data folder (~/.local/share/me.proton.authenticator): codes, the
# signed-in session, and keyring entries survive install, update, and switch.
set -euo pipefail

PACKAGE=proton-authenticator-omarchy-helper
UNIT=proton-authenticator-omarchy-helper.service
BINARY=/usr/bin/proton-authenticator-omarchy-helper
LEGACY_DIR="$HOME/.local/opt/proton-authenticator-omarchy-helper"
LEGACY_LINK="$HOME/.local/bin/proton-authenticator-omarchy-helper"
LEGACY_UNIT="$HOME/.config/systemd/user/$UNIT"
CONFLICTS=(proton-authenticator proton-authenticator-bin proton-authenticator-git)
CLIENT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/helper_client.py"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

mode="${1:-install}"
case "$mode" in
  install | update) ;;
  *) fail "usage: setup-helper.sh [install|update]" ;;
esac

# 1. Proton's own Linux app cannot run next to the helper (same app id, data
#    folder, keyring entry, and D-Bus name). Offer to remove it; codes stay on
#    the Proton account and in the shared data folder.
installed_conflicts=()
for pkg in "${CONFLICTS[@]}"; do
  pacman -Q "$pkg" &>/dev/null && installed_conflicts+=("$pkg")
done
if ((${#installed_conflicts[@]} > 0)); then
  say "Proton's own Authenticator app is installed: ${installed_conflicts[*]}"
  echo "The helper is the same Proton app built from source with a private socket"
  echo "for the panel. The two share one data folder and cannot run together."
  echo "Your codes and sign-in are kept."
  gum confirm "Replace it with the helper?" || fail "Nothing changed."
  omarchy-pkg-drop "${installed_conflicts[@]}"
fi

# 2. Install or update the helper package from the AUR. `omarchy update` keeps
#    it current afterwards like every other AUR package.
if ! pacman -Q "$PACKAGE" &>/dev/null; then
  omarchy-pkg-aur-accessible || fail "The AUR is not reachable right now. Try again later."
  say "Building $PACKAGE from Proton's official source (a few minutes)…"
  omarchy-pkg-aur-add "$PACKAGE" || fail "The helper did not install."
elif [[ "$mode" == update ]]; then
  omarchy-pkg-aur-accessible || fail "The AUR is not reachable right now. Try again later."
  say "Updating $PACKAGE from Proton's official source (a few minutes)…"
  yay -S --needed --noconfirm "$PACKAGE" || fail "The helper did not build. Nothing was replaced."
fi
[[ -x "$BINARY" ]] || fail "The helper binary is missing after install."

# 3. Retire a hand-built development helper, if any. Its user unit in
#    ~/.config would shadow the packaged one in /usr/lib/systemd/user.
if [[ -e "$LEGACY_UNIT" || -e "$LEGACY_LINK" || -d "$LEGACY_DIR" ]]; then
  say "Switching from the development helper to the packaged one…"
  systemctl --user disable --now "$UNIT" 2>/dev/null || true
  rm -f -- "$LEGACY_UNIT"
  [[ -L "$LEGACY_LINK" ]] && rm -f -- "$LEGACY_LINK"
  rm -rf -- "$LEGACY_DIR"
fi

# 4. Start it for this user and wait for its socket.
systemctl --user daemon-reload
systemctl --user enable "$UNIT" >/dev/null
systemctl --user restart "$UNIT"

say "Waiting for the helper…"
for _ in $(seq 1 30); do
  if /usr/bin/python3 "$CLIENT" status >/dev/null 2>&1; then
    say "The secure helper is running. Open the panel to sign in with Proton."
    exit 0
  fi
  sleep 1
done
fail "The helper did not start. Check: journalctl --user -u $UNIT"
