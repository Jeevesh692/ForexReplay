import csv
import os


class TradeLogger:

    def __init__(self, filename):

        self.filename = filename

        if not os.path.exists(filename):

            with open(filename, "w", newline="") as f:

                writer = csv.writer(f)

                writer.writerow([
                    "Entry Time",
                    "Exit Time",
                    "Type",
                    "Entry",
                    "Exit",
                    "Stop Loss",
                    "Take Profit",
                    "Result (R)",
                    "Status"
                ])

    def log_trade(self, trade):

        with open(self.filename, "a", newline="") as f:

            writer = csv.writer(f)

            writer.writerow([
                trade.entry_time,
                trade.exit_time,
                trade.trade_type,
                round(trade.entry_price,5),
                round(trade.exit_price,5),
                round(trade.stop_loss,5),
                round(trade.take_profit,5),
                round(trade.result_r,2),
                trade.status
            ])