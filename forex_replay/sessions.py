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
