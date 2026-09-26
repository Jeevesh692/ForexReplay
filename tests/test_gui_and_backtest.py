import tempfile
from pathlib import Path
from types import SimpleNamespace

import matplotlib

matplotlib.use("Agg")

import pytest  # noqa: E402
from conftest import make_candles  # noqa: E402

from forex_replay.backtest import Strategy, run_backtest  # noqa: E402
from forex_replay.broker import Side, Status  # noqa: E402
from forex_replay.config import EURUSD_M5  # noqa: E402
from forex_replay.gui import ReplayApp  # noqa: E402
from forex_replay.journal import load_journal  # noqa: E402

RISING = [(1.1000 + i * 0.0002, 1.1004 + i * 0.0002, 1.0998 + i * 0.0002, 1.1002 + i * 0.0002)
          for i in range(40)]


def key(app, k):
    app.on_key(SimpleNamespace(key=k))


def click(app, price, x=None):
    x = app.engine.last_index if x is None else x
    app.on_click(SimpleNamespace(inaxes=app.ax_price, xdata=x, ydata=price))


def test_click_to_trade_flow_writes_journal():
    with tempfile.TemporaryDirectory() as tmp:
        app = ReplayApp(make_candles(RISING), EURUSD_M5, Path(tmp), window=10)
        key(app, "b")
        key(app, "enter")               # market entry
        click(app, 1.0990)              # stop loss
        click(app, 1.1030)              # take profit
        trade = app.broker.trades[0]
        assert trade.status is Status.PENDING
        for _ in range(20):
            key(app, "right")
        assert trade.status is Status.CLOSED
        df = load_journal(Path(tmp) / "trades.csv")
        assert len(df) == 1 and df.loc[0, "exit_reason"] == "TAKE_PROFIT"
        app.fig.savefig(Path(tmp) / "chart.png")  # rendering works end to end


def test_cannot_trade_while_viewing_history():
    with tempfile.TemporaryDirectory() as tmp:
        app = ReplayApp(make_candles(RISING), EURUSD_M5, Path(tmp), window=10)
        key(app, "right")
        key(app, "left")
        key(app, "b")
        assert app.draft is None and "history" in app.message
        key(app, "end")
        key(app, "b")
        assert app.draft is not None


def test_invalid_order_is_rejected_with_a_message():
    with tempfile.TemporaryDirectory() as tmp:
        app = ReplayApp(make_candles(RISING), EURUSD_M5, Path(tmp), window=10)
        key(app, "b")
        key(app, "enter")
        click(app, 1.2000)   # stop loss ABOVE a buy
        click(app, 1.3000)
        assert app.broker.trades == []
        assert app.message.startswith("Order rejected")


def test_session_save_and_load_in_app():
    with tempfile.TemporaryDirectory() as tmp:
        app = ReplayApp(make_candles(RISING), EURUSD_M5, Path(tmp), window=10)
        key(app, "h")
        click(app, 1.1)
        key(app, "right")
        key(app, "f5")
        current = app.engine.current
        key(app, "delete")
        key(app, "right")
        key(app, "f9")
        assert app.engine.current == current
        assert app.drawings.hlines == [1.1]


class BuyFirstCandle(Strategy):
    name = "buy_first"

    def on_candle(self, ctx):
        if ctx.index == 0:
            ctx.market(Side.BUY, ctx.close - 0.0010, ctx.close + 0.0010)


def test_backtest_fills_strategy_orders_on_the_next_candle():
    candles = make_candles(RISING)
    result = run_backtest(candles, BuyFirstCandle(), EURUSD_M5)
    trade = result.trades[0]
    assert trade.entry_time == candles.index[1]
    assert trade.entry_price == pytest.approx(candles["open"].iloc[1])
    assert result.stats.trades == 1
