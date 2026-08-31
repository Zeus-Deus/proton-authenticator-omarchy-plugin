#!/usr/bin/python3
"""Bounded client for the local Proton Authenticator helper socket.

Codes are returned on stdout only because the user explicitly requires them in
the Quattro popup. Requests carry only fixed operations and opaque item IDs;
passwords, tokens, TOTP secrets, and generated codes never enter argv.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import socket
import stat
import sys
from pathlib import Path

MAX_RESPONSE_BYTES = 1024 * 1024
ITEM_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
OPS = {"status", "snapshot", "copy", "lock", "unlock"}


def socket_path() -> Path:
    override = os.environ.get("PROTON_AUTH_HELPER_SOCKET", "").strip()
    if override:
        return Path(override)
    runtime = os.environ.get("XDG_RUNTIME_DIR", "").strip()
    if not runtime:
        raise RuntimeError("XDG_RUNTIME_DIR is not set")
    return Path(runtime) / "proton-authenticator-omarchy" / "helper.sock"


def verify_socket(path: Path) -> None:
    """Authenticate the server before sending a request.

    The helper's 0700/0600 modes and SO_PEERCRED check protect the helper from
    clients; nothing in them protects this client from a hijacked socket path.
    Without these checks a symlinked runtime directory serves forged rows and a
    forged high generation that permanently wedges the panel's staleness floor.
    Errors are fixed identifiers and never disclose the inspected path.
    """
    uid = os.geteuid()
    try:
        parent = os.lstat(path.parent)
    except OSError:
        raise RuntimeError("helper runtime directory is unavailable") from None
    if not stat.S_ISDIR(parent.st_mode):
        raise RuntimeError("helper runtime path is not a directory")
    if parent.st_uid != uid:
        raise RuntimeError("helper runtime directory has a foreign owner")
    if stat.S_IMODE(parent.st_mode) != 0o700:
        raise RuntimeError("helper runtime directory is not owner-private")

    try:
        info = os.lstat(path)
    except OSError:
        raise RuntimeError("helper socket is unavailable") from None
    if not stat.S_ISSOCK(info.st_mode):
        raise RuntimeError("helper path is not a socket")
    if info.st_uid != uid:
        raise RuntimeError("helper socket has a foreign owner")
    if stat.S_IMODE(info.st_mode) != 0o600:
        raise RuntimeError("helper socket is not owner-private")


def request(op: str, item_id: str = "") -> dict:
    if op not in OPS:
        raise ValueError("unsupported operation")
    if op == "copy" and not ITEM_ID_RE.fullmatch(item_id):
        raise ValueError("invalid item id")
    if op != "copy" and item_id:
        raise ValueError("item id is only valid for copy")

    request_id = secrets.token_hex(8)
    payload: dict[str, object] = {"v": 1, "id": request_id, "op": op}
    if item_id:
        payload["itemId"] = item_id
    encoded = json.dumps(payload, separators=(",", ":")).encode() + b"\n"

    path = socket_path()
    verify_socket(path)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(2.0)
        client.connect(str(path))
        client.sendall(encoded)
        chunks: list[bytes] = []
        size = 0
        while True:
            chunk = client.recv(65536)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_RESPONSE_BYTES:
                raise RuntimeError("helper response exceeds size limit")
            chunks.append(chunk)
            if b"\n" in chunk:
                break

    raw = b"".join(chunks).split(b"\n", 1)[0]
    response = json.loads(raw)
    if not isinstance(response, dict) or response.get("v") != 1 or response.get("id") != request_id:
        raise RuntimeError("invalid helper response")
    return response


def main(argv: list[str]) -> int:
    if len(argv) not in {2, 3}:
        print('{"v":1,"ok":false,"error":"usage"}')
        return 2
    try:
        response = request(argv[1], argv[2] if len(argv) == 3 else "")
        print(json.dumps(response, separators=(",", ":"), ensure_ascii=False))
        return 0 if response.get("ok") is True else 1
    except Exception as error:
        # Never include server payloads or socket response text in errors.
        print(json.dumps({"v": 1, "ok": False, "state": "unavailable", "error": str(error)[:160]}, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
