// Connects the replay clock to the trading engine.
//
// * Every M5 candle the clock reveals for the first time is fed to the broker,
//   once and in order, whatever timeframe is on screen. So fills, stops and
//   targets are always resolved at 5-minute detail.
// * Orders are accepted only while the replay is live (not while looking back
//   at history), so you cannot enter on a move you have already watched.
//   The same goes for closing, moving a stop or anything else that changes a trade.
// * The account (account.js) turns the engine's price results into lots and dollars.

import { Account, DEFAULT_SETTINGS } from "./account.js";
import { Broker, InvalidOrder, OrderType, Side, Status } from "./broker.js";

export class Trading {
  /**
   * @param {object} options { m5: Candles, clock: ReplayClock, pipPoints, pointValue, settings, onChange() }
   *   pointValue: dollars per point per lot. settings: account settings (see account.js).
   */
  constructor({ m5, clock, pipPoints = 10, pointValue = 1, settings = DEFAULT_SETTINGS, onChange = () => {} }) {
    this.m5 = m5;
    this.clock = clock;
    this.pipPoints = pipPoints;
    this.account = new Account(settings, pointValue);
    this.minSpreadPoints = Math.round(this.account.settings.minSpreadPips * pipPoints);
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
    this.account.reset();
    this.onChange();
  }

  /** Change account settings (starting balance, risk %, commission, minimum spread...). */
  updateSettings(changes) {
    const settings = this.account.update(changes);
    this.minSpreadPoints = Math.round(settings.minSpreadPips * this.pipPoints);
    this.broker.spread = this.minSpreadPoints;
    this.onChange();
    return settings;
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

  /** Entry price an order would be planned at right now: the quote for a market order, its own price otherwise. */
  plannedEntry({ side, type, price }) {
    return type === "market" ? (side === Side.BUY ? this.ask : this.bid) : price;
  }

  /**
   * Size an order before placing it: { units, riskMoney, commission, riskPercent } or { error }.
   * Sized from the balance (closed results only), as position-size calculators do.
   */
  preview({ side, type, price, stopLoss }) {
    const entry = this.plannedEntry({ side, type, price });
    return this.account.size(Math.abs(entry - stopLoss), this.balance);
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
    Broker.validate(side, this.plannedEntry({ side, type, price }), stopLoss, takeProfit); // wrong-side prices first
    const sized = this.preview({ side, type, price, stopLoss });
    if (sized.error) throw new InvalidOrder(sized.error);
    const trade = type === "market"
      ? this.broker.marketOrder(side, stopLoss, takeProfit, this.nowIndex, this.bid, this.spread)
      : this.broker.pendingOrder(side, price, stopLoss, takeProfit, this.nowIndex, this.bid, this.spread);
    this.account.attach(trade, sized);
    this.onChange();
    return trade;
  }

  find(id) {
    const trade = this.broker.trades.find((t) => t.id === id);
    if (!trade) throw new InvalidOrder(`There is no trade #${id}.`);
    return trade;
  }

  closeTrade(id) {
    this.ensureCanTrade();
    this.broker.close(this.find(id), this.nowIndex, this.bid, undefined, this.spread);
    this.onChange();
  }

  cancelOrder(id) {
    this.ensureCanTrade();
    this.broker.cancel(this.find(id));
    this.onChange();
  }

  /**
   * Move the stop loss, take profit or (pending orders) entry price. Prices in points.
   * A pending order that was sized from risk % is re-sized, so it still risks that %.
   */
  modifyTrade(id, changes) {
    this.ensureCanTrade();
    const trade = this.find(id);
    const names = { stopLoss: "Stop loss", takeProfit: "Take profit", price: "Entry price" };
    for (const [key, value] of Object.entries(changes)) {
      if (!Number.isInteger(value) || value <= 0) throw new InvalidOrder(`${names[key] || key} is not a valid price.`);
    }
    const size = this.account.sizeOf(trade);
    let sized = null;
    if (trade.status === Status.PENDING && size.riskPercent !== null) {
      const entry = trade.orderType === OrderType.MARKET ? trade.plannedEntry : (changes.price ?? trade.orderPrice);
      const stop = changes.stopLoss ?? trade.stopLoss;
      Broker.validate(trade.side, entry, stop, changes.takeProfit ?? trade.takeProfit);
      sized = this.account.size(Math.abs(entry - stop), this.balance);
      if (sized.error) throw new InvalidOrder(sized.error);
    }
    this.broker.modify(trade, this.bid, { price: null, ...changes }, this.spread);
    if (sized) size.units = sized.units;
    this.onChange();
    return trade;
  }

  /** Move the stop of an open trade to its entry price, so the worst case is a scratch (minus commission). */
  breakeven(id) {
    const trade = this.find(id);
    if (trade.status !== Status.OPEN) throw new InvalidOrder("Only an open trade can be moved to breakeven.");
    if (trade.stopLoss === trade.entryPrice) throw new InvalidOrder(`#${id} is already at breakeven.`);
    try {
      return this.modifyTrade(id, { stopLoss: trade.entryPrice });
    } catch (err) {
      if (err instanceof InvalidOrder && !this.blockedReason) {
        throw new InvalidOrder(`#${id} is not in profit, so its stop cannot go to the entry price yet.`);
      }
      throw err;
    }
  }

  /** Close `percent` of what is still open, in whole 0.01 lots. */
  partialClose(id, percent) {
    this.ensureCanTrade();
    const trade = this.find(id);
    if (trade.status !== Status.OPEN) throw new InvalidOrder("Only an open trade can be partly closed.");
    const part = this.account.partial(trade, percent);
    if (part.error) throw new InvalidOrder(part.error);
    this.broker.partialClose(trade, part.fraction, this.nowIndex, this.bid, this.spread);
    this.onChange();
    return part;
  }

  /** Close every open trade at market and cancel every pending order (used when leaving a replay). */
  flatten() {
    for (const t of this.broker.openTrades) this.broker.close(t, this.nowIndex, this.bid, undefined, this.spread);
    for (const t of this.broker.pendingOrders) this.broker.cancel(t);
    this.onChange();
  }

  /** The "Close all" button: the same as flatten, but only while the replay is live. */
  closeAll() {
    this.ensureCanTrade();
    this.flatten();
  }

  // ----- money -------------------------------------------------------------
  /** Starting balance plus everything banked so far. */
  get balance() { return this.account.balance(this.broker.trades); }

  /** Balance plus the floating result of open trades. */
  get equity() {
    return this.clock.active ? this.account.equity(this.broker.trades, this.bid, this.spread) : this.balance;
  }

  /** What a trade is worth in dollars right now (or was when it closed), after commission. */
  money(trade) {
    return trade.status === Status.OPEN ? this.account.net(trade, this.bid, this.spread) : this.account.realized(trade);
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
      totalMoney: closed.reduce((a, t) => a + this.account.realized(t), 0),
    };
  }
}

export { InvalidOrder, OrderType, Side, Status };
