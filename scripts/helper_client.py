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
import time
from pathlib import Path

MAX_RESPONSE_BYTES = 1024 * 1024
RECV_TIMEOUT_SECONDS = 2.0
TOTAL_DEADLINE_SECONDS = 5.0
ITEM_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
# `unlock` is absent by design: the helper no longer serves it, and a socket
# release path would let any same-uid process resume publication of live codes.
OPS = {"status", "snapshot", "copy", "lock"}
# Set by `--allow-socket-override`, which only the test suite passes.
ALLOW_SOCKET_OVERRIDE = False
# Every error this client can emit. Anything else that escapes (an unexpected
# exception class, a Python message that happens to quote server bytes) is
# collapsed to `helper client failure` so no free text reaches the panel.
KNOWN_ERRORS = {
    "usage",
    "unsupported operation",
    "invalid item id",
    "item id is only valid for copy",
    "helper socket override rejected",
    "helper runtime directory is unavailable",
    "helper runtime path is not a directory",
    "helper runtime directory has a foreign owner",
    "helper runtime directory is not owner-private",
    "helper socket is unavailable",
    "helper path is not a socket",
    "helper socket has a foreign owner",
    "helper socket is not owner-private",
    "helper response timeout",
    "helper response exceeds size limit",
    "invalid helper response",
}


def socket_path() -> Path:
    # The override exists for the test suite's mock servers. In production the
    # shell's environment is not a trust boundary, so honouring it would let
    # anything that can influence that environment redirect every request. It is
    # accepted only when the caller also opts in with an explicit flag that the
    # plugin never passes.
    override = os.environ.get("PROTON_AUTH_HELPER_SOCKET", "").strip()
    if override:
        if not ALLOW_SOCKET_OVERRIDE:
            raise RuntimeError("helper socket override rejected")
        return Path(override)
    runtime = os.environ.get("XDG_RUNTIME_DIR", "").strip()
    if not runtime:
        raise RuntimeError("helper runtime directory is unavailable")
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
        # settimeout() bounds each individual recv, so a server dripping bytes
        # resets it forever. Hold a wall-clock deadline across the whole
        # exchange as well.
        deadline = time.monotonic() + TOTAL_DEADLINE_SECONDS
        client.settimeout(RECV_TIMEOUT_SECONDS)
        client.connect(str(path))
        client.sendall(encoded)
        chunks: list[bytes] = []
        size = 0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("helper response timeout")
            client.settimeout(min(RECV_TIMEOUT_SECONDS, remaining))
            try:
                chunk = client.recv(65536)
            except socket.timeout:
                raise RuntimeError("helper response timeout") from None
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_RESPONSE_BYTES:
                raise RuntimeError("helper response exceeds size limit")
            chunks.append(chunk)
            if b"\n" in chunk:
                break

    raw = b"".join(chunks).split(b"\n", 1)[0]
    try:
        response = json.loads(raw)
    except ValueError:
        raise RuntimeError("invalid helper response") from None
    if not isinstance(response, dict) or response.get("v") != 1 or response.get("id") != request_id:
        raise RuntimeError("invalid helper response")
    return response


def error_identifier(error: BaseException) -> str:
    message = str(error)
    return message if message in KNOWN_ERRORS else "helper client failure"


def main(argv: list[str]) -> int:
    global ALLOW_SOCKET_OVERRIDE
    args = list(argv[1:])
    if args and args[0] == "--allow-socket-override":
        ALLOW_SOCKET_OVERRIDE = True
        args = args[1:]
    if len(args) not in {1, 2}:
        print('{"v":1,"ok":false,"state":"unavailable","error":"usage"}')
        return 2
    try:
        response = request(args[0], args[1] if len(args) == 2 else "")
        print(json.dumps(response, separators=(",", ":"), ensure_ascii=False))
        return 0 if response.get("ok") is True else 1
    except Exception as error:
        # Fixed identifiers only: never server payloads, socket text, paths, or
        # raw Python exception messages.
        print(json.dumps({"v": 1, "ok": False, "state": "unavailable", "error": error_identifier(error)}, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
