import base64
import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "install_official_appimage.py"
spec = importlib.util.spec_from_file_location("installer", MODULE_PATH)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def minisign_fixture(self, data: bytes):
        private = Ed25519PrivateKey.generate()
        public = private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        key_id = bytes.fromhex("0102030405060708")
        pub_line = base64.b64encode(b"Ed" + key_id + public).decode()
        public_text = "untrusted comment: test key\n" + pub_line + "\n"

        digest = hashlib.blake2b(data, digest_size=64).digest()
        signature = private.sign(digest)
        sig_line = base64.b64encode(b"ED" + key_id + signature).decode()
        trusted = "timestamp:1700000000\tfile:App.AppImage"
        global_signature = private.sign(signature + trusted.encode())
        minisig = (
            "untrusted comment: test signature\n"
            + sig_line
            + "\ntrusted comment: "
            + trusted
            + "\n"
            + base64.b64encode(global_signature).decode()
            + "\n"
        )
        outer = base64.b64encode(minisig.encode()).decode()
        return public_text, outer

    def test_verifies_minisign_ed_blake2b_signature(self):
        data = b"official appimage fixture"
        public_text, signature = self.minisign_fixture(data)
        with tempfile.TemporaryDirectory() as td:
            artifact = Path(td) / "app.AppImage"
            artifact.write_bytes(data)
            installer.verify_artifact(artifact, signature, public_text)

    def test_rejects_tampered_artifact(self):
        public_text, signature = self.minisign_fixture(b"original")
        with tempfile.TemporaryDirectory() as td:
            artifact = Path(td) / "app.AppImage"
            artifact.write_bytes(b"tampered")
            with self.assertRaises(installer.VerificationError):
                installer.verify_artifact(artifact, signature, public_text)

    def test_rejects_tampered_trusted_comment(self):
        public_text, signature = self.minisign_fixture(b"original")
        decoded = base64.b64decode(signature).decode().replace("file:App.AppImage", "file:Evil.AppImage")
        tampered = base64.b64encode(decoded.encode()).decode()
        with tempfile.TemporaryDirectory() as td:
            artifact = Path(td) / "app.AppImage"
            artifact.write_bytes(b"original")
            with self.assertRaises(installer.VerificationError):
                installer.verify_artifact(artifact, tampered, public_text)

    def test_selects_only_proton_https_linux_x86_64_asset(self):
        meta = {
            "version": "1.2.3",
            "platforms": {
                "linux-x86_64": {
                    "url": "https://proton.me/download/authenticator/linux/App.AppImage",
                    "signature": "abc",
                }
            },
        }
        asset = installer.select_asset(meta, "x86_64")
        self.assertEqual(asset.version, "1.2.3")
        self.assertEqual(asset.url, meta["platforms"]["linux-x86_64"]["url"])

        meta["platforms"]["linux-x86_64"]["url"] = "https://evil.example/App.AppImage"
        with self.assertRaises(installer.MetadataError):
            installer.select_asset(meta, "x86_64")

    def test_rejects_unsupported_architecture(self):
        with self.assertRaises(installer.MetadataError):
            installer.select_asset({"version": "1.0.0", "platforms": {}}, "aarch64")

    def test_atomic_install_creates_executable_binary_and_version_marker(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "download"
            source.write_bytes(b"app")
            binary, link = installer.install_verified(source, "9.9.9", root / "opt", root / "bin")
            self.assertTrue(binary.exists())
            self.assertTrue(os.access(binary, os.X_OK))
            self.assertTrue(link.is_symlink())
            self.assertEqual(link.resolve(), binary.resolve())
            self.assertEqual((binary.parent / "VERSION").read_text(), "9.9.9\n")


if __name__ == "__main__":
    unittest.main()
