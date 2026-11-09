"""The mechanical backtester (order flow, Phase 9): Models A and B from the order-flow brief, run on the candles
and order-flow data the app replays, with every number in a YAML file (configs/mechanical.yaml).

    python -m forex_replay mbt run --config configs/mechanical.yaml [--set key=value ...] [--name NAME]
    python -m forex_replay mbt compare <strategy> --config configs/mechanical.yaml

config.py (settings), engine.py (the rules, management and limits), report.py (files and summary),
compare.py (your manual trades against the rules). Decision 0041.
"""
