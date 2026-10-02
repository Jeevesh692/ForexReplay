// The trading panel on the right: order ticket, active trades, closed trades.
// All logic lives in trading.js / broker.js; this file only reads the form,
// calls them, and draws the result.

import { ExitReason, OrderType } from "./broker.js";
import { InvalidOrder, Side, Status } from "./trading.js";
import { formatDateTime } from "./time.js";

const REASON_LABEL = {
  [ExitReason.STOP_LOSS]: "stop loss",
  [ExitReason.TAKE_PROFIT]: "take profit",
  [ExitReason.MANUAL]: "closed by you",
};
const PICK_LABEL = { price: "entry price", stopLoss: "stop loss", takeProfit: "take profit" };

export class TradingPanel {
  /**
   * @param {HTMLElement} root   the panel element
   * @param {object} options { trading, m5, digits, onPickChange(label | null) }
   */
  constructor(root, { trading, m5, digits, onPickChange }) {
    this.root = root;
    this.trading = trading;
    this.m5 = m5;
    this.digits = digits;
    this.scale = 10 ** digits;
    this.onPickChange = onPickChange;
    this.side = Side.BUY;
    this.type = "market";
    this.pickTarget = null; // which field the next chart click fills in
    this.touched = false; // has the user edited the prices since the last reset?
    this.message = { text: "", tone: "" };

    this.el = (id) => root.querySelector(`#${id}`);
    this.inputs = { price: this.el("order-price"), stopLoss: this.el("order-sl"), takeProfit: this.el("order-tp") };

    root.addEventListener("click", (event) => this.handleClick(event));
    root.addEventListener("input", (event) => {
      if (Object.values(this.inputs).includes(event.target)) {
        this.touched = true;
        this.renderTicket();
      }
    });
    this.el("order-spread").addEventListener("change", (event) => {
      const pips = Math.max(0, Number(event.target.value) || 0);
      trading.setMinSpread(pips * trading.pipPoints);
    });
    this.render();
  }

  // ----- helpers ----------------------------------------------------------
  toPoints(text) {
    const value = Number(text);
    return text.trim() === "" || !Number.isFinite(value) ? NaN : Math.round(value * this.scale);
  }

  price(points) { return (points / this.scale).toFixed(this.digits); }
  pips(points) { return (points / this.trading.pipPoints).toFixed(1); }
  r(value) { return `${value >= 0 ? "+" : ""}${value.toFixed(2)}R`; }

  /** Sensible starting prices: stop 10 pips away, target 20 pips away. */
  fillDefaults() {
    if (this.trading.blockedReason) return;
    const dir = this.side === Side.BUY ? 1 : -1;
    const entry = this.side === Side.BUY ? this.trading.ask : this.trading.bid;
    const pip = this.trading.pipPoints;
    this.inputs.price.value = this.price(entry);
    this.inputs.stopLoss.value = this.price(entry - dir * 10 * pip);
    this.inputs.takeProfit.value = this.price(entry + dir * 20 * pip);
    this.touched = false;
  }

  setPick(target) {
    this.pickTarget = target;
    this.onPickChange(target ? PICK_LABEL[target] : null);
    this.root.querySelectorAll("[data-pick]").forEach((b) => b.classList.toggle("active", b.dataset.pick === target));
  }

  /** Called by the chart when the user clicks it while a pick is waiting. */
  receivePrice(points) {
    if (!this.pickTarget) return false;
    this.inputs[this.pickTarget].value = this.price(points);
    if (this.pickTarget === "price") this.type = "pending";
    this.touched = true;
    this.setPick(null);
    this.render();
    return true;
  }

  say(text, tone = "") {
    this.message = { text, tone };
    const box = this.el("order-message");
    box.textContent = text;
    box.className = `order-message ${tone}`;
  }

  // ----- actions ----------------------------------------------------------
  handleClick(event) {
    const target = event.target.closest("button");
    if (!target) return;
    if (target.dataset.side) {
      this.side = target.dataset.side;
      this.fillDefaults();
      this.say("");
      this.render();
    } else if (target.dataset.type) {
      this.type = target.dataset.type;
      this.render();
    } else if (target.dataset.pick) {
      this.setPick(this.pickTarget === target.dataset.pick ? null : target.dataset.pick);
    } else if (target.id === "order-place") {
      this.place();
    } else if (target.dataset.close) {
      this.attempt(() => this.trading.closeTrade(Number(target.dataset.close)));
    } else if (target.dataset.cancel) {
      this.attempt(() => this.trading.cancelOrder(Number(target.dataset.cancel)));
    }
  }

  attempt(action) {
    try {
      action();
      this.say("");
    } catch (err) {
      this.say(err.message, "bad");
    }
  }

  place() {
    try {
      const trade = this.trading.place({
        side: this.side,
        type: this.type,
        price: this.type === "pending" ? this.toPoints(this.inputs.price.value) : undefined,
        stopLoss: this.toPoints(this.inputs.stopLoss.value),
        takeProfit: this.toPoints(this.inputs.takeProfit.value),
      });
      const what = trade.orderType === OrderType.MARKET
        ? "market order placed; it fills at the next candle's open"
        : `${trade.orderType.toLowerCase()} order placed at ${this.price(trade.orderPrice)}`;
      this.touched = false; // the next order starts again from prices around the market
      this.say(`#${trade.id} ${trade.side} ${what}.`, "ok");
    } catch (err) {
      if (!(err instanceof InvalidOrder)) throw err;
      this.say(err.message, "bad");
    }
  }

  // ----- drawing ----------------------------------------------------------
  render() {
    this.renderTicket();
    this.renderTrades();
  }

  renderTicket() {
    const t = this.trading;
    const blocked = t.blockedReason;
    this.root.classList.toggle("blocked", !!blocked);
    this.el("order-status").textContent = blocked ||
      `Live · bid ${this.price(t.bid)} · ask ${this.price(t.ask)} · spread ${this.pips(t.spread)} pips`;

    if (!blocked && !this.touched) this.fillDefaults();

    this.root.querySelectorAll("[data-side]").forEach((b) => b.classList.toggle("active", b.dataset.side === this.side));
    this.root.querySelectorAll("[data-type]").forEach((b) => b.classList.toggle("active", b.dataset.type === this.type));
    this.el("order-price-row").hidden = this.type !== "pending";

    const entry = this.type === "pending" ? this.toPoints(this.inputs.price.value)
      : (blocked ? NaN : (this.side === Side.BUY ? t.ask : t.bid));
    const sl = this.toPoints(this.inputs.stopLoss.value);
    const tp = this.toPoints(this.inputs.takeProfit.value);
    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);
    this.el("order-sl-note").textContent = Number.isFinite(risk) ? `${this.pips(risk)} pips risk` : "";
    this.el("order-tp-note").textContent = Number.isFinite(reward) && risk > 0
      ? `${this.pips(reward)} pips · ${(reward / risk).toFixed(2)}R` : "";

    const button = this.el("order-place");
    button.disabled = !!blocked;
    button.textContent = `${this.side === Side.BUY ? "Buy" : "Sell"} ${this.type === "market" ? "at market" : "at price"}`;
    button.className = `order-place ${this.side === Side.BUY ? "buy" : "sell"}`;
  }

  tradeTime(index) {
    return formatDateTime(this.m5.time[index]).split(" ").slice(1).join(" "); // drop the weekday to save space
  }

  renderTrades() {
    const t = this.trading;
    const active = t.broker.trades.filter((trade) => trade.isActive);
    this.el("active-title").textContent = `Open and pending (${active.length})`;
    this.el("active-list").innerHTML = active.length === 0
      ? '<li class="empty">No open trades or orders.</li>'
      : active.map((trade) => {
        const tone = trade.side === Side.BUY ? "up" : "down";
        if (trade.status === Status.PENDING) {
          const at = trade.orderType === OrderType.MARKET ? "fills next candle" : `at ${this.price(trade.orderPrice)}`;
          return `<li><div class="row"><span class="${tone}">#${trade.id} ${trade.side} ${trade.orderType}</span>` +
            `<button class="plain small" data-cancel="${trade.id}">Cancel</button></div>` +
            `<div class="sub">${at} · SL ${this.price(trade.stopLoss)} · TP ${this.price(trade.takeProfit)}</div></li>`;
        }
        const floating = t.floatingR(trade);
        return `<li><div class="row"><span class="${tone}">#${trade.id} ${trade.side} open</span>` +
          `<span class="${floating >= 0 ? "up" : "down"}">${this.r(floating)}</span>` +
          `<button class="plain small" data-close="${trade.id}">Close</button></div>` +
          `<div class="sub">in at ${this.price(trade.entryPrice)} · SL ${this.price(trade.stopLoss)} · TP ${this.price(trade.takeProfit)}</div></li>`;
      }).join("");

    const closed = t.broker.closedTrades.slice().reverse();
    const s = t.summary();
    this.el("closed-title").textContent = `Closed (${s.closed})` +
      (s.closed ? ` · ${this.r(s.totalR)} · ${s.wins}W ${s.losses}L` : "");
    this.el("closed-list").innerHTML = closed.length === 0
      ? '<li class="empty">Closed trades appear here.</li>'
      : closed.map((trade) =>
        `<li><div class="row"><span>#${trade.id} ${trade.side}</span>` +
        `<span class="${trade.resultR >= 0 ? "up" : "down"}">${this.r(trade.resultR)}</span></div>` +
        `<div class="sub">${REASON_LABEL[trade.exitReason]} · ${this.tradeTime(trade.entryTime)} → ${this.tradeTime(trade.exitTime).split(", ")[1]}` +
        ` · best ${this.r(trade.mfeR)}</div></li>`).join("");
  }
}
