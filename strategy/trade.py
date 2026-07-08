class Trade:

    def __init__(
        self,
        trade_type,
        entry_price,
        entry_time,
        stop_loss,
        take_profit
    ):

        self.trade_type = trade_type

        self.entry_price = entry_price
        self.entry_time = entry_time

        self.stop_loss = stop_loss
        self.take_profit = take_profit

        self.exit_price = None
        self.exit_time = None
        self.risk = None
        self.reward = None
        self.result_r = None

        self.status = "OPEN"