import pandas as pd
import pytest

from forex_replay.broker import Broker, ExitReason, InvalidOrder, OrderType, Side, Status
from forex_replay.config import EURUSD_M5

T0 = pd.Timestamp("2025-03-03 10:00")
T1 = pd.Timestamp("2025-03-03 10:05")
T2 = pd.Timestamp("2025-03-03 10:10")


def broker(spread=0.0, log=None):
    return Broker(EURUSD_M5, spread_pips=spread, on_close=(log.append if log is not None else None))


# ----- validation ---------------------------------------------------------
def test_buy_with_stop_above_entry_is_rejected():
    with pytest.raises(InvalidOrder):
        broker().pending_order(Side.BUY, 1.1000, 1.1010, 1.1020, T0, bid=1.1005)


def test_sell_with_take_profit_above_entry_is_rejected():
    with pytest.raises(InvalidOrder):
        broker().pending_order(Side.SELL, 1.1000, 1.1010, 1.1020, T0, bid=1.1005)


def test_zero_risk_order_is_rejected():
    with pytest.raises(InvalidOrder):
        broker().market_order(Side.BUY, 1.1000, 1.1020, T0, bid=1.1000)


# ----- order types and fills ---------------------------------------------
def test_order_type_is_inferred_from_current_price():
    b = broker()
    assert b.pending_order(Side.BUY, 1.0990, 1.0980, 1.1010, T0, 1.1000).order_type is OrderType.LIMIT
    assert b.pending_order(Side.BUY, 1.1010, 1.0990, 1.1030, T0, 1.1000).order_type is OrderType.STOP
    assert b.pending_order(Side.SELL, 1.1010, 1.1020, 1.0990, T0, 1.1000).order_type is OrderType.LIMIT
    assert b.pending_order(Side.SELL, 1.0990, 1.1000, 1.0970, T0, 1.1000).order_type is OrderType.STOP


def test_market_order_fills_at_next_open_not_at_placement_price():
    b = broker()
    t = b.market_order(Side.BUY, 1.0990, 1.1030, T0, bid=1.1000)
    assert t.status is Status.PENDING  # nothing happens on the placement candle
    b.process_candle(T1, 1.1004, 1.1006, 1.1001)
    assert t.status is Status.OPEN
    assert t.entry_price == pytest.approx(1.1004)
    assert t.entry_time == T1


def test_buy_limit_waits_until_price_trades_down_to_it():
    b = broker()
    t = b.pending_order(Side.BUY, 1.0990, 1.0980, 1.1010, T0, bid=1.1000)
    b.process_candle(T1, 1.1000, 1.1005, 1.0995)
    assert t.status is Status.PENDING
    b.process_candle(T2, 1.0995, 1.0996, 1.0989)
    assert t.status is Status.OPEN and t.entry_price == pytest.approx(1.0990)


def test_buy_stop_gapping_over_the_price_fills_at_the_open():
    b = broker()
    t = b.pending_order(Side.BUY, 1.1010, 1.0990, 1.1050, T0, bid=1.1000)
    b.process_candle(T1, 1.1020, 1.1025, 1.1015)
    assert t.entry_price == pytest.approx(1.1020)  # slippage, like a real stop order


# ----- exits --------------------------------------------------------------
def test_stop_loss_wins_when_both_levels_are_inside_one_candle():
    closed = []
    b = broker(log=closed)
    t = b.market_order(Side.BUY, 1.0990, 1.1010, T0, bid=1.1000)
    b.process_candle(T1, 1.1000, 1.1001, 1.0999)
    b.process_candle(T2, 1.1000, 1.1015, 1.0985)
    assert t.exit_reason is ExitReason.STOP_LOSS
    assert t.result_r == pytest.approx(-1.0)
    assert closed == [t]


def test_take_profit_is_not_taken_on_the_candle_a_limit_order_fills():
    b = broker()
    t = b.pending_order(Side.BUY, 1.0990, 1.0980, 1.1000, T0, bid=1.1000)
    b.process_candle(T1, 1.0995, 1.1005, 1.0989)  # fills AND touches TP: order unknown
    assert t.status is Status.OPEN
    b.process_candle(T2, 1.0995, 1.1001, 1.0994)
    assert t.exit_reason is ExitReason.TAKE_PROFIT
    assert t.result_r == pytest.approx(1.0)


def test_gap_through_stop_loss_gives_a_loss_worse_than_minus_one_r():
    b = broker()
    t = b.market_order(Side.BUY, 1.0990, 1.1020, T0, bid=1.1000)
    b.process_candle(T1, 1.1000, 1.1001, 1.0995)
    b.process_candle(T2, 1.0980, 1.0985, 1.0975)
    assert t.exit_price == pytest.approx(1.0980)
    assert t.result_r == pytest.approx(-2.0)


def test_spread_makes_sell_stop_loss_trigger_on_the_ask():
    b = broker(spread=1.0)  # 1 pip
    t = b.pending_order(Side.SELL, 1.1000, 1.1010, 1.0980, T0, bid=1.1005)
    b.process_candle(T1, 1.1003, 1.1004, 1.0999)  # bid trades down through 1.1000 -> fills
    assert t.status is Status.OPEN
    b.process_candle(T2, 1.1003, 1.1009, 1.1002)  # bid high 1.1009, ask high 1.1010 -> stopped
    assert t.exit_reason is ExitReason.STOP_LOSS


def test_spread_is_paid_on_buy_entries():
    b = broker(spread=2.0)
    t = b.market_order(Side.BUY, 1.0990, 1.1030, T0, bid=1.1000)
    b.process_candle(T1, 1.1000, 1.1001, 1.0999)
    assert t.entry_price == pytest.approx(1.1002)


# ----- manual actions -----------------------------------------------------
def test_manual_close_calculates_r_and_is_reported():
    closed = []
    b = broker(log=closed)
    t = b.market_order(Side.SELL, 1.1020, 1.0980, T0, bid=1.1000)
    b.process_candle(T1, 1.1000, 1.1002, 1.0990)
    b.close(t, T2, bid=1.0990)
    assert t.exit_reason is ExitReason.MANUAL
    assert t.result_r == pytest.approx(0.5)
    assert closed == [t]


def test_cancelled_orders_never_fill():
    b = broker()
    t = b.pending_order(Side.BUY, 1.0990, 1.0980, 1.1010, T0, bid=1.1000)
    b.cancel(t)
    b.process_candle(T1, 1.0990, 1.0990, 1.0970)
    assert t.status is Status.CANCELLED


def test_excursions_are_tracked_in_r_and_capped_at_the_levels():
    b = broker()
    t = b.market_order(Side.BUY, 1.0990, 1.1030, T0, bid=1.1000)
    b.process_candle(T1, 1.1000, 1.1005, 1.0995)   # +0.5R / -0.5R
    b.process_candle(T2, 1.1004, 1.1020, 1.1003)   # +2R best so far
    assert t.mfe_r == pytest.approx(2.0)
    assert t.mae_r == pytest.approx(0.5)


def test_trade_round_trips_through_dict():
    b = broker()
    t = b.market_order(Side.BUY, 1.0990, 1.1030, T0, bid=1.1000)
    b.process_candle(T1, 1.1000, 1.1005, 1.0995)
    copy = type(t).from_dict(t.to_dict())
    assert copy.to_dict() == t.to_dict()


# ----- moving stops and partial closes (added for v2) -----------------------
def opened_buy(b):
    """A buy from 1.1000 with a 10-pip stop and a 30-pip target, already filled."""
    trade = b.market_order(Side.BUY, 1.0990, 1.1030, T0, bid=1.1000)
    b.process_candle(T1, 1.1000, 1.1012, 1.0998)
    return trade


def test_moving_the_stop_to_breakeven_does_not_change_what_1r_means():
    b = broker()
    trade = opened_buy(b)
    b.modify(trade, bid=1.1010, stop_loss=1.1000)
    assert trade.planned_risk == pytest.approx(0.0010)
    b.process_candle(T2, 1.1010, 1.1011, 1.0995)
    assert trade.exit_reason is ExitReason.STOP_LOSS
    assert trade.result_r == pytest.approx(0.0)


def test_a_stop_cannot_be_moved_past_the_current_price():
    b = broker()
    trade = opened_buy(b)
    with pytest.raises(InvalidOrder):
        b.modify(trade, bid=1.0998, stop_loss=1.1000)
    with pytest.raises(InvalidOrder):
        b.modify(trade, bid=1.1005, take_profit=1.1004)
    assert (trade.stop_loss, trade.take_profit) == (1.0990, 1.1030)


def test_moving_a_pending_order_changes_its_planned_risk_and_type():
    b = broker()
    trade = b.pending_order(Side.BUY, 1.0995, 1.0990, 1.1020, T0, bid=1.1000)
    b.modify(trade, bid=1.1000, stop_loss=1.0985)
    assert trade.planned_risk == pytest.approx(0.0010)
    b.modify(trade, bid=1.1000, price=1.1005)
    assert trade.order_type is OrderType.STOP
    assert trade.planned_risk == pytest.approx(0.0020)


def test_partial_close_gives_the_size_weighted_result():
    b = broker()
    trade = opened_buy(b)
    b.partial_close(trade, 0.5, T1, bid=1.1010)          # half off at +1R
    assert trade.status is Status.OPEN and trade.remaining == 0.5
    b.process_candle(T2, 1.1010, 1.1031, 1.1009)          # the rest reaches +3R
    assert trade.exit_reason is ExitReason.TAKE_PROFIT
    assert trade.result_r == pytest.approx(2.0)


def test_partial_close_must_leave_something_open():
    b = broker()
    trade = opened_buy(b)
    with pytest.raises(InvalidOrder):
        b.partial_close(trade, 1.0, T1, bid=1.1010)
    assert trade.partials == []


def test_a_partly_closed_trade_round_trips_through_dict():
    from forex_replay.broker import Trade
    b = broker()
    trade = opened_buy(b)
    b.partial_close(trade, 0.25, T1, bid=1.1010)
    b.modify(trade, bid=1.1010, stop_loss=1.1000)
    copy = Trade.from_dict(trade.to_dict())
    assert copy == trade
    assert copy.initial_stop == 1.0990 and copy.remaining == 0.75


def test_trades_saved_before_v2_still_load():
    from forex_replay.broker import Trade
    old = opened_buy(broker()).to_dict()
    for key in ("initial_stop", "remaining", "partials"):
        del old[key]
    trade = Trade.from_dict(old)
    assert trade.initial_stop == trade.stop_loss and trade.remaining == 1.0 and trade.partials == []
