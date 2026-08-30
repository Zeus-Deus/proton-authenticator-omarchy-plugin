#!/usr/bin/env python3
"""Install Proton's official, signed Authenticator AppImage user-locally.

This is deliberately NOT an auto-updater. It runs only after the user starts it
in a terminal, shows the exact version and target paths, and defaults to No.
The Omarchy plugin never executes this script silently.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import NamedTuple

try:
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
except ImportError as error:  # pragma: no cover - exercised by real setup only
    raise SystemExit(
        "python-cryptography is required to verify Proton's updater signature. "
        "Install it with your package manager, then retry."
    ) from error


LATEST_URL = "https://proton.me/download/authenticator/linux/latest.json"
# Official Tauri updater key from applications/authenticator/src-tauri/tauri.conf.json.
PROTON_PUBLIC_KEY = """untrusted comment: minisign public key: 359C03345C454587
RWSHRUVcNAOcNTkI+kfiGWapLgoMAdYMVT+RmN2DQ4YoD4e8nFOwYhcA
"""
MAX_METADATA_BYTES = 1024 * 1024
MAX_ARTIFACT_BYTES = 300 * 1024 * 1024
VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$")


class InstallerError(RuntimeError):
    pass


class MetadataError(InstallerError):
    pass


class VerificationError(InstallerError):
    pass


class Asset(NamedTuple):
    version: str
    url: str
    signature: str


def _decode_b64(value: str, label: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as error:
        raise VerificationError(f"Invalid base64 in {label}") from error


def _parse_public_key(text: str) -> tuple[bytes, bytes]:
    lines = [line.strip() for line in str(text).splitlines() if line.strip()]
    if len(lines) != 2 or not lines[0].startswith("untrusted comment:"):
        raise VerificationError("Malformed minisign public key")
    packet = _decode_b64(lines[1], "public key")
    if len(packet) != 42 or packet[:2] != b"Ed":
        raise VerificationError("Unsupported minisign public key")
    return packet[2:10], packet[10:]


def _parse_signature(outer_b64: str) -> tuple[bytes, bytes, str, bytes]:
    try:
        text = _decode_b64(outer_b64, "updater signature").decode("utf-8")
    except UnicodeDecodeError as error:
        raise VerificationError("Updater signature is not UTF-8") from error
    lines = text.splitlines()
    if (
        len(lines) != 4
        or not lines[0].startswith("untrusted comment:")
        or not lines[2].startswith("trusted comment: ")
    ):
        raise VerificationError("Malformed minisign signature")

    packet = _decode_b64(lines[1], "artifact signature")
    global_signature = _decode_b64(lines[3], "trusted-comment signature")
    if len(packet) != 74 or packet[:2] != b"ED" or len(global_signature) != 64:
        raise VerificationError("Unsupported minisign signature format")
    trusted_comment = lines[2][len("trusted comment: ") :]
    return packet[2:10], packet[10:], trusted_comment, global_signature


def verify_artifact(path: Path, signature_b64: str, public_key_text: str = PROTON_PUBLIC_KEY) -> None:
    key_id, public_key = _parse_public_key(public_key_text)
    signature_key_id, signature, trusted_comment, global_signature = _parse_signature(signature_b64)
    if key_id != signature_key_id:
        raise VerificationError("Updater signature key id does not match Proton's pinned key")

    digest = hashlib.blake2b(digest_size=64)
    size = 0
    with Path(path).open("rb") as artifact:
        while chunk := artifact.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_ARTIFACT_BYTES:
                raise VerificationError("AppImage exceeds the installer size limit")
            digest.update(chunk)

    verifier = Ed25519PublicKey.from_public_bytes(public_key)
    try:
        # Minisign's ED variant: Ed25519(BLAKE2b-512(file)).
        verifier.verify(signature, digest.digest())
        # Global signature authenticates the trusted comment too.
        verifier.verify(global_signature, signature + trusted_comment.encode("utf-8"))
    except InvalidSignature as error:
        raise VerificationError("Proton AppImage signature verification failed") from error


def select_asset(metadata: object, machine: str | None = None) -> Asset:
    if not isinstance(metadata, dict):
        raise MetadataError("Updater metadata is not an object")
    version = metadata.get("version")
    if not isinstance(version, str) or not VERSION_RE.fullmatch(version):
        raise MetadataError("Updater metadata has an invalid version")

    arch = machine or platform.machine()
    if arch not in {"x86_64", "amd64"}:
        raise MetadataError(f"Unsupported architecture: {arch}")
    platforms = metadata.get("platforms")
    row = platforms.get("linux-x86_64") if isinstance(platforms, dict) else None
    if not isinstance(row, dict):
        raise MetadataError("No signed linux-x86_64 AppImage in updater metadata")
    url = row.get("url")
    signature = row.get("signature")
    if not isinstance(url, str) or not isinstance(signature, str) or not signature:
        raise MetadataError("Updater metadata is missing URL or signature")

    parsed = urllib.parse.urlparse(url)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "proton.me"
        or not parsed.path.startswith("/download/authenticator/linux/")
        or not parsed.path.endswith(".AppImage")
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise MetadataError("Updater URL is outside Proton's official HTTPS download path")
    return Asset(version, url, signature)


def _fetch_json(url: str) -> object:
    request = urllib.request.Request(url, headers={"User-Agent": "Omarchy-Proton-Authenticator-Installer/1"})
    with urllib.request.urlopen(request, timeout=30) as response:
        body = response.read(MAX_METADATA_BYTES + 1)
    if len(body) > MAX_METADATA_BYTES:
        raise MetadataError("Updater metadata exceeds the size limit")
    try:
        return json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise MetadataError("Updater metadata is not valid JSON") from error


def _download(url: str, destination: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "Omarchy-Proton-Authenticator-Installer/1"})
    total = 0
    with urllib.request.urlopen(request, timeout=60) as response, destination.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            if total > MAX_ARTIFACT_BYTES:
                raise MetadataError("AppImage exceeds the installer size limit")
            output.write(chunk)
    if total == 0:
        raise MetadataError("Downloaded AppImage is empty")


def _atomic_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def install_verified(source: Path, version: str, opt_root: Path, bin_dir: Path) -> tuple[Path, Path]:
    app_dir = Path(opt_root) / "proton-authenticator"
    app_dir.mkdir(parents=True, exist_ok=True)
    bin_dir = Path(bin_dir)
    bin_dir.mkdir(parents=True, exist_ok=True)

    destination = app_dir / "ProtonAuthenticator.AppImage"
    fd, temporary = tempfile.mkstemp(prefix=".ProtonAuthenticator.", dir=app_dir)
    os.close(fd)
    try:
        shutil.copyfile(source, temporary)
        os.chmod(temporary, 0o755)
        os.replace(temporary, destination)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass

    _atomic_text(app_dir / "VERSION", version + "\n")
    link = bin_dir / "proton-authenticator"
    temp_link = bin_dir / f".proton-authenticator.{os.getpid()}"
    try:
        try:
            temp_link.unlink()
        except FileNotFoundError:
            pass
        temp_link.symlink_to(destination)
        os.replace(temp_link, link)
    finally:
        try:
            temp_link.unlink()
        except FileNotFoundError:
            pass
    return destination, link


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    parser.add_argument("--metadata-file", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--artifact-file", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--opt-root", type=Path, default=Path.home() / ".local" / "opt", help=argparse.SUPPRESS)
    parser.add_argument("--bin-dir", type=Path, default=Path.home() / ".local" / "bin", help=argparse.SUPPRESS)
    return parser.parse_args()


def main() -> int:
    args = _arguments()
    try:
        metadata = json.loads(args.metadata_file.read_text()) if args.metadata_file else _fetch_json(LATEST_URL)
        asset = select_asset(metadata)
        print(f"Official Proton Authenticator AppImage: {asset.version}")
        print(f"Source: {asset.url}")
        print(f"Install: {args.opt_root / 'proton-authenticator' / 'ProtonAuthenticator.AppImage'}")
        print("The artifact will be verified against Proton's pinned Tauri updater key.")
        if not args.yes and input("Continue? [y/N] ").strip().lower() not in {"y", "yes"}:
            print("Cancelled.")
            return 2

        with tempfile.TemporaryDirectory(prefix="proton-authenticator-") as temp_dir:
            artifact = Path(temp_dir) / "ProtonAuthenticator.AppImage"
            if args.artifact_file:
                shutil.copyfile(args.artifact_file, artifact)
            else:
                print("Downloading official AppImage…")
                _download(asset.url, artifact)
            print("Verifying Proton signature…")
            verify_artifact(artifact, asset.signature)
            destination, link = install_verified(artifact, asset.version, args.opt_root, args.bin_dir)
        print(f"Installed and verified: {destination}")
        print(f"Launcher: {link}")
        return 0
    except (InstallerError, OSError, urllib.error.URLError, json.JSONDecodeError) as error:
        print(f"Install failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
