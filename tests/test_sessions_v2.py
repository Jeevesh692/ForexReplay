"""The app's standard sessions in Python (sessions.STANDARD) are the browser's (web/js/sessions.js PRESETS.standard)."""

import re

from forex_replay.config import PROJECT_ROOT
from forex_replay.sessions import STANDARD, session_label, session_opens


def test_the_same_sessions_as_the_browser():
    js = (PROJECT_ROOT / "web" / "js" / "sessions.js").read_text(encoding="utf-8")
    block = js[js.index("standard: {"):js.index("killzones: {")]
    found = re.findall(r'label: "([^"]+)", zone: "([^"]+)", start: "(\d\d):(\d\d)", end: "(\d\d):(\d\d)"', block)
    assert [(label, zone, int(h1) * 60 + int(m1), int(h2) * 60 + int(m2)) for label, zone, h1, m1, h2, m2 in found] == list(STANDARD)


def test_labels_and_opens_follow_each_citys_clock():
    winter = 1762430400  # Thu 6 Nov 2025 12:00 UTC: London 12:00, New York 07:00, Tokyo 21:00
    assert session_label(winter) == "London"
    assert session_label(winter + 3600) == "London/New York"  # 13:00 UTC = 08:00 New York (winter)
    assert session_label(1762473600) == "Asia"  # Fri 7 Nov 00:00 UTC = 09:00 Tokyo
    opens = session_opens(1762387200, 1762473599)  # Thu 6 Nov 2025, the whole UTC day
    assert [(t - 1762387200, label) for t, label in opens] == [(0, "Asia"), (8 * 3600, "London"), (13 * 3600, "New York")]  # Tokyo 09:00 = 00:00 UTC
