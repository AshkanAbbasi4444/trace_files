import http.server, os, subprocess

PORT = 8000
DIR = os.path.dirname(os.path.abspath(__file__))   # the folder server.py is in


def build_and_trace(code):
    """save the code, compile it, trace it; returns (ok, text)"""
    with open(os.path.join(DIR, "prog.c"), "w") as f:
        f.write(code)
    if os.path.exists(os.path.join(DIR, "prog.json")):
        os.remove(os.path.join(DIR, "prog.json"))    # never send back an old trace

    cc = subprocess.run(["gcc", "-g", "-O0", "prog.c", "-o", "prog"],
                        cwd=DIR, capture_output=True, text=True)
    if cc.returncode != 0:
        return False, cc.stderr                      # gcc's error message

    try:
        subprocess.run(["gdb", "-q", "-nx", "-batch", "-x", "trace.py", "./prog"],
                       cwd=DIR, capture_output=True, text=True,
                       stdin=subprocess.DEVNULL, timeout=60)
    except subprocess.TimeoutExpired:
        return False, "gdb took longer than 60 seconds"

    try:
        with open(os.path.join(DIR, "prog.json")) as f:
            return True, f.read()
    except IOError:
        return False, "gdb did not write prog.json"


def blueprints(code):
    """compile without linking (no main needed), then ask gdb what every struct looks like"""
    with open(os.path.join(DIR, "bp.c"), "w") as f:
        f.write(code)
    if os.path.exists(os.path.join(DIR, "bp.json")):
        os.remove(os.path.join(DIR, "bp.json"))

    cc = subprocess.run(["gcc", "-g", "-c", "-fno-eliminate-unused-debug-types", "bp.c", "-o", "bp.o"],
                        cwd=DIR, capture_output=True, text=True)
    if cc.returncode != 0:
        return False, cc.stderr

    try:
        subprocess.run(["gdb", "-q", "-nx", "-batch", "-x", "blueprints.py", "bp.o"],
                       cwd=DIR, capture_output=True, text=True,
                       stdin=subprocess.DEVNULL, timeout=20)
    except subprocess.TimeoutExpired:
        return False, "gdb took longer than 20 seconds"

    try:
        with open(os.path.join(DIR, "bp.json")) as f:
            return True, f.read()
    except IOError:
        return False, "gdb did not write bp.json"


ROUTES = {"/run": build_and_trace, "/blueprints": blueprints}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)   # serve files from this folder

    def do_POST(self):
        if self.path not in ROUTES:
            self.send_error(404)
            return
        n = int(self.headers.get("Content-Length", 0))
        code = self.rfile.read(n).decode()
        ok, text = ROUTES[self.path](code)
        body = text.encode()
        self.send_response(200 if ok else 400)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


print("open http://localhost:%d/node_cards_viewer.html" % PORT)
http.server.HTTPServer(("localhost", PORT), Handler).serve_forever()
