"""Loopback-only, opt-in HTTP fault proxy for deterministic local dogfood tests.

Never install this proxy in a classroom deployment. /__fault/* is an unauthenticated
local test control surface. It stores timings/statuses only, never headers or bodies.
"""

import argparse
import http.client
import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


class Gate:
    def __init__(self):
        self.lock = threading.Lock()
        self.release = threading.Event()
        self.spec = None
        self.state = {"phase": "idle"}

    def arm(self, spec):
        with self.lock:
            if self.state["phase"] in {"armed", "before", "after"}:
                raise ValueError("previous gate is still active")
            if spec.get("phase") not in {"before", "after"} or spec.get("action", "pass") not in {"pass", "drop"}:
                raise ValueError("invalid gate")
            self.spec = spec
            self.release.clear()
            self.state = {"phase": "armed"}

    def take(self, method, path):
        with self.lock:
            if (
                self.spec
                and method == self.spec.get("method", "PUT")
                and path == self.spec.get("path", "/api/classroom/session")
            ):
                spec, self.spec = self.spec, None
                return spec
        return None

    def pause(self, phase, status=None):
        with self.lock:
            self.state = {"phase": phase, "upstream_status": status}
        return self.release.wait(45)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--upstream", required=True)
    args = parser.parse_args()
    upstream = urlsplit(args.upstream)
    if upstream.scheme != "http" or upstream.hostname not in {"localhost", "127.0.0.1"}:
        parser.error("upstream must be loopback HTTP")
    gate = Gate()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def reply(self, status, body):
            encoded = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def handle_request(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            if self.path.startswith("/__fault/"):
                if self.path == "/__fault/status":
                    with gate.lock:
                        self.reply(200, gate.state)
                elif self.path == "/__fault/release" and self.command == "POST":
                    gate.release.set()
                    self.reply(200, {"released": True})
                elif self.path == "/__fault/arm" and self.command == "POST":
                    try:
                        gate.arm(json.loads(body))
                    except ValueError as error:
                        self.reply(409, {"error": str(error)})
                    else:
                        self.reply(200, {"armed": True})
                else:
                    self.reply(404, {})
                return
            spec = gate.take(self.command, self.path)
            connection = http.client.HTTPConnection(upstream.hostname, upstream.port, timeout=120)
            try:
                if spec and spec["phase"] == "before" and not gate.pause("before"):
                    raise TimeoutError("test did not release gate")
                headers = {k: v for k, v in self.headers.items() if k.lower() not in {"host", "connection"}}
                connection.request(self.command, self.path, body, headers)
                response = connection.getresponse()
                payload = response.read()
                if spec and spec["phase"] == "after" and not gate.pause("after", response.status):
                    raise TimeoutError("test did not release gate")
                if spec and spec.get("action") == "drop":
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    return
                self.send_response(response.status)
                for key, value in response.getheaders():
                    if key.lower() not in {"connection", "transfer-encoding", "content-length"}:
                        self.send_header(key, value)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except (OSError, http.client.HTTPException):
                try:
                    self.reply(502, {"detail": "test proxy upstream unavailable"})
                except OSError:
                    pass
            finally:
                connection.close()
                if spec:
                    with gate.lock:
                        gate.state = {**gate.state, "phase": "done"}

        do_GET = handle_request
        do_POST = handle_request
        do_PUT = handle_request
        do_OPTIONS = handle_request

    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
