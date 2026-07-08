from abc import ABC, abstractmethod


class BaseStrategy(ABC):

    @abstractmethod
    def on_event(self, event):
        """Called whenever the replay engine produces a new event."""
        pass

    def on_trade_open(self, trade):
        """Optional callback."""
        pass

    def on_trade_close(self, trade):
        """Optional callback."""
        pass