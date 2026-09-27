"""Tests for tools/pve-probe.py against a local mock Proxmox API over real TLS.

Run: python3 -m unittest discover -s tests
Requires the `openssl` CLI to mint a throwaway self-signed certificate.
"""
import http.server
import json
import os
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROBE = ROOT / "tools" / "pve-probe.py"
FIXTURE = json.loads((ROOT / "tests" / "fixtures" / "cluster-resources.json").read_text())
TOKEN = "monitor@pve!desklet=0b8f7c8e-1d2a-4c55-9a1e-3f6b2d8e9c10"


class MockPve(http.server.BaseHTTPRequestHandler):
    payload = FIXTURE

    def do_GET(self):
        if self.path != "/api2/json/cluster/resources":
            self.send_error(404)
            return
        if self.headers.get("Authorization") != f"PVEAPIToken={TOKEN}":
            self.send_error(401)
            return
        body = json.dumps(self.payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class ProbeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        tmp = Path(cls.tmp.name)
        cls.cert, key = tmp / "cert.pem", tmp / "key.pem"
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
             "-keyout", str(key), "-out", str(cls.cert), "-subj", "/CN=localhost",
             "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
            check=True, capture_output=True,
        )
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), MockPve)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cls.cert, key)
        cls.server.socket = context.wrap_socket(cls.server.socket, server_side=True)
        cls.url = f"https://localhost:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def setUp(self):
        MockPve.payload = FIXTURE

    def token_file(self, content, mode=0o600):
        fd, path = tempfile.mkstemp(dir=self.tmp.name)
        with os.fdopen(fd, "w") as f:
            f.write(content)
        os.chmod(path, mode)
        return path

    def probe(self, *args):
        return subprocess.run([sys.executable, str(PROBE), *args], capture_output=True, text=True, timeout=30)

    def test_success_with_pinned_ca(self):
        r = self.probe("--url", self.url, "--token-file", self.token_file(TOKEN + "\n"), "--cafile", str(self.cert))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("Nodes (2)", r.stdout)
        self.assertIn("Guests (4/5 running)", r.stdout)
        self.assertIn("nas-nfs", r.stdout)
        self.assertNotIn("ubuntu-2404-tpl", r.stdout)
        self.assertEqual(r.stdout.count("nas-nfs"), 1, "shared storage deduplicated")
        self.assertEqual(r.stderr, "")

    def test_tls_is_verified_by_default(self):
        r = self.probe("--url", self.url, "--token-file", self.token_file(TOKEN))
        self.assertEqual(r.returncode, 3)
        self.assertIn("CERTIFICATE_VERIFY_FAILED", r.stderr)

    def test_wrong_token_is_auth_error(self):
        wrong = TOKEN[:-1] + "f"
        self.assertNotEqual(wrong, TOKEN)
        r = self.probe("--url", self.url, "--token-file", self.token_file(wrong), "--cafile", str(self.cert))
        self.assertEqual(r.returncode, 2)
        self.assertIn("HTTP 401", r.stderr)

    def test_token_without_acl_is_auth_error(self):
        MockPve.payload = {"data": []}
        r = self.probe("--url", self.url, "--token-file", self.token_file(TOKEN), "--cafile", str(self.cert))
        self.assertEqual(r.returncode, 2)
        self.assertIn("PVEAuditor", r.stderr)

    def test_world_readable_token_warns(self):
        r = self.probe("--url", self.url, "--token-file", self.token_file(TOKEN, 0o644), "--cafile", str(self.cert))
        self.assertEqual(r.returncode, 0)
        self.assertIn("chmod 600", r.stderr)

    def test_secret_only_token_is_config_error(self):
        r = self.probe("--url", self.url, "--token-file", self.token_file("0b8f7c8e-1d2a-4c55-9a1e-3f6b2d8e9c10"))
        self.assertEqual(r.returncode, 1)
        self.assertIn("user@realm!tokenid=secret", r.stderr)

    def test_plain_http_rejected(self):
        r = self.probe("--url", "http://localhost:1", "--token-file", self.token_file(TOKEN))
        self.assertEqual(r.returncode, 1)

    def test_json_output(self):
        r = self.probe("--url", self.url, "--token-file", self.token_file(TOKEN), "--cafile", str(self.cert), "--json")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout), FIXTURE["data"])


if __name__ == "__main__":
    unittest.main()
