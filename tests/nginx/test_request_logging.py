"""Run with python3 tests/nginx/test_request_logging.py; requires Docker and openssl."""

import http.client
import os
from pathlib import Path
import re
import ssl
import subprocess
import tempfile
import time
import unittest
import uuid


ROOT = Path(__file__).resolve().parents[2]
IMAGE = os.environ.get("NGINX_TEST_IMAGE", "nginx:1.30-alpine")
CONFIGS = (
    "nginx/nginx.conf",
    "nginx/nginx.conf.example",
    "frontend/nginx.conf",
    "frontend/nginx.dev.conf",
)
TOKEN = "NGINX_TEST_CAPABILITY_73cb40b17c"
FORWARDED_IP = "198.51.100.9"


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT, timeout=120).strip()


class RequestLoggingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="picpeak-nginx-test-")
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.directory = Path(cls.temporary.name)
        cls.network = "picpeak-nginx-test-" + uuid.uuid4().hex[:12]
        run("docker", "network", "create", cls.network)
        cls.addClassCleanup(run, "docker", "network", "rm", cls.network)
        certs = cls.directory / "certs"
        certs.mkdir()
        run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(certs / "privkey.pem"), "-out", str(certs / "fullchain.pem"),
            "-days", "1", "-subj", "/CN=your-domain.com",
            "-addext", "subjectAltName=IP:127.0.0.1,DNS:your-domain.com")

    def configuration(self, filename, critical, unsafe_control):
        source = (ROOT / filename).read_text()
        if unsafe_control:
            # Positive control: the same request must expose the fixture token
            # when native request errors are enabled, even at crit severity.
            source, count = re.subn(r"error_log\s+/dev/null\s*;",
                                   "error_log /var/log/nginx/error.log crit;", source)
            self.assertEqual(count, 1)

        # A source address absent from this disposable network makes bind()
        # fail at CRIT deterministically, without exhausting runner resources.
        bind = "proxy_bind 192.0.2.1;" if critical else ""
        if filename.startswith("frontend/"):
            (self.directory / "frontend.conf").write_text(source)
            source = """worker_processes 1;
error_log /var/log/nginx/error.log notice;
events { worker_connections 128; }
http {
    include /etc/nginx/mime.types;
    %s
    include /fixtures/frontend.conf;
}
""" % bind
        else:
            if "worker_processes auto;" in source:
                source = source.replace("worker_processes auto;", "worker_processes 1;")
            else:
                source = "worker_processes 1;\n" + source
            source = source.replace("http {", "http {\n    " + bind, 1)

        (self.directory / "nginx.conf").write_text(source)
        # The standalone main configuration intentionally delegates vhosts.
        (self.directory / "site.conf").write_text("""server {
    listen 80;
    server_name localhost;
    location /api { proxy_pass http://backend:3000; }
}
""")

    def request(self, port, tls, uri):
        # Trust only our fixture certificate while retaining hostname checks.
        context = ssl.create_default_context(cafile=str(self.directory / "certs" / "fullchain.pem"))
        for attempt in range(30):
            connection = (http.client.HTTPSConnection("127.0.0.1", port, context=context, timeout=3)
                          if tls else http.client.HTTPConnection("127.0.0.1", port, timeout=3))
            try:
                connection.request("GET", uri, headers={
                    "Host": "your-domain.com" if tls else "localhost",
                    "X-Forwarded-For": FORWARDED_IP,
                    "Referer": "https://example.invalid/gallery?token=" + TOKEN,
                })
                response = connection.getresponse()
                response.read()
                return response.status
            except (ConnectionError, OSError):
                if attempt == 29:
                    raise
                time.sleep(0.1)
            finally:
                connection.close()

    def exercise(self, filename, critical=False, unsafe_control=False):
        self.configuration(filename, critical, unsafe_control)
        name = "picpeak-nginx-test-" + uuid.uuid4().hex[:12]
        try:
            # DNS aliases cover both static and variable-based proxy_pass in
            # the supplied configs. Nothing listens on the fixture's port 3000.
            run("docker", "run", "-d", "--name", name, "--network", self.network,
                "--network-alias", "backend", "--network-alias", "frontend",
                "--sysctl", "net.ipv4.ip_nonlocal_bind=0",
                "-p", "127.0.0.1::80", "-p", "127.0.0.1::443",
                "-v", f"{self.directory}:/fixtures:ro",
                "-v", f"{self.directory}/site.conf:/etc/nginx/sites-enabled/test.conf:ro",
                "-v", f"{self.directory}/certs:/etc/letsencrypt/live/your-domain.com:ro",
                IMAGE, "nginx", "-c", "/fixtures/nginx.conf", "-g", "daemon off;")
            syntax = run("docker", "exec", name, "nginx", "-t", "-c", "/fixtures/nginx.conf")
            self.assertIn("test is successful", syntax)
            tls = filename.endswith(".example")
            port = int(run("docker", "port", name, "443/tcp" if tls else "80/tcp").split(":")[-1])
            paths = (
                f"/api/customer/auth/password-reset/{TOKEN}?token={TOKEN}",
                f"/api/secure-images/gallery/secure/1/{TOKEN}",
                f"/api/public/newsletter/unsubscribe/{TOKEN}",
            )
            for uri in paths:
                self.assertIn(self.request(port, tls, uri), (500, 502))
            # Wait for the final access entry to reach the container log pipe.
            for _ in range(30):
                logs = run("docker", "logs", name)
                if '"GET /api/public"' in logs:
                    break
                time.sleep(0.05)
            for surface in ("customer", "secure-images", "public"):
                self.assertRegex(logs, rf'"GET /api/{surface}" 50[02] \d+ \d+\.\d+')
            self.assertIn(FORWARDED_IP, logs)
            if unsafe_control:
                self.assertIn("[crit]", logs)
                self.assertIn("bind(192.0.2.1) failed", logs)
                self.assertIn(TOKEN, logs)
            else:
                self.assertNotIn(TOKEN, logs)
        finally:
            run("docker", "rm", "-f", name)

    def test_tokens_stay_out_of_logs_for_ordinary_and_critical_upstream_errors(self):
        for filename in CONFIGS:
            for scenario in ("ordinary", "critical", "unsafe-control"):
                with self.subTest(config=filename, scenario=scenario, image=IMAGE):
                    self.exercise(filename, critical=scenario != "ordinary",
                                  unsafe_control=scenario == "unsafe-control")


class HostForwardingTest(unittest.TestCase):
    # The backend's CSRF fallback compares Origin's host:port with Host.
    # $host drops the port, so on http://nas:3000 every mutation was refused;
    # every proxied Host must carry the client's own Host header, port kept.
    def test_every_proxied_host_keeps_the_port(self):
        for filename in CONFIGS:
            with self.subTest(config=filename):
                values = re.findall(r"proxy_set_header\s+Host\s+(\S+?);",
                                    (ROOT / filename).read_text())
                for value in values:
                    self.assertEqual(value, "$http_host")


class SpaRobotsHeaderTest(unittest.TestCase):
    # Only the landing page at `/` (served by the backend) is ever indexable.
    # robots.txt leaves the app pages crawlable so that a crawler can read
    # "X-Robots-Tag: noindex" on them; a Disallow kept bare login and share
    # URLs in search results.
    def test_every_app_page_answers_noindex(self):
        with tempfile.TemporaryDirectory(prefix="picpeak-nginx-test-") as directory:
            directory = Path(directory)
            (directory / "frontend.conf").write_text((ROOT / "frontend/nginx.conf").read_text())
            (directory / "nginx.conf").write_text("""worker_processes 1;
events { worker_connections 128; }
http {
    include /etc/nginx/mime.types;
    include /fixtures/frontend.conf;
}
""")
            name = "picpeak-nginx-test-" + uuid.uuid4().hex[:12]
            try:
                # The image's own welcome page stands in for the SPA shell.
                run("docker", "run", "-d", "--name", name, "--add-host", "backend:127.0.0.1",
                    "-p", "127.0.0.1::80", "-v", f"{directory}:/fixtures:ro",
                    IMAGE, "nginx", "-c", "/fixtures/nginx.conf", "-g", "daemon off;")
                port = int(run("docker", "port", name, "80/tcp").split(":")[-1])
                pages = ("/admin/login", "/admin", "/customer/login", "/gallery/some-slug/token",
                         "/transfer/abc123", "/setup", "/some-short-link", "/index.html")
                for uri in pages:
                    with self.subTest(uri=uri):
                        for attempt in range(30):
                            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
                            try:
                                connection.request("GET", uri, headers={"Host": "localhost"})
                                response = connection.getresponse()
                                response.read()
                                break
                            except (ConnectionError, OSError):
                                if attempt == 29:
                                    raise
                                time.sleep(0.1)
                            finally:
                                connection.close()
                        self.assertEqual(response.status, 200)
                        self.assertEqual(response.getheader("X-Robots-Tag"), "noindex")
                        # The location's own header list must not drop these.
                        self.assertEqual(response.getheader("X-Content-Type-Options"), "nosniff")
            finally:
                run("docker", "rm", "-f", name)


class UploadedSvgCspTest(unittest.TestCase):
    # The server-level proxy_hide_header strips the backend's strict CSP from
    # uploaded SVGs, so nginx itself must send the strict one for them, while
    # every other response, the bundled SVG assets included, keeps the site CSP.
    STRICT = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox"
    BACKEND = """worker_processes 1;
events { worker_connections 32; }
http {
    server {
        listen 3000;
        location ~* \\.svg$ {
            default_type image/svg+xml;
            add_header Content-Security-Policy "default-src *";
            return 200 '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
        }
        location = /favicon.ico {
            default_type "image/svg+xml; charset=utf-8";
            return 200 '<svg xmlns="http://www.w3.org/2000/svg"/>';
        }
        location / {
            default_type image/png;
            return 200 'png';
        }
    }
}
"""

    def get(self, port, uri):
        for attempt in range(30):
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
            try:
                connection.request("GET", uri, headers={"Host": "localhost"})
                response = connection.getresponse()
                response.read()
                return response
            except (ConnectionError, OSError):
                if attempt == 29:
                    raise
                time.sleep(0.1)
            finally:
                connection.close()

    def test_uploaded_svgs_get_the_strict_csp(self):
        source = (ROOT / "frontend/nginx.conf").read_text()
        site = re.search(r'add_header Content-Security-Policy "([^"]+)" always;', source).group(1)
        network = "picpeak-nginx-test-" + uuid.uuid4().hex[:12]
        with tempfile.TemporaryDirectory(prefix="picpeak-nginx-test-") as directory:
            directory = Path(directory)
            (directory / "frontend.conf").write_text(source)
            (directory / "nginx.conf").write_text("""worker_processes 1;
events { worker_connections 128; }
http {
    include /etc/nginx/mime.types;
    include /fixtures/frontend.conf;
}
""")
            (directory / "backend.conf").write_text(self.BACKEND)
            backend = "picpeak-nginx-test-" + uuid.uuid4().hex[:12]
            frontend = "picpeak-nginx-test-" + uuid.uuid4().hex[:12]
            run("docker", "network", "create", network)
            try:
                run("docker", "run", "-d", "--name", backend, "--network", network,
                    "--network-alias", "backend", "-v", f"{directory}:/fixtures:ro",
                    IMAGE, "nginx", "-c", "/fixtures/backend.conf", "-g", "daemon off;")
                run("docker", "run", "-d", "--name", frontend, "--network", network,
                    "-p", "127.0.0.1::80", "-v", f"{directory}:/fixtures:ro",
                    IMAGE, "nginx", "-c", "/fixtures/nginx.conf", "-g", "daemon off;")
                port = int(run("docker", "port", frontend, "80/tcp").split(":")[-1])
                for uri in ("/uploads/logos/logo.svg", "/uploads/logos/LOGO.SVG", "/favicon.ico"):
                    with self.subTest(uri=uri):
                        response = self.get(port, uri)
                        self.assertEqual(response.status, 200)
                        self.assertEqual(response.getheader("Content-Security-Policy"), self.STRICT)
                        self.assertEqual(len(response.headers.get_all("Content-Security-Policy")), 1)
                        self.assertEqual(response.getheader("X-Content-Type-Options"), "nosniff")
                # A proxied non-SVG and nginx's own files keep the site CSP.
                for uri, status in (("/uploads/logos/logo.png", 200), ("/assets/logo.svg", 404),
                                    ("/admin/login", 200)):
                    with self.subTest(uri=uri):
                        response = self.get(port, uri)
                        self.assertEqual(response.status, status)
                        self.assertEqual(response.getheader("Content-Security-Policy"), site)
            finally:
                run("docker", "rm", "-f", backend, frontend)
                run("docker", "network", "rm", network)


if __name__ == "__main__":
    unittest.main(verbosity=2)
