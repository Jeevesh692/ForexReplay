// Connects the replay clock to the trading engine.
//
// * Every M5 candle the clock reveals for the first time is fed to the broker,
//   once and in order, whatever timeframe is on screen. So fills, stops and
//   targets are always resolved at 5-minute detail.
// * Orders are accepted only while the replay is live (not while looking back
//   at history), so you cannot enter on a move you have already watched.

import { Broker, InvalidOrder, Side, Status } from "./broker.js";

export class Trading {
  /**
   * @param {object} options { m5: Candles, clock: ReplayClock, pipPoints, minSpreadPoints, onChange() }
   */
  constructor({ m5, clock, pipPoints = 10, minSpreadPoints = 0, onChange = () => {} }) {
    this.m5 = m5;
    this.clock = clock;
    this.pipPoints = pipPoints;
    this.minSpreadPoints = minSpreadPoints;
    this.onChange = onChange;
    this.broker = this.newBroker();
    clock.onReveal((from, to) => this.reveal(from, to));
  }

  newBroker() {
    return new Broker({ spreadPoints: this.minSpreadPoints, onClose: () => {}, onFill: () => {} });
  }

  /** Start a fresh run (called when a new replay starts). */
  reset() {
    this.broker = this.newBroker();
    this.onChange();
  }

  setMinSpread(points) {
    this.minSpreadPoints = Math.max(0, Math.round(points));
    this.broker.spread = this.minSpreadPoints;
    this.onChange();
  }

  reveal(from, to) {
    const m = this.m5;
    for (let i = from; i < to; i++) {
      this.broker.processCandle(i, m.open[i], m.high[i], m.low[i], m.spread[i]);
    }
    this.onChange();
  }

  /** Index of the last revealed M5 candle: "now". */
  get nowIndex() { return this.clock.position - 1; }

  /** Current bid: the close of the last revealed candle. */
  get bid() { return this.m5.close[this.nowIndex]; }

  /** Spread that applies right now, in points. */
  get spread() { return Math.max(this.minSpreadPoints, this.m5.spread[this.nowIndex]); }

  get ask() { return this.bid + this.spread; }

  /** Why trading is not possible right now, or null when it is. */
  get blockedReason() {
    if (!this.clock.active) return "Start a replay to trade.";
    if (!this.clock.live) return "You are viewing history. Press End to return to the live candle.";
    if (this.clock.finished) return "The replay has reached the end of the data.";
    return null;
  }

  ensureCanTrade() {
    const reason = this.blockedReason;
    if (reason) throw new InvalidOrder(reason);
  }

  /**
   * Place an order. Prices are in points.
   * order = { side, type: "market" | "pending", price?, stopLoss, takeProfit }
   */
  place({ side, type, price, stopLoss, takeProfit }) {
    this.ensureCanTrade();
    for (const [name, value] of [["Stop loss", stopLoss], ["Take profit", takeProfit], ...(type === "pending" ? [["Entry price", price]] : [])]) {
      if (!Number.isInteger(value) || value <= 0) throw new InvalidOrder(`${name} is not a valid price.`);
    }
    const trade = type === "market"
      ? this.broker.marketOrder(side, stopLoss, takeProfit, this.nowIndex, this.bid)
      : this.broker.pendingOrder(side, price, stopLoss, takeProfit, this.nowIndex, this.bid);
    this.onChange();
    return trade;
  }

  find(id) {
    return this.broker.trades.find((t) => t.id === id);
  }

  closeTrade(id) {
    this.ensureCanTrade();
    this.broker.close(this.find(id), this.nowIndex, this.bid);
    this.onChange();
  }

  cancelOrder(id) {
    this.ensureCanTrade();
    this.broker.cancel(this.find(id));
    this.onChange();
  }

  /** Close every open trade at market and cancel every pending order (used when leaving a replay). */
  flatten() {
    for (const t of this.broker.openTrades) this.broker.close(t, this.nowIndex, this.bid);
    for (const t of this.broker.pendingOrders) this.broker.cancel(t);
    this.onChange();
  }

  get activeCount() {
    return this.broker.trades.filter((t) => t.isActive).length;
  }

  /** Floating result of an open trade in R, at the current price. */
  floatingR(trade) {
    if (trade.status !== Status.OPEN) return null;
    return trade.floatingPoints(this.bid, this.spread) / trade.plannedRisk;
  }

  pips(points) {
    return points / this.pipPoints;
  }

  summary() {
    const closed = this.broker.closedTrades;
    const results = closed.map((t) => t.resultR);
    return {
      open: this.broker.openTrades.length,
      pending: this.broker.pendingOrders.length,
      closed: closed.length,
      wins: results.filter((r) => r > 0.05).length,
      losses: results.filter((r) => r < -0.05).length,
      totalR: results.reduce((a, b) => a + b, 0),
    };
  }
}

export { InvalidOrder, Side, Status };
