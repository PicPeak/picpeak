"""Run with python3 tests/nginx/test_gallery_embed.py; requires Docker.

Gallery embed (issue 1112): frontend/nginx.conf lets another site frame
/gallery/<slug>/embed/<token> only when the backend's policy lookup answers 204
with a frame-ancestors list. A refused lookup, an empty list or a backend
that is down keeps the page unframeable, and every other gallery page keeps
X-Frame-Options: SAMEORIGIN.
"""

import http.client
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
import uuid


ROOT = Path(__file__).resolve().parents[2]
IMAGE = os.environ.get("NGINX_TEST_IMAGE", "nginx:1.30-alpine")
STUB_IMAGE = os.environ.get("NGINX_TEST_STUB_IMAGE", "python:3.12-alpine")

# The stand-in backend: answers the policy lookup by the page URI nginx forwards.
STUB = r'''
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        uri = self.headers.get("X-Original-URI", "")
        if self.path != "/api/public/settings/embed-frame-policy":
            self.send_response(404); self.end_headers(); return
        if "/embed/allowed" in uri:
            self.send_response(204)
            self.send_header("X-PicPeak-Embed-Ancestors", "https://example.com https://*.example.org")
            self.end_headers(); return
        if "/embed/nolist" in uri:
            self.send_response(204); self.end_headers(); return
        if "/embed/broken" in uri:
            self.send_response(500); self.end_headers(); return
        self.send_response(404); self.end_headers()

    def log_message(self, *args):
        pass

HTTPServer(("0.0.0.0", 3000), Handler).serve_forever()
'''


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT, timeout=120).strip()


class GalleryEmbedFramingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="picpeak-nginx-embed-")
        cls.addClassCleanup(cls.temporary.cleanup)
        directory = Path(cls.temporary.name)
        (directory / "frontend.conf").write_text((ROOT / "frontend/nginx.conf").read_text())
        (directory / "nginx.conf").write_text("""worker_processes 1;
error_log /var/log/nginx/error.log notice;
events { worker_connections 128; }
http {
    include /etc/nginx/mime.types;
    include /fixtures/frontend.conf;
}
""")
        (directory / "stub.py").write_text(STUB)

        # NGINX_TEST_NETWORK reuses an existing, empty network where the
        # daemon has no address pool left for a new one (local machines).
        cls.network = os.environ.get("NGINX_TEST_NETWORK")
        if not cls.network:
            cls.network = "picpeak-nginx-embed-" + uuid.uuid4().hex[:12]
            run("docker", "network", "create", cls.network)
            cls.addClassCleanup(run, "docker", "network", "rm", cls.network)

        stub = "picpeak-embed-stub-" + uuid.uuid4().hex[:12]
        run("docker", "run", "-d", "--name", stub, "--network", cls.network, "--network-alias", "backend",
            "-v", f"{directory}:/fixtures:ro", STUB_IMAGE, "python3", "/fixtures/stub.py")
        cls.addClassCleanup(run, "docker", "rm", "-f", stub)

        cls.nginx = "picpeak-embed-nginx-" + uuid.uuid4().hex[:12]
        run("docker", "run", "-d", "--name", cls.nginx, "--network", cls.network,
            "-p", "127.0.0.1::80", "-v", f"{directory}:/fixtures:ro",
            IMAGE, "nginx", "-c", "/fixtures/nginx.conf", "-g", "daemon off;")
        cls.addClassCleanup(run, "docker", "rm", "-f", cls.nginx)
        syntax = run("docker", "exec", cls.nginx, "nginx", "-t", "-c", "/fixtures/nginx.conf")
        assert "test is successful" in syntax, syntax
        cls.port = int(run("docker", "port", cls.nginx, "80/tcp").split(":")[-1])

    def get(self, uri):
        for attempt in range(60):
            connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
            try:
                connection.request("GET", uri, headers={"Host": "localhost"})
                response = connection.getresponse()
                response.read()
                # The stub may still be starting: nginx answers 500 for the
                # policy lookup then, which looks like a refusal. Retry until
                # the stub is up for the allowed case.
                return response.status, {k.lower(): v for k, v in response.getheaders()}
            except (ConnectionError, OSError):
                if attempt == 59:
                    raise
                time.sleep(0.2)
            finally:
                connection.close()
        raise AssertionError("unreachable: the last attempt re-raises")

    def wait_for_stub(self):
        for _ in range(60):
            status, headers = self.get("/gallery/demo/embed/allowed")
            if "frame-ancestors https://example.com" in headers.get("content-security-policy", ""):
                return status, headers
            time.sleep(0.2)
        raise self.failureException("embed policy never answered")

    def assert_not_frameable(self, headers):
        csp = headers.get("content-security-policy", "")
        self.assertTrue(
            headers.get("x-frame-options") == "SAMEORIGIN" or "frame-ancestors 'none'" in csp,
            f"page is frameable: {headers}")

    def test_eligible_embed_names_the_allowed_sites_and_drops_sameorigin(self):
        status, headers = self.wait_for_stub()
        self.assertEqual(status, 200)
        self.assertNotIn("x-frame-options", headers)
        self.assertIn("frame-ancestors https://example.com https://*.example.org",
                      headers["content-security-policy"])
        self.assertIn("default-src 'self'", headers["content-security-policy"])

    def test_refused_lookup_serves_the_page_unframeable(self):
        self.wait_for_stub()
        status, headers = self.get("/gallery/demo/embed/unknown")
        self.assertEqual(status, 200)
        self.assert_not_frameable(headers)

    def test_backend_error_serves_the_page_unframeable(self):
        self.wait_for_stub()
        status, headers = self.get("/gallery/demo/embed/broken")
        self.assertEqual(status, 200)
        self.assert_not_frameable(headers)

    def test_policy_without_a_list_is_framed_by_nobody(self):
        self.wait_for_stub()
        status, headers = self.get("/gallery/demo/embed/nolist")
        self.assertEqual(status, 200)
        self.assert_not_frameable(headers)

    def test_other_gallery_pages_keep_sameorigin(self):
        self.wait_for_stub()
        for uri in ("/gallery/demo", "/gallery/demo/sometoken", "/gallery/demo/show/abc", "/admin/events"):
            status, headers = self.get(uri)
            self.assertEqual(headers.get("x-frame-options"), "SAMEORIGIN", uri)
            self.assertNotIn("frame-ancestors https:", headers.get("content-security-policy", ""), uri)

    def test_policy_endpoint_is_internal(self):
        status, _ = self.get("/_gallery_embed_policy")
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main()
