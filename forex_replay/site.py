"""Build the browser app as a static website (for free hosting, e.g. Cloudflare Pages).

    python -m forex_replay site --out _site

The website is the same app without the Python server: the market data and the chart library
are copied in beside it, and a `site.json` tells the app it is online. Online, backtests are saved
in each visitor's own browser (web/js/store.js) and screenshots are not kept.

The site asks search engines not to list it (a robots meta tag, robots.txt and an X-Robots-Tag
header for Cloudflare Pages), so it is reached only by people who are given its address. That
is privacy by obscurity, not a password: whoever has the link can use it.
"""

from __future__ import annotations

import json
import os
import shutil
import stat
from datetime import datetime, timezone
from pathlib import Path

from . import __version__
from .config import PROJECT_ROOT

WEB_ROOT = PROJECT_ROOT / "web"
COPY = ["index.html", "css", "js", "data", "vendor"]  # web/tests and package.json stay out
NOINDEX = '<meta name="robots" content="noindex, nofollow">'


def _clear_read_only(func, path, _info):
    os.chmod(path, stat.S_IWRITE)
    func(path)


def build_site(out: Path, web_root: Path = WEB_ROOT, refresh: bool = True) -> dict:
    """Write the website into `out`. `refresh` rebuilds the market data and fetches the chart library first."""
    out = Path(out).resolve()
    if out == Path(web_root).resolve() or Path(web_root).resolve() in out.parents:
        raise ValueError("The website must be built outside web/.")
    if out.exists() and any(out.iterdir()) and not (out / "site.json").exists():
        raise ValueError(f"{out} is not empty and is not an earlier website build; choose another folder.")

    if refresh:
        from .datapipe import build
        from .server import ensure_chart_library
        build()
        if ensure_chart_library() is None:
            raise RuntimeError("The chart library could not be downloaded; the website would not work without it.")

    missing = [name for name in COPY if not (Path(web_root) / name).exists()]
    if missing:
        raise FileNotFoundError(f"Missing in {web_root}: {', '.join(missing)}")

    if out.exists():
        shutil.rmtree(out, onerror=_clear_read_only)  # an earlier build; synced folders (OneDrive) can mark files read-only
    out.mkdir(parents=True)
    for name in COPY:
        source = Path(web_root) / name
        if source.is_dir():
            shutil.copytree(source, out / name)
        else:
            shutil.copy2(source, out / name)

    index = out / "index.html"
    html = index.read_text(encoding="utf-8")
    if NOINDEX not in html:
        html = html.replace("<head>", f"<head>\n  {NOINDEX}", 1)
    index.write_text(html, encoding="utf-8")
    (out / "robots.txt").write_text("User-agent: *\nDisallow: /\n", encoding="utf-8")
    (out / "_headers").write_text("/*\n  X-Robots-Tag: noindex, nofollow\n", encoding="utf-8")  # read by Cloudflare Pages
    built = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    (out / "site.json").write_text(json.dumps({"static": True, "version": __version__, "built": built}), encoding="utf-8")

    files = [f for f in out.rglob("*") if f.is_file()]
    return {"out": str(out), "files": len(files), "bytes": sum(f.stat().st_size for f in files)}
