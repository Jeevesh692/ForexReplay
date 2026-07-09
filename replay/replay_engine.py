class ReplayEngine:
    def jump_to_index(self, index):
        self.current = max(100, min(index, len(self.df) - 1))
    def __init__(self, dataframe, initial_candles=100):
        self.df = dataframe
        self.current = initial_candles

    def current_data(self, window=100):
        start = max(0, self.current - window)
        return self.df.iloc[start:self.current]
    def next_candle(self):
        if self.current < len(self.df):
            self.current += 1

    def previous_candle(self):
        if self.current > 1:
            self.current -= 1