from strategy.trade import Trade


class TradeManager:

    def __init__(self):
        self.trades = []
    def buy(self, candle, entry):

        entry = candle["close"]

        print("\nEnter Stop Loss price:")
        sl = float(input())

        print("Enter Take Profit price:")
        tp = float(input())

        trade = Trade(
            "BUY",
            entry,
            candle.name,
            sl,
            tp
    )

        self.trades.append(trade)
        trade.risk = abs(entry - sl)

        print("\nBUY opened")
        print(f"Entry : {entry:.5f}")
        print(f"SL    : {sl:.5f}")
        print(f"TP    : {tp:.5f}")

    def sell(self, candle, entry):


        print("\nEnter Stop Loss price:")
        sl = float(input())

        print("Enter Take Profit price:")
        tp = float(input())

        trade = Trade(
            "SELL",
            entry,
            candle.name,
            sl,
            tp
    )

        self.trades.append(trade)
        trade.risk = abs(sl - entry)

        print("\nSELL opened")
        print(f"Entry : {entry:.5f}")
        print(f"SL    : {sl:.5f}")
        print(f"TP    : {tp:.5f}")

    def show_open_trades(self):

        print("\n========== OPEN TRADES ==========")

        if len(self.trades) == 0:
            print("No trades.")

        for i, trade in enumerate(self.trades):

            if trade.status == "OPEN":

                print(
                   f"{i+1}. "
                   f"{trade.trade_type} | "
                   f"Entry {trade.entry_price:.5f} | "
                   f"SL {trade.stop_loss:.5f} | "
                   f"TP {trade.take_profit:.5f}"
)
    def close_last_trade(self, candle):

        open_trades = [t for t in self.trades if t.status == "OPEN"]

        if len(open_trades) == 0:
            print("\nNo open trades.\n")
            return

        trade = open_trades[-1]

        trade.exit_price = candle["close"]
        trade.exit_time = candle.name
        trade.status = "CLOSED"

        if trade.trade_type == "BUY":
            pnl = trade.exit_price - trade.entry_price
        else:
            pnl = trade.entry_price - trade.exit_price

        pips = pnl * 10000

        print("\n==============================")
        print(f"Trade Closed")
        print(f"Type : {trade.trade_type}")
        print(f"Entry: {trade.entry_price:.5f}")
        print(f"Exit : {trade.exit_price:.5f}")
        print(f"P/L  : {pips:.1f} pips")
        print("==============================\n")

        print("=================================\n")
    def update_trades(self, candle):

     for trade in self.trades:

        if trade.status != "OPEN":
            continue

        high = candle["high"]
        low = candle["low"]

        if trade.trade_type == "BUY":

            if low <= trade.stop_loss:

                trade.status = "CLOSED"
                trade.exit_price = trade.stop_loss
                trade.exit_time = candle.name

                trade.reward = trade.exit_price - trade.entry_price
                trade.result_r = trade.reward / trade.risk
                

                print("\nBUY Stop Loss Hit")
                print(f"Result: {trade.result_r:.2f}R")

            elif high >= trade.take_profit:

                trade.status = "CLOSED"
                trade.exit_price = trade.take_profit
                trade.exit_time = candle.name

                trade.reward = trade.exit_price - trade.entry_price
                trade.result_r = trade.reward / trade.risk

                print("\nBUY Take Profit Hit")
                print(f"Result: {trade.result_r:.2f}R")

        else:

            if high >= trade.stop_loss:

                trade.status = "CLOSED"
                trade.exit_price = trade.stop_loss
                trade.exit_time = candle.name

                trade.reward = trade.entry_price - trade.exit_price
                trade.result_r = trade.reward / trade.risk

                print("\nSELL Stop Loss Hit")
                print(f"Result: {trade.result_r:.2f}R")

            elif low <= trade.take_profit:

                trade.status = "CLOSED"
                trade.exit_price = trade.take_profit
                trade.exit_time = candle.name

                trade.reward = trade.entry_price - trade.exit_price
                trade.result_r = trade.reward / trade.risk

                print("\nSELL Take Profit Hit")
                print(f"Result: {trade.result_r:.2f}R")
    def show_statistics(self):

        closed = [t for t in self.trades if t.status == "CLOSED"]

        if len(closed) == 0:
            print("\nNo closed trades.\n")
            return

        wins = [t for t in closed if t.result_r > 0]
        losses = [t for t in closed if t.result_r <= 0]

        total_r = sum(t.result_r for t in closed)

        avg_win = (
            sum(t.result_r for t in wins) / len(wins)
            if wins else 0
        )

        avg_loss = (
            sum(t.result_r for t in losses) / len(losses)
            if losses else 0
        )

        win_rate = len(wins) / len(closed) * 100

        expectancy = total_r / len(closed)

        gross_profit = sum(t.result_r for t in wins)

        gross_loss = abs(sum(t.result_r for t in losses))

        profit_factor = (
            gross_profit / gross_loss
            if gross_loss != 0 else float("inf")
        )

        print("\n========== STATISTICS ==========")
        print(f"Trades        : {len(closed)}")
        print(f"Wins          : {len(wins)}")
        print(f"Losses        : {len(losses)}")
        print(f"Win Rate      : {win_rate:.2f}%")
        print(f"Average Win   : {avg_win:.2f} R")
        print(f"Average Loss  : {avg_loss:.2f} R")
        print(f"Expectancy    : {expectancy:.2f} R")
        print(f"Total R       : {total_r:.2f} R")
        print(f"Profit Factor : {profit_factor:.2f}")
        print("================================\n")