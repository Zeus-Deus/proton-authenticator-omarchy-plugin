#!/usr/bin/env bash
# Builds and installs the secure helper from this plugin's own reviewed files.
#
# Run by the panel inside Omarchy's floating terminal, so every step is visible
# and sudo is typed by the user into that terminal, never by the shell. Nothing
# comes from the AUR: the package recipe is packaging/helper/ in this checkout,
# its files are checked against helper/proton-helper.lock.json before use, and
# the recipe pins Proton's source tarball (full commit), the Node toolchain, and
# every local file by SHA-256. A newer helper therefore only ever arrives with a
# new plugin commit, which goes through the plugin's own review.
#
# The package is named proton-authenticator-omarchy-helper@local. AUR names
# cannot contain '@', so no AUR package can share it and `omarchy update` never
# replaces it. Proton's data folder (~/.local/share/me.proton.authenticator) is
# never touched: codes, the signed-in session, and keyring entries survive.
set -euo pipefail

PACKAGE=proton-authenticator-omarchy-helper@local
EARLIER_AUR_BUILD=proton-authenticator-omarchy-helper
UNIT=proton-authenticator-omarchy-helper.service
BINARY=/usr/bin/proton-authenticator-omarchy-helper
LEGACY_DIR="$HOME/.local/opt/proton-authenticator-omarchy-helper"
LEGACY_LINK="$HOME/.local/bin/proton-authenticator-omarchy-helper"
LEGACY_UNIT="$HOME/.config/systemd/user/$UNIT"
CONFLICTS=(proton-authenticator proton-authenticator-bin proton-authenticator-git)
PLUGIN_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RECIPE="$PLUGIN_DIR/packaging/helper"
LOCK="$PLUGIN_DIR/helper/proton-helper.lock.json"
CLIENT="$PLUGIN_DIR/scripts/helper_client.py"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

mode="${1:-install}"
case "$mode" in
  install | update) ;;
  *) fail "usage: setup-helper.sh [install|update]" ;;
esac

# The exact helper version this plugin commit pins, e.g. 1.1.6.omarchy5-1.
want=$(/usr/bin/python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["package"]["version"])' "$LOCK")
[[ "$want" =~ ^[0-9][0-9a-z.]*-[0-9]+$ ]] || fail "The helper pin is unreadable. Nothing changed."
have=$(pacman -Q "$PACKAGE" 2>/dev/null | awk '{print $2}' || true)

installed_conflicts=()
for pkg in "${CONFLICTS[@]}"; do
  pacman -Q "$pkg" &>/dev/null && installed_conflicts+=("$pkg")
done

# Ask for sudo once, up front, and keep it fresh through the long build (like
# omarchy-sudo-keepalive), so the install step never waits on a prompt that
# times out after the user has walked away. Only when something will change.
keepalive=""
cleanup() {
  [[ -n "$keepalive" ]] && kill "$keepalive" 2>/dev/null
  [[ -n "${build:-}" ]] && rm -rf -- "$build"
  return 0
}
trap cleanup EXIT
# Closing the terminal mid-build still removes the build directory.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ "$have" != "$want" ]] || ((${#installed_conflicts[@]} > 0)); then
  say "Your password is needed once, to install the helper package."
  sudo -v || fail "Nothing changed."
  while true; do sudo -n true; sleep 60; done 2>/dev/null &
  keepalive=$!
fi

# 1. Proton's own Linux app cannot run next to the helper (same app id, data
#    folder, keyring entry, and D-Bus name). Offer to remove it; codes stay on
#    the Proton account and in the shared data folder.
if ((${#installed_conflicts[@]} > 0)); then
  say "Proton's own Authenticator app is installed: ${installed_conflicts[*]}"
  echo "The helper is the same Proton app built from source with a private socket"
  echo "for the panel. The two share one data folder and cannot run together."
  echo "Your codes and sign-in are kept."
  gum confirm "Replace it with the helper?" || fail "Nothing changed."
  omarchy-pkg-drop "${installed_conflicts[@]}"
fi

# 2. Build and install the pinned helper unless exactly that version is
#    already installed.
if [[ "$have" != "$want" ]]; then
  say "Checking the helper recipe against this plugin's pin…"
  /usr/bin/python3 - "$LOCK" "$PLUGIN_DIR" <<'EOF' || fail "The helper recipe does not match the pin. Nothing changed."
import hashlib, json, pathlib, sys
lock = json.load(open(sys.argv[1]))
root = pathlib.Path(sys.argv[2])
bad = [name for name, digest in lock["recipe"].items()
       if hashlib.sha256((root / name).read_bytes()).hexdigest() != digest]
if bad:
    print("changed:", ", ".join(bad), file=sys.stderr)
    sys.exit(1)
print(f"{len(lock['recipe'])} files match the pin")
EOF

  # Build outside the plugin checkout, so it stays clean for
  # `omarchy plugin update`, in a private directory removed afterwards.
  build_root="${XDG_CACHE_HOME:-$HOME/.cache}"
  mkdir -p -- "$build_root"
  build=$(mktemp -d "$build_root/proton-authenticator-helper-build.XXXXXX")
  cp -- "$RECIPE"/* "$build"/

  say "Building the helper from Proton's official source (a few minutes)…"
  (cd "$build" && makepkg --syncdeps --noconfirm) \
    || fail "The helper did not build. Nothing was replaced."
  pkgfile="$build/$PACKAGE-$want-x86_64.pkg.tar.zst"
  [[ -f "$pkgfile" ]] || fail "The built package is missing. Nothing was replaced."

  say "Installing $PACKAGE $want…"
  if pacman -Q "$EARLIER_AUR_BUILD" &>/dev/null; then
    # An earlier AUR build of this helper is installed. `--ask=4` answers
    # pacman's conflict question with yes, so it is swapped for this build in
    # one transaction instead of being removed first.
    echo "Replacing the earlier AUR build with this reviewed build."
    sudo pacman -U --noconfirm --ask=4 "$pkgfile" || fail "The helper did not install."
  else
    sudo pacman -U --noconfirm "$pkgfile" || fail "The helper did not install."
  fi
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
