#!/usr/bin/env python3
import html, os, secrets, stat, threading, time, urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HOST = os.environ.get("RCMCP_RECEIVER_HOST", "127.0.0.1")
PORT = int(os.environ.get("RCMCP_RECEIVER_PORT", "45234"))
TTL = int(os.environ.get("RCMCP_RECEIVER_TTL", "1800"))
RUNTIME = Path(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"))
CONFIG = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home()/".config"))) / "remote-control-mcp"
SECRET = CONFIG / "openai-tunnel-runtime.key"
URL_FILE = RUNTIME / "rcmcp-runtime-key-receiver.url"
DONE_FILE = RUNTIME / "rcmcp-runtime-key-receiver.done"
TOKEN = secrets.token_urlsafe(32)
PATH = f"/{TOKEN}"

CONFIG.mkdir(parents=True, exist_ok=True, mode=0o700)
URL_FILE.write_text(f"http://{HOST}:{PORT}{PATH}\n")
os.chmod(URL_FILE, 0o600)
DONE_FILE.unlink(missing_ok=True)

def page(message=""):
    msg = f"<p>{html.escape(message)}</p>" if message else ""
    return f'''<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Remote Control MCP tunnel key</title><style>body{{font-family:system-ui;max-width:650px;margin:3rem auto;padding:1rem}}input{{width:100%;padding:.8rem}}button{{margin-top:1rem;padding:.8rem 1.2rem}}</style><h2>Remote Control MCP — OpenAI Runtime API key</h2><p>Paste the Restricted Runtime API key with <b>Tunnels Read + Use</b>. It is sent only over your Tailscale network, saved mode 0600, never echoed, and this receiver closes after success.</p>{msg}<form method="post"><input type="password" name="key" autocomplete="off" required autofocus><button type="submit">Store key on server</button></form>'''.encode()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def send_html(self, code, body):
        self.send_response(code); self.send_header("Content-Type", "text/html; charset=utf-8"); self.send_header("Cache-Control", "no-store"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path != PATH: self.send_error(404); return
        self.send_html(200, page())
    def do_POST(self):
        if self.path != PATH: self.send_error(404); return
        try: length = int(self.headers.get("Content-Length", "0"))
        except ValueError: length = 0
        if length <= 0 or length > 2048: self.send_html(400, page("Invalid payload.")); return
        data = urllib.parse.parse_qs(self.rfile.read(length).decode("utf-8", "strict"), keep_blank_values=True)
        key = data.get("key", [""])[0].strip()
        if not (key.startswith("sk-") and 20 <= len(key) <= 1000 and not any(c.isspace() for c in key)):
            self.send_html(400, page("Key format rejected. Expected an OpenAI key beginning with sk-.")); return
        tmp = SECRET.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f: f.write(key)
        os.replace(tmp, SECRET); os.chmod(SECRET, 0o600)
        DONE_FILE.write_text("stored\n"); os.chmod(DONE_FILE, 0o600)
        self.send_html(200, b'<!doctype html><meta name="viewport" content="width=device-width"><h2>Stored successfully</h2><p>You can return to ChatGPT. This one-shot receiver is closing.</p>')
        threading.Thread(target=self.server.shutdown, daemon=True).start()

server = HTTPServer((HOST, PORT), Handler)
threading.Timer(TTL, server.shutdown).start()
try: server.serve_forever()
finally:
    URL_FILE.unlink(missing_ok=True)
