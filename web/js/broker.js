// Order execution simulator: a rule-for-rule port of forex_replay/broker.py.
//
// All prices are whole numbers of POINTS (1.08500 -> 108500), so comparisons
// are exact. Candle prices are BID prices. Buys fill at the ASK (bid + spread)
// and close at the bid; sells fill at the bid and close at the ask.
//
// Fill rules (decided on closed M5 candles, so nothing can see the future):
//  * Orders are only evaluated on candles AFTER the one they were placed on.
//    A market order fills at the next candle's open.
//  * Limit / stop orders fill when a later candle trades through their price.
//    If the candle opens beyond the price (a gap), the fill is at the open.
//  * If stop loss and take profit are both inside one candle, the stop loss
//    is assumed to be hit first (the conservative assumption).
//  * On the candle a limit/stop order fills, only the stop loss can trigger,
//    because the order of prices inside that candle is unknown. Market orders
//    fill at the open, so the whole candle counts for them.
//  * R uses the planned risk |planned entry - stop loss|, so slippage from a
//    gap shows up as a result worse than -1R, as it would live.
//
// web/tests/broker.test.mjs replays 100 scenarios recorded from the Python
// engine and requires identical results.

export const Side = Object.freeze({ BUY: "BUY", SELL: "SELL" });
export const OrderType = Object.freeze({ MARKET: "MARKET", LIMIT: "LIMIT", STOP: "STOP" });
export const Status = Object.freeze({ PENDING: "PENDING", OPEN: "OPEN", CLOSED: "CLOSED", CANCELLED: "CANCELLED" });
export const ExitReason = Object.freeze({ STOP_LOSS: "STOP_LOSS", TAKE_PROFIT: "TAKE_PROFIT", MANUAL: "MANUAL" });

export class InvalidOrder extends Error {}

const direction = (side) => (side === Side.BUY ? 1 : -1);

export class Trade {
  constructor({ id, side, orderType, stopLoss, takeProfit, placedTime, plannedEntry, orderPrice = null }) {
    this.id = id;
    this.side = side;
    this.orderType = orderType;
    this.stopLoss = stopLoss;
    this.takeProfit = takeProfit;
    this.placedTime = placedTime;
    this.plannedEntry = plannedEntry;
    this.orderPrice = orderPrice; // null for market orders
    this.status = Status.PENDING;
    this.entryPrice = null;
    this.entryTime = null;
    this.exitPrice = null;
    this.exitTime = null;
    this.exitReason = null;
    this.bestPrice = null; // most favourable exit-side price while open
    this.worstPrice = null; // most adverse exit-side price while open
    this.filledAtOpen = false;
  }

  get plannedRisk() { return Math.abs(this.plannedEntry - this.stopLoss); }
  get plannedRewardR() { return Math.abs(this.takeProfit - this.plannedEntry) / this.plannedRisk; }

  get pnl() {
    if (this.exitPrice === null || this.entryPrice === null) return null;
    return (this.exitPrice - this.entryPrice) * direction(this.side);
  }

  get resultR() {
    const pnl = this.pnl;
    return pnl === null ? null : pnl / this.plannedRisk;
  }

  /** Maximum favourable excursion in R: how far it went in your favour. */
  get mfeR() {
    if (this.bestPrice === null || this.entryPrice === null) return null;
    return Math.max(0, ((this.bestPrice - this.entryPrice) * direction(this.side)) / this.plannedRisk);
  }

  /** Maximum adverse excursion in R: how far it went against you. */
  get maeR() {
    if (this.worstPrice === null || this.entryPrice === null) return null;
    return Math.max(0, ((this.entryPrice - this.worstPrice) * direction(this.side)) / this.plannedRisk);
  }

  /** Profit or loss in points if closed at `bid` now (for open trades). */
  floatingPoints(bid, spread = 0) {
    if (this.status !== Status.OPEN) return null;
    const exit = this.side === Side.BUY ? bid : bid + spread;
    return (exit - this.entryPrice) * direction(this.side);
  }

  get isActive() { return this.status === Status.PENDING || this.status === Status.OPEN; }
}

export class Broker {
  /** @param {object} options { spreadPoints, onClose(trade), onFill(trade) } */
  constructor({ spreadPoints = 0, onClose = null, onFill = null } = {}) {
    this.spread = spreadPoints;
    this.onClose = onClose;
    this.onFill = onFill;
    this.trades = [];
    this.nextId = 1;
  }

  get pendingOrders() { return this.trades.filter((t) => t.status === Status.PENDING); }
  get openTrades() { return this.trades.filter((t) => t.status === Status.OPEN); }
  get closedTrades() { return this.trades.filter((t) => t.status === Status.CLOSED); }

  /** Price you would get entering now: ask for buys, bid for sells. */
  entryQuote(side, bid, spread = this.spread) { return side === Side.BUY ? bid + spread : bid; }

  /** Price you would get exiting now: bid for buys, ask for sells. */
  exitQuote(side, bid, spread = this.spread) { return side === Side.BUY ? bid : bid + spread; }

  // ----- order entry ------------------------------------------------------
  /** Queue a market order; it fills at the next candle's open. */
  marketOrder(side, stopLoss, takeProfit, time, bid) {
    const expected = this.entryQuote(side, bid);
    Broker.validate(side, expected, stopLoss, takeProfit);
    return this.add(new Trade({
      id: this.nextId++, side, orderType: OrderType.MARKET, stopLoss, takeProfit,
      placedTime: time, plannedEntry: expected,
    }));
  }

  /** Place a limit or stop order; the type is inferred from the current price. */
  pendingOrder(side, price, stopLoss, takeProfit, time, bid) {
    Broker.validate(side, price, stopLoss, takeProfit);
    const quote = this.entryQuote(side, bid);
    const orderType = side === Side.BUY
      ? (price <= quote ? OrderType.LIMIT : OrderType.STOP)
      : (price >= quote ? OrderType.LIMIT : OrderType.STOP);
    return this.add(new Trade({
      id: this.nextId++, side, orderType, stopLoss, takeProfit,
      placedTime: time, plannedEntry: price, orderPrice: price,
    }));
  }

  cancel(trade) {
    if (trade.status !== Status.PENDING) {
      throw new Error(`Trade ${trade.id} is ${trade.status}, only pending orders can be cancelled`);
    }
    trade.status = Status.CANCELLED;
  }

  /** Close an open trade at the current market price. */
  close(trade, time, bid, reason = ExitReason.MANUAL) {
    if (trade.status !== Status.OPEN) {
      throw new Error(`Trade ${trade.id} is ${trade.status}, only open trades can be closed`);
    }
    this.exit(trade, time, this.exitQuote(trade.side, bid), reason);
  }

  // ----- candle processing ------------------------------------------------
  /**
   * Resolve fills and exits for one new candle (bid open, high, low).
   * `candleSpread` (points) is the broker's recorded spread for this candle; the
   * larger of it and the configured minimum spread is used.
   * Returns the trades closed on this candle.
   */
  processCandle(time, o, h, l, candleSpread = 0) {
    const spread = Math.max(this.spread, candleSpread);
    const closed = [];
    for (const trade of this.trades) {
      if (trade.status === Status.PENDING) {
        if (!this.tryFill(trade, time, o, h, l, spread)) continue;
        if (this.onFill) this.onFill(trade);
        const wholeCandle = trade.orderType === OrderType.MARKET;
        if (wholeCandle) this.trackExcursion(trade, h, l, spread);
        if (this.checkExit(trade, time, o, h, l, spread, wholeCandle, !wholeCandle)) closed.push(trade);
      } else if (trade.status === Status.OPEN) {
        this.trackExcursion(trade, h, l, spread);
        if (this.checkExit(trade, time, o, h, l, spread, true, false)) closed.push(trade);
      }
    }
    return closed;
  }

  // ----- internals --------------------------------------------------------
  add(trade) {
    this.trades.push(trade);
    return trade;
  }

  static validate(side, entry, stopLoss, takeProfit) {
    if (side === Side.BUY && !(stopLoss < entry && entry < takeProfit)) {
      throw new InvalidOrder("A buy needs the stop loss below the entry and the take profit above it.");
    }
    if (side === Side.SELL && !(takeProfit < entry && entry < stopLoss)) {
      throw new InvalidOrder("A sell needs the stop loss above the entry and the take profit below it.");
    }
  }

  tryFill(trade, time, o, h, l, spread) {
    if (trade.side === Side.BUY) { // buys fill at the ask
      o += spread; h += spread; l += spread;
    }
    const price = trade.orderPrice;
    let fill = null;
    trade.filledAtOpen = false;

    if (trade.orderType === OrderType.MARKET) fill = o;
    else if (trade.side === Side.BUY && trade.orderType === OrderType.LIMIT && l <= price) fill = Math.min(price, o);
    else if (trade.side === Side.BUY && trade.orderType === OrderType.STOP && h >= price) fill = Math.max(price, o);
    else if (trade.side === Side.SELL && trade.orderType === OrderType.LIMIT && h >= price) fill = Math.max(price, o);
    else if (trade.side === Side.SELL && trade.orderType === OrderType.STOP && l <= price) fill = Math.min(price, o);

    if (fill === null) return false;
    trade.status = Status.OPEN;
    trade.entryPrice = fill;
    trade.entryTime = time;
    trade.bestPrice = trade.worstPrice = fill;
    trade.filledAtOpen = fill === o;
    return true;
  }

  /** Excursions are measured on the exit-side quote and capped at SL / TP. */
  trackExcursion(trade, h, l, spread) {
    h = this.exitQuote(trade.side, h, spread);
    l = this.exitQuote(trade.side, l, spread);
    if (trade.side === Side.BUY) {
      trade.bestPrice = Math.max(trade.bestPrice, Math.min(h, trade.takeProfit));
      trade.worstPrice = Math.min(trade.worstPrice, Math.max(l, trade.stopLoss));
    } else {
      trade.bestPrice = Math.min(trade.bestPrice, Math.max(l, trade.takeProfit));
      trade.worstPrice = Math.max(trade.worstPrice, Math.min(h, trade.stopLoss));
    }
  }

  checkExit(trade, time, o, h, l, spread, allowTp, fillCandle) {
    o = this.exitQuote(trade.side, o, spread);
    h = this.exitQuote(trade.side, h, spread);
    l = this.exitQuote(trade.side, l, spread);
    // A gap through a level only fills at the open if the trade existed at the open.
    const gapOk = !fillCandle || trade.filledAtOpen;

    if (trade.side === Side.BUY) {
      if (l <= trade.stopLoss) {
        this.exit(trade, time, gapOk ? Math.min(trade.stopLoss, o) : trade.stopLoss, ExitReason.STOP_LOSS);
        return true;
      }
      if (allowTp && h >= trade.takeProfit) {
        this.exit(trade, time, Math.max(trade.takeProfit, o), ExitReason.TAKE_PROFIT);
        return true;
      }
    } else {
      if (h >= trade.stopLoss) {
        this.exit(trade, time, gapOk ? Math.max(trade.stopLoss, o) : trade.stopLoss, ExitReason.STOP_LOSS);
        return true;
      }
      if (allowTp && l <= trade.takeProfit) {
        this.exit(trade, time, Math.min(trade.takeProfit, o), ExitReason.TAKE_PROFIT);
        return true;
      }
    }
    return false;
  }

  exit(trade, time, price, reason) {
    trade.status = Status.CLOSED;
    trade.exitPrice = price;
    trade.exitTime = time;
    trade.exitReason = reason;
    trade.filledAtOpen = false;
    // Make sure the excursion reflects the actual exit (e.g. a gap past the stop).
    if (trade.bestPrice !== null) {
      if (trade.side === Side.BUY) {
        trade.bestPrice = Math.max(trade.bestPrice, price);
        trade.worstPrice = Math.min(trade.worstPrice, price);
      } else {
        trade.bestPrice = Math.min(trade.bestPrice, price);
        trade.worstPrice = Math.max(trade.worstPrice, price);
      }
    }
    if (this.onClose) this.onClose(trade);
  }
}
