#!/usr/bin/env bash
# Installs or updates the secure helper pinned by this plugin version.
#
# Run by the panel inside Omarchy's floating terminal, so every step is visible
# and sudo is typed by the user into that terminal, never by the shell.
#
# By default it downloads the prebuilt helper package from this plugin's GitHub
# release and installs it only if its SHA-256 equals the value pinned in
# helper/proton-helper.lock.json (seconds). The release asset is built by
# .github/workflows/helper-release.yml from packaging/helper/ in a clean
# container, with a signed build-provenance attestation. With --from-source it
# builds packaging/helper/ on this machine instead (minutes): the recipe files
# are checked against their pins, and the recipe pins Proton's source tarball
# (full commit), the Node toolchain, and every local file by SHA-256.
#
# Either way nothing comes from the AUR, and a newer helper only ever arrives
# with a new plugin commit, which goes through the plugin's own review.
#
# It deletes nothing of the user's: the only file it removes is its own
# private build directory. Packages change only through pacman (and Proton's
# own app only after a confirm).
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
CONFLICTS=(proton-authenticator proton-authenticator-bin proton-authenticator-git)
PLUGIN_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RECIPE="$PLUGIN_DIR/packaging/helper"
LOCK="$PLUGIN_DIR/helper/proton-helper.lock.json"
CLIENT="$PLUGIN_DIR/scripts/helper_client.py"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

mode=install
from_source=false
for arg in "$@"; do
  case "$arg" in
    install | update) mode="$arg" ;;
    --from-source) from_source=true ;;
    *) fail "usage: setup-helper.sh [install|update] [--from-source]" ;;
  esac
done
# The prebuilt package is x86_64, like Omarchy.
[[ "$(uname -m)" == x86_64 ]] || from_source=true

# The exact helper version this plugin commit pins, e.g. 1.1.6.omarchy5-1.
want=$(/usr/bin/python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["package"]["version"])' "$LOCK")
[[ "$want" =~ ^[0-9][0-9a-z.]*-[0-9]+$ ]] || fail "The helper pin is unreadable. Nothing changed."
have=$(pacman -Q "$PACKAGE" 2>/dev/null | awk '{print $2}' || true)

installed_conflicts=()
for pkg in "${CONFLICTS[@]}"; do
  pacman -Q "$pkg" &>/dev/null && installed_conflicts+=("$pkg")
done
earlier_aur_build=false
pacman -Q "$EARLIER_AUR_BUILD" &>/dev/null && earlier_aur_build=true

# 1. Proton's own Linux app cannot run next to the helper (same app id, data
#    folder, keyring entry, and D-Bus name), and neither can an earlier AUR
#    build of this helper. Ask first; nothing is removed here. The package
#    declares conflicts= on all of them, so pacman swaps them for the helper
#    in the same transaction that installs it (step 2), only after the new
#    package is downloaded and verified. If anything fails before or during
#    that transaction, the installed app stays exactly as it was.
if ((${#installed_conflicts[@]} > 0)); then
  say "Proton's own Authenticator app is installed: ${installed_conflicts[*]}"
  echo "The helper is the same Proton app built from source with a private socket"
  echo "for the panel. The two share one data folder and cannot run together."
  echo "It is swapped for the helper in one step, only once the helper is verified."
  echo "Your codes and sign-in are kept."
  gum confirm "Replace it with the helper?" || fail "Nothing changed."
fi
if [[ "$earlier_aur_build" == true ]]; then
  say "An earlier AUR build of the helper is installed ($EARLIER_AUR_BUILD)."
  echo "It is replaced by the build pinned in this plugin. Your codes and sign-in are kept."
  gum confirm "Replace it?" || fail "Nothing changed."
fi
# Anything to replace forces an install, even if the pinned version is current.
replace=false
if ((${#installed_conflicts[@]} > 0)) || [[ "$earlier_aur_build" == true ]]; then
  replace=true
fi

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
if [[ "$have" != "$want" ]] || [[ "$replace" == true ]]; then
  say "Your password is needed once, to install the helper package."
  sudo -v || fail "Nothing changed."
  while true; do sudo -n true; sleep 60; done 2>/dev/null &
  keepalive=$!
fi

# 2. Install the pinned helper unless exactly that version is already
#    installed and nothing needs replacing. Work in a private directory outside
#    the plugin checkout (so it stays clean for `omarchy plugin update`),
#    removed afterwards.
install_package() {
  say "Installing $PACKAGE $want…"
  if [[ "$replace" == true ]]; then
    # `--ask=4` answers pacman's conflict question with yes (the user already
    # confirmed above), so the conflicting package is removed in the same
    # transaction that installs the verified helper, never before it. A failed
    # transaction leaves it installed.
    sudo pacman -U --noconfirm --ask=4 "$1" \
      || fail "The helper did not install. Your current app is still installed."
  else
    sudo pacman -U --noconfirm "$1" || fail "The helper did not install."
  fi
}

if [[ "$have" != "$want" ]] || [[ "$replace" == true ]]; then
  build_root="${XDG_CACHE_HOME:-$HOME/.cache}"
  mkdir -p -- "$build_root"
  build=$(mktemp -d "$build_root/proton-authenticator-helper-build.XXXXXX")

  if [[ "$from_source" == false ]]; then
    # The URL and SHA-256 come from this plugin version's lock file only.
    read -r url digest < <(/usr/bin/python3 - "$LOCK" <<'EOF'
import json, re, sys
release = json.load(open(sys.argv[1]))["release"]
url, digest = release["url"], release["sha256"]
prefix = "https://github.com/Zeus-Deus/proton-authenticator-omarchy-plugin/releases/download/helper-v"
if not url.startswith(prefix) or not re.fullmatch(r"[0-9a-f]{64}", digest):
    sys.exit(1)
print(url, digest)
EOF
    ) || fail "The helper pin is unreadable. Nothing changed."
    pkgfile="$build/helper.pkg.tar.zst"
    say "Downloading the helper built for this plugin version…"
    curl --proto '=https' --tlsv1.2 --fail --location --retry 3 --progress-bar \
      --output "$pkgfile" "$url" || fail "The download failed. Nothing changed."
    echo "$digest  $pkgfile" | sha256sum --check --quiet \
      || fail "The download does not match this plugin's pin. Nothing changed."
    echo "Checksum matches the pin."
    install_package "$pkgfile"
  else
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
    cp -- "$RECIPE"/* "$build"/
    say "Building the helper from Proton's official source (several minutes)…"
    (cd "$build" && makepkg --syncdeps --noconfirm) \
      || fail "The helper did not build. Nothing was replaced."
    pkgfile="$build/$PACKAGE-$want-x86_64.pkg.tar.zst"
    [[ -f "$pkgfile" ]] || fail "The built package is missing. Nothing was replaced."
    install_package "$pkgfile"
  fi
fi
[[ -x "$BINARY" ]] || fail "The helper binary is missing after install."

# 3. Start it for this user and wait for its socket.
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
