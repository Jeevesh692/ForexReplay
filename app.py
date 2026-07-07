from replay.loader import load_data
from replay.replay_engine import ReplayEngine
from matplotlib.animation import FuncAnimation

import mplfinance as mpf
import matplotlib.pyplot as plt

# Load data
df = load_data("data/EURUSD_M5.csv")
df.set_index("time", inplace=True)

engine = ReplayEngine(df)

fig = plt.figure()

playing = False

def update(frame):
    global playing

    if playing:
        engine.next_candle()
        draw_chart()

def draw_chart():
    plt.clf()

    mpf.plot(
        engine.current_data(100)[["open", "high", "low", "close"]],
        type="candle",
        style="charles",
        ax=plt.gca(),
        volume=False
    )

    plt.title(f"EURUSD M5 | Candles: {engine.current}")

draw_chart()

def on_key(event):
    global playing

    if event.key == "right":
        engine.next_candle()
        draw_chart()
        plt.draw()

    elif event.key == "left":
        engine.previous_candle()
        draw_chart()
        plt.draw()

    elif event.key == " ":
        playing = not playing

fig.canvas.mpl_connect("key_press_event", on_key)

ani = FuncAnimation(fig, update, interval=200)

plt.show()