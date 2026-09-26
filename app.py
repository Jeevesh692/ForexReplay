from strategy.trade_manager import TradeManager
from replay.loader import load_data
from replay.replay_engine import ReplayEngine
from matplotlib.animation import FuncAnimation
from matplotlib.ticker import MaxNLocator
from matplotlib.dates import AutoDateLocator
from drawing.drawing_manager import DrawingManager
from storage.session import save_session, load_session 
from storage.trade_logger import TradeLogger

import mplfinance as mpf
import matplotlib.pyplot as plt
mc = mpf.make_marketcolors(
    up="#26a69a",
    down="#ef5350",
    edge="inherit",
    wick="inherit",
    volume="inherit"
)

style = mpf.make_mpf_style(
    marketcolors=mc,
    facecolor="#1e1e1e",
    edgecolor="#444444",
    figcolor="#1e1e1e",
    gridcolor="#333333",
    gridstyle="--",
    rc={
        "axes.labelcolor": "white",
        "xtick.color": "white",
        "ytick.color": "white",
        "text.color": "white",
        "axes.titlecolor": "white"
    }
)

# Load data
# Load data
df = load_data("data/EURUSD_M5.csv")

print(df.columns)

df.set_index("time", inplace=True)

engine = ReplayEngine(df)
import os

STRATEGY_NAME = "impulse_candle"

STRATEGY_FOLDER = os.path.join(
    "strategies",
    STRATEGY_NAME
)

SESSION_FILE = os.path.join(
    STRATEGY_FOLDER,
    "session.pkl"
)
TRADE_FILE = os.path.join(
    STRATEGY_FOLDER,
    "trades.csv"
)
trade_logger = TradeLogger(TRADE_FILE)
trade_manager = TradeManager(trade_logger)
drawing_manager = DrawingManager()




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
fig = plt.figure(figsize=(11, 6.5))

playing = False
buy_mode = False
sell_mode = False
trade_step = 0

entry_price = None
stop_loss = None
take_profit = None
trade_candle = None
info_box = None
line_mode = False
line_start = None
hovered_candle = None
horizontal_mode = False
candle_info_mode = True
def update(frame):
    global playing

    if playing:

        engine.next_candle()

        candle = engine.current_data(1).iloc[-1]

        trade_manager.update_trades(candle)

    draw_chart()
def on_click(event):

    global buy_mode, sell_mode, line_mode, line_start, horizontal_mode, entry_price, stop_loss, take_profit, trade_step, trade_candle

    if event.inaxes is None:
        return
    if horizontal_mode:

        drawing_manager.add_horizontal_line(event.ydata)

        horizontal_mode = False

        draw_chart()
        plt.draw()

        return
    if line_mode:

        chart = engine.current_data(100)

        visible_index = int(round(event.xdata))
        visible_index = max(0, min(visible_index, len(chart)-1))

        candle = chart.iloc[visible_index]

        point = (
          candle.name,
          event.ydata
        )

        if line_start is None:

            line_start = point
            print("First point selected.")

        else:

            drawing_manager.add_line(
               line_start,
               point
           )

            print("Line created.")

            line_start = None
            line_mode = False

        return

    print("---------------------")
    print("xdata:", event.xdata)
    print("ydata:", event.ydata)

    chart = engine.current_data(100)

    print("First candle :", chart.index[0])
    print("Last candle  :", chart.index[-1])

    if not buy_mode and not sell_mode:
        return

    price = round(event.ydata, 5)

    visible_index = int(round(event.xdata))

    visible_index = max(0, min(visible_index, len(chart) - 1))

    candle = chart.iloc[visible_index]

    actual_index = engine.current - len(chart) + visible_index

    print("Actual dataframe index:", actual_index)

    

    if buy_mode or sell_mode:

        if trade_step == 0:

           entry_price = price
           trade_candle = candle
           trade_step = 1

           print(f"\n✓ Entry : {entry_price:.5f}")
           print("Step 2: Click Stop Loss")

           return

        elif trade_step == 1:

           stop_loss = price
           trade_step = 2

           print(f"\n✓ Stop Loss : {stop_loss:.5f}")
           print("Step 3: Click Take Profit")

           return

        elif trade_step == 2:

           take_profit = price

           if buy_mode:

            trade_manager.buy(
                trade_candle,
                entry_price,
                stop_loss,
                take_profit
            )

            buy_mode = False

           elif sell_mode:

            trade_manager.sell(
                trade_candle,
                entry_price,
                stop_loss,
                take_profit
            )

            sell_mode = False

           trade_step = 0
           entry_price = None
           stop_loss = None
           take_profit = None
           trade_candle = None

           return
def draw_chart():
    global info_box
    plt.clf()

    fig = plt.gcf()
    fig.patch.set_facecolor("#1e1e1e")

    ax_price = fig.add_subplot(2, 1, 1)
    ax_price.set_facecolor("#1e1e1e")
    ax_volume = fig.add_subplot(
        2,
        1,
        2,
        sharex=ax_price
    )
    ax_volume.set_facecolor("#1e1e1e")

    chart = engine.current_data(100)
    chart = chart.rename(columns={"tick_volume": "volume"})

    mpf.plot(
        chart,
        type="candle",
        style=style,
        ax=ax_price,
        volume=ax_volume,
        xrotation=0,
        datetime_format="%d %b\n%H:%M"
    )
    drawing_manager.draw(ax_price)
    ax_price.grid(True, linestyle="--", alpha=0.3)
    ax_volume.grid(True, linestyle="--", alpha=0.3)
    ax_price.yaxis.set_major_locator(MaxNLocator(12))
    ax_volume.yaxis.set_major_locator(MaxNLocator(6))
    locator = AutoDateLocator(minticks=8, maxticks=15)

    ax_price.xaxis.set_major_locator(locator)
    ax_volume.xaxis.set_major_locator(locator)
    ax_price.tick_params(axis="x", labelsize=9, colors="white")
    ax_price.tick_params(axis="y", labelsize=10, colors="white")

    ax_volume.tick_params(axis="x", labelsize=9, colors="white")
    ax_volume.tick_params(axis="y", labelsize=10, colors="white")

    ax_price.set_title(
        f"EURUSD M5 | Candles: {engine.current}",
        color="white"
    )
    for spine in ax_price.spines.values():
        spine.set_color("#666666")

    for spine in ax_volume.spines.values():
        spine.set_color("#666666")
draw_chart()
def update_info_box(event):

    global hovered_candle

    if event.inaxes is None:
        return

    if event.xdata is None:
        return

    chart = engine.current_data(100)
    chart = chart.rename(columns={"tick_volume": "volume"})

    index = int(round(event.xdata))
    index = max(0, min(index, len(chart) - 1))

    hovered_candle = chart.iloc[index]
def on_key(event):
    print(repr(event.key))
    global playing, trade_step, buy_mode, sell_mode

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


        buy_mode = True
        sell_mode = False

        trade_step = 0

        print("\nBUY mode activated.")
        print("Step 1: Click Entry Price")
        

    elif event.key == "n":


        sell_mode = True
        buy_mode = False

        trade_step = 0

        print("\nSELL mode activated.")
        print("Step 1: Click Entry Price")

    elif event.key == "t":

        trade_manager.show_open_trades()
    elif event.key == "c":

        candle = engine.current_data(100).iloc[-1]

        trade_manager.close_last_trade(candle)
    elif event.key == "o":
        print("Statistics shortcut pressed")
        trade_manager.show_statistics(TRADE_FILE)
    elif event.key == "l":

        global line_mode

        line_mode = True

        print("\nLine mode activated.")
        print("Click two points on the chart.")
    elif event.key == "h":

        global horizontal_mode

        horizontal_mode = True

        print("\nHorizontal line mode activated.")
        print("Click on the chart.")
    elif event.key == "backspace":

        drawing_manager.delete_last()

        draw_chart()
        plt.draw()

        print("Last drawing deleted.")
    elif event.key == "delete":

        drawing_manager.clear_all()

        draw_chart()
        plt.draw()

        print("All drawings cleared.")
    elif event.key == "i":

        global hovered_candle

        if hovered_candle is None:
           print("\nMove the mouse over a candle first.\n")
           return

        body = abs(hovered_candle.close - hovered_candle.open) * 10000
        candle_range = (hovered_candle.high - hovered_candle.low) * 10000

        direction = (
            "Bullish"
            if hovered_candle.close >= hovered_candle.open
            else "Bearish"
        )

        print("\n==============================")
        print(f"Time      : {hovered_candle.name}")
        print(f"Direction : {direction}")
        print(f"Open      : {hovered_candle.open:.5f}")
        print(f"High      : {hovered_candle.high:.5f}")
        print(f"Low       : {hovered_candle.low:.5f}")
        print(f"Close     : {hovered_candle.close:.5f}")
        print(f"Body      : {body:.1f} pips")
        print(f"Range     : {candle_range:.1f} pips")
        print(f"Volume    : {int(hovered_candle['volume'])}")
        print("==============================\n")

    elif event.key == "f5":

        session = {
           "current": engine.current,
           "trades": trade_manager.trades,
           "horizontal_lines": drawing_manager.horizontal_lines,
           "lines": drawing_manager.lines
       }

        save_session(
           SESSION_FILE,
            session
       )

        print("\nSession saved.\n")
    elif event.key == "f9":

        session = load_session(SESSION_FILE)

        engine.current = session["current"]

        trade_manager.trades = session["trades"]

        drawing_manager.horizontal_lines = session["horizontal_lines"]

        drawing_manager.lines = session["lines"]

        draw_chart()
        plt.draw()

        print("\nSession loaded.\n")

fig.canvas.mpl_connect("key_press_event", on_key)
fig.canvas.mpl_connect("button_press_event", on_click)
fig.canvas.mpl_connect(
    "motion_notify_event",
    update_info_box
)

ani = FuncAnimation(fig, update, interval=200)

plt.show()