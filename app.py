from replay.loader import load_data
from replay.replay_engine import ReplayEngine

import mplfinance as mpf
import matplotlib.pyplot as plt

# Load data
df = load_data("data/EURUSD_M5.csv")
df.set_index("time", inplace=True)

engine = ReplayEngine(df)

fig = plt.figure()

def draw_chart():
    plt.clf()

    mpf.plot(
        engine.current_data()[["open", "high", "low", "close"]],
        type="candle",
        style="charles",
        ax=plt.gca(),
        volume=False
    )

    plt.title(f"EURUSD M5 | Candles: {engine.current}")

draw_chart()

def on_key(event):
    if event.key == "right":
        engine.next_candle()
        draw_chart()
        plt.draw()

    elif event.key == "left":
        engine.previous_candle()
        draw_chart()
        plt.draw()

fig.canvas.mpl_connect("key_press_event", on_key)

plt.show()