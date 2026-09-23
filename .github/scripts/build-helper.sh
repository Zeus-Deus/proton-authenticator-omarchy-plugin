#!/usr/bin/env bash
# Builds the secure helper package from packaging/helper/ in a clean Arch Linux
# container. The release workflow (.github/workflows/helper-release.yml) runs
# it on GitHub; maintainers can run the same thing locally:
#
#   docker run --rm -v "$PWD:/src:ro" -v "$PWD/out:/out" -e HOST_UID="$(id -u)" \
#     archlinux:base-devel@sha256:8745817f349ed24373341ddb92776209eeec3f0364ea48f7f645ac5800d30a50 \
#     bash /src/.github/scripts/build-helper.sh
#
# Output in /out: the package (renamed without '@', which release asset names
# do not keep), SHA256SUMS, and the release notes.
set -euo pipefail

src=/src
out=/out
lock="$src/helper/proton-helper.lock.json"

# The recipe must match the SHA-256 pins the installer checks, file by file.
pacman -Syu --noconfirm --needed jq >/dev/null
while IFS=$'\t' read -r file digest; do
  echo "$digest  $src/$file" | sha256sum --check --quiet
done < <(jq -r '.recipe | to_entries[] | "\(.key)\t\(.value)"' "$lock")
echo "recipe matches the lock file"

version=$(jq -r '.package.version' "$lock")
name=$(jq -r '.package.name' "$lock")
[[ "$version" =~ ^[0-9][0-9a-z.]*-[0-9]+$ ]] || { echo "bad version: $version" >&2; exit 1; }

# Build dependencies straight from the PKGBUILD, from Arch's official repos.
mapfile -t deps < <(bash -c 'source "$1"; printf "%s\n" "${depends[@]}" "${makedepends[@]}"' _ "$src/packaging/helper/PKGBUILD")
pacman -S --noconfirm --needed "${deps[@]}"

# makepkg refuses to run as root.
useradd --create-home builder
build=/home/builder/build
install -d -o builder "$build"
cp -- "$src"/packaging/helper/* "$build"/
chown -R builder "$build"
runuser -u builder -- bash -c "cd '$build' && MAKEFLAGS=-j\$(nproc) makepkg --noconfirm"

pkg="$build/$name-$version-x86_64.pkg.tar.zst"
[[ -f "$pkg" ]] || { echo "package missing: $pkg" >&2; exit 1; }
asset="${name//@/-}-$version-x86_64.pkg.tar.zst"
install -Dm644 "$pkg" "$out/$asset"
(cd "$out" && sha256sum "$asset" > SHA256SUMS)

proton=$(jq -r '.protonWebClients.protonVersion' "$lock")
base=$(jq -r '.protonWebClients.baseCommit' "$lock")
patched=$(jq -r '.protonWebClients.helperCommit' "$lock")
repo="${GITHUB_REPOSITORY:-Zeus-Deus/proton-authenticator-omarchy-plugin}"
cat > "$out/notes.md" <<EOF
Secure helper for the Proton Authenticator panel plugin: Proton Authenticator
$proton built from Proton's official source (commit \`$base\`) with the
plugin's one patch (patched tree \`$patched\`).

Built by GitHub Actions from \`packaging/helper/\` at this tag, in a clean Arch
Linux container. The panel's Install/Update button downloads this file and
installs it only if its SHA-256 matches the value pinned in the installed
plugin version (\`helper/proton-helper.lock.json\`).

Verify where it came from:

\`\`\`bash
gh attestation verify $asset --repo $repo
\`\`\`

Source (GPL-3.0): \`packaging/helper/\` at this tag, and Proton's
[WebClients](https://github.com/ProtonMail/WebClients/tree/$base) at \`$base\`.

\`\`\`
$(cat "$out/SHA256SUMS")
\`\`\`
EOF

if [[ -n "${HOST_UID:-}" ]]; then chown -R "$HOST_UID" "$out"; fi
cat "$out/SHA256SUMS"
