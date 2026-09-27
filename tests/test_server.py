import json
import tempfile
import threading
import urllib.request
from pathlib import Path

from forex_replay.server import chart_library_version, make_server


def serve(root: Path):
    server = make_server(port=18765, root=root)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def test_serves_javascript_modules_with_a_javascript_type_and_health():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "app.js").write_text("export const x = 1;")
        server, base = serve(root)
        try:
            with urllib.request.urlopen(f"{base}/app.js") as r:
                assert r.headers["Content-Type"].startswith("text/javascript")
                assert r.headers["Cache-Control"] == "no-store"
            with urllib.request.urlopen(f"{base}/api/health") as r:
                assert json.loads(r.read())["ok"] is True
        finally:
            server.shutdown()
            server.server_close()


def test_only_listens_on_this_computer():
    with tempfile.TemporaryDirectory() as tmp:
        server = make_server(port=18775, root=Path(tmp))
        try:
            assert server.server_address[0] == "127.0.0.1"
        finally:
            server.server_close()


def test_reads_chart_library_version_from_its_banner():
    with tempfile.TemporaryDirectory() as tmp:
        lib = Path(tmp) / "lib.js"
        lib.write_text("/*!\n * @license\n * TradingView Lightweight Charts™ v5.0.8\n */ var x;")
        assert chart_library_version(lib) == "v5.0.8"
        assert chart_library_version(Path(tmp) / "missing.js") is None
