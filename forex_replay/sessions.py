"""Market-session labels.

The bundled data is an MT5 export in *broker server time*: UTC+2 in winter and
UTC+3 in summer, i.e. aligned so the forex week opens at 00:00 on Monday and
closes at 24:00 on Friday (17:00 New York). In that clock London opens at
10:00 and New York at 15:00 all year round, which is why these hours look
"shifted" compared with UK or Indian time.

Edit SESSIONS if your data uses a different clock.
"""

from __future__ import annotations

import pandas as pd

# (label, start hour inclusive, end hour exclusive) in the data's clock
SESSIONS: tuple[tuple[str, int, int], ...] = (
    ("Asia", 0, 10),
    ("London", 10, 15),
    ("London/NY overlap", 15, 19),
    ("New York", 19, 24),
)


def session_of(timestamp) -> str:
    hour = pd.Timestamp(timestamp).hour
    for label, start, end in SESSIONS:
        if start <= hour < end:
            return label
    return "Unknown"


def session_bounds(label: str) -> tuple[int, int]:
    for name, start, end in SESSIONS:
        if name == label:
            return start, end
    raise KeyError(label)


# ----------------------------------------------------------------- v2: the app's standard sessions
# The browser app (web/js/sessions.js, PRESETS.standard) defines each session in its own city's clock, so it
# follows daylight saving by itself; the order-flow log and backtester use these (UTC seconds in, labels out).
# tests/test_sessions_v2.py holds them to sessions.js. The v1 SESSIONS above are for the v1 data clock only.
STANDARD: tuple[tuple[str, str, int, int], ...] = (
    ("Asia", "Asia/Tokyo", 9 * 60, 18 * 60),
    ("London", "Europe/London", 8 * 60, 17 * 60),
    ("New York", "America/New_York", 8 * 60, 17 * 60),
)


def sessions_open(utc: int) -> list[str]:
    """The standard sessions open at a UTC second, in order (several at once in the overlaps)."""
    from datetime import datetime
    from zoneinfo import ZoneInfo

    out = []
    for label, zone, start, end in STANDARD:
        local = datetime.fromtimestamp(int(utc), ZoneInfo(zone))
        if start <= local.hour * 60 + local.minute < end:
            out.append(label)
    return out


def session_label(utc: int) -> str:
    """"London/New York" in the overlap, "Off session" when none is open."""
    return "/".join(sessions_open(utc)) or "Off session"


def session_opens(start: int, end: int) -> list[tuple[int, str]]:
    """Every standard session open (UTC second, label) from start to end, in time order."""
    from datetime import datetime, timedelta, timezone
    from zoneinfo import ZoneInfo

    out = []
    day = datetime.fromtimestamp(int(start), timezone.utc).date() - timedelta(days=1)
    last = datetime.fromtimestamp(int(end), timezone.utc).date() + timedelta(days=1)
    while day <= last:
        for label, zone, minutes, _ in STANDARD:
            local = datetime(day.year, day.month, day.day, minutes // 60, minutes % 60, tzinfo=ZoneInfo(zone))
            t = int(local.timestamp())
            if start <= t <= end:
                out.append((t, label))
        day += timedelta(days=1)
    return sorted(out)
