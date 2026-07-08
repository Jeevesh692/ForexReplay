from strategy.trade_manager import TradeManager
from replay.loader import load_data
from replay.replay_engine import ReplayEngine
from matplotlib.animation import FuncAnimation

import mplfinance as mpf
import matplotlib.pyplot as plt

# Load data
# Load data
df = load_data("data/EURUSD_M5.csv")

print(df.columns)

df.set_index("time", inplace=True)

engine = ReplayEngine(df)
trade_manager = TradeManager()
print("\nJump to date? (Press Enter to start from beginning)")
print("Format: YYYY-MM-DD HH:MM:SS")

jump_date = input("> ").strip()

if jump_date:

    try:
        nearest = df.index.get_indexer([jump_date], method="nearest")[0]
        engine.current = nearest

    except Exception:
        print("Invalid date. Starting from beginning.")
        engine.current = 100

else:
    engine.current = 100
fig = plt.figure()

playing = False

def update(frame):
    global playing

    if playing:

        engine.next_candle()

        candle = engine.current_data(1).iloc[-1]

        trade_manager.update_trades(candle)

    draw_chart()
def draw_chart():
    plt.clf()

    fig = plt.gcf()

    ax_price = fig.add_subplot(2, 1, 1)
    ax_volume = fig.add_subplot(
        2,
        1,
        2,
        sharex=ax_price
    )

    chart = engine.current_data(100)
    chart = chart.rename(columns={"tick_volume": "volume"})

    mpf.plot(
        chart,
        type="candle",
        style="charles",
        ax=ax_price,
        volume=ax_volume
    )

    ax_price.set_title(
        f"EURUSD M5 | Candles: {engine.current}"
    )
draw_chart()

def on_key(event):
    print(repr(event.key))
    global playing

    if event.key == "right":
        engine.next_candle()

        candle = engine.current_data(1).iloc[-1]

        trade_manager.update_trades(candle)

        draw_chart()
        plt.draw()

    elif event.key == "left":
        engine.previous_candle()
        draw_chart()
        plt.draw()

    elif event.key == " ":
        playing = not playing

    elif event.key == "b":

        candle = engine.current_data(100).iloc[-1]

        trade_manager.buy(candle)

    elif event.key == "n":

        candle = engine.current_data(100).iloc[-1]

        trade_manager.sell(candle)

    elif event.key == "t":

        trade_manager.show_open_trades()
    elif event.key == "c":

        candle = engine.current_data(100).iloc[-1]

        trade_manager.close_last_trade(candle)
    elif event.key == "o":
        print("Statistics shortcut pressed")
        trade_manager.show_statistics()

fig.canvas.mpl_connect("key_press_event", on_key)

ani = FuncAnimation(fig, update, interval=200)

plt.show()