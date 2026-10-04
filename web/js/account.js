// The account: turns the engine's price results into money.
//
// The trading engine (broker.js) knows only prices and R. This file adds the
// part a broker statement shows: lot size, profit and loss in dollars,
// commission, balance and equity. Keeping it separate means the fill rules
// stay small and provable, and the money rules can be read on their own.
//
// Assumptions (EURUSD on a US-dollar account):
//  * 1 standard lot = 100,000 units, so one point (0.00001) is worth $1 per lot
//    and one pip (0.0001) is worth $10 per lot.
//  * Lots come in steps of 0.01. A size worked out from risk is rounded DOWN,
//    so the money at risk is never more than you asked for.
//  * Commission is a round-turn charge per lot, taken in full when the trade
//    opens (as MT5 raw-spread accounts do). It is not part of the risk used
//    for sizing: a full stop-out costs the risk plus the commission.
//  * Margin and leverage are not modelled.

import { Side, Status } from "./broker.js";

export const CONTRACT_SIZE = 100000;
export const LOT_UNITS = 100; // sizes are whole numbers of 0.01 lots, so they never pick up rounding errors
export const STORAGE_KEY = "forexreplay.account";

export const DEFAULT_SETTINGS = Object.freeze({
  version: 2,
  startingBalance: 10000,
  sizeMode: "risk", // "risk": size from a % of the balance; "lots": a fixed size
  riskPercent: 1,
  fixedLots: 0.1,
  commissionPerLot: 4, // $ per lot, round turn (Jeevesh's broker)
  minSpreadPips: 0,
});

const LIMITS = {
  startingBalance: [1, 1000000000], // any balance you like, from $1 to $1 billion
  riskPercent: [0.01, 100],
  fixedLots: [0.01, 1000],
  commissionPerLot: [0, 1000],
  minSpreadPips: [0, 1000],
};

/** Fill gaps and replace nonsense with defaults, so a damaged saved value can never break the app. */
export function cleanSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== "object") return out;
  // Settings saved on day 5 carried that day's guessed commission of $7. Replace the guess, keep a deliberate choice.
  if (!raw.version && Number(raw.commissionPerLot) === 7) raw = { ...raw, commissionPerLot: DEFAULT_SETTINGS.commissionPerLot };
  for (const [key, [low, high]] of Object.entries(LIMITS)) {
    const value = Number(raw[key]);
    if (raw[key] !== null && raw[key] !== "" && Number.isFinite(value) && value >= low && value <= high) out[key] = value;
  }
  if (raw.sizeMode === "risk" || raw.sizeMode === "lots") out.sizeMode = raw.sizeMode;
  out.fixedLots = Math.round(out.fixedLots * LOT_UNITS) / LOT_UNITS;
  return out;
}

export function loadSettings() {
  try { return cleanSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null")); } catch { return cleanSettings(null); }
}

export function saveSettings(settings) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* private mode: not saved */ }
}

/** Dollars per point of price movement for one lot. EURUSD with 5 digits: $1. */
export function pointValuePerLot(digits) {
  return CONTRACT_SIZE / 10 ** digits;
}

/**
 * Largest size, in units of 0.01 lots, whose loss at the stop is no more than the chosen risk.
 * Returns 0 when even 0.01 lots would risk more than that.
 */
export function unitsForRisk({ balance, riskPercent, riskPoints, pointValue }) {
  if (!(balance > 0) || !(riskPercent > 0) || !(riskPoints > 0)) return 0;
  const riskMoney = balance * riskPercent / 100;
  const perUnit = riskPoints * pointValue / LOT_UNITS; // loss at the stop for 0.01 lots
  return Math.floor(riskMoney / perUnit + 1e-9);
}

export const formatMoney = (value) => {
  const text = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${value < -0.004 ? "-" : ""}$${text}`;
};
export const formatSignedMoney = (value) => (value >= 0.005 ? "+" : "") + formatMoney(value);
export const formatLots = (units) => (units / LOT_UNITS).toFixed(2);

export class Account {
  /**
   * @param {object} settings  see DEFAULT_SETTINGS
   * @param {number} pointValue  dollars per point per lot
   */
  constructor(settings, pointValue) {
    this.settings = cleanSettings(settings);
    this.pointValue = pointValue;
    this.sizes = new Map(); // trade id -> { units, commissionPerLot, riskPercent | null }
  }

  /** Forget every trade (a new replay run). Settings are kept. */
  reset() {
    this.sizes.clear();
  }

  update(changes) {
    this.settings = cleanSettings({ ...this.settings, ...changes });
    return this.settings;
  }

  /**
   * Work out the size for a new order with `riskPoints` between entry and stop.
   * Returns { units, riskMoney, commission, riskPercent } or { error }.
   */
  size(riskPoints, balance) {
    const s = this.settings;
    if (!(riskPoints > 0)) return { error: "The stop loss must be away from the entry." };
    let units;
    if (s.sizeMode === "lots") {
      units = Math.round(s.fixedLots * LOT_UNITS);
    } else {
      units = unitsForRisk({ balance, riskPercent: s.riskPercent, riskPoints, pointValue: this.pointValue });
      if (units < 1) {
        const wanted = formatMoney(balance * s.riskPercent / 100);
        const smallest = formatMoney(riskPoints * this.pointValue / LOT_UNITS);
        return { error: `Risking ${s.riskPercent}% (${wanted}) is too little for this stop: even 0.01 lots would risk ${smallest}.` };
      }
    }
    return {
      units,
      riskMoney: this.money(units, riskPoints),
      commission: this.commissionFor(units, s.commissionPerLot),
      riskPercent: s.sizeMode === "risk" ? s.riskPercent : null,
    };
  }

  /** Dollars for `points` of price movement on `units` x 0.01 lots. */
  money(units, points) {
    return units * points * this.pointValue / LOT_UNITS;
  }

  commissionFor(units, perLot) {
    return units * perLot / LOT_UNITS;
  }

  /** Remember the size of a trade the engine has just accepted. */
  attach(trade, sized) {
    this.sizes.set(trade.id, {
      units: sized.units, commissionPerLot: this.settings.commissionPerLot, riskPercent: sized.riskPercent,
    });
  }

  sizeOf(trade) {
    return this.sizes.get(trade.id) || { units: 0, commissionPerLot: 0, riskPercent: null };
  }

  units(trade) { return this.sizeOf(trade).units; }

  /** Units still open (whole 0.01 lots). */
  openUnits(trade) { return Math.round(this.units(trade) * trade.remaining); }

  /** A trade that never filled pays nothing. */
  commission(trade) {
    const size = this.sizeOf(trade);
    return trade.entryPrice === null ? 0 : this.commissionFor(size.units, size.commissionPerLot);
  }

  /** Money at risk between the planned entry and the stop that defines 1R. */
  riskMoney(trade) {
    return this.money(this.units(trade), trade.plannedRisk);
  }

  /** Money already banked: closed parts (or the whole trade once closed), minus commission. */
  realized(trade) {
    if (trade.entryPrice === null) return 0;
    const points = trade.status === Status.CLOSED ? trade.pnl : trade.realized;
    return this.money(this.units(trade), points) - this.commission(trade);
  }

  /** Profit or loss of the part still open, at the current price. */
  unrealized(trade, bid, spread) {
    if (trade.status !== Status.OPEN) return 0;
    const exit = trade.side === Side.BUY ? bid : bid + spread;
    const direction = trade.side === Side.BUY ? 1 : -1;
    return this.money(this.units(trade), trade.remaining * ((exit - trade.entryPrice) * direction));
  }

  /** What the trade is worth in total right now (or was worth when it closed), after commission. */
  net(trade, bid, spread) {
    return this.realized(trade) + this.unrealized(trade, bid, spread);
  }

  balance(trades) {
    let total = this.settings.startingBalance;
    for (const trade of trades) total += this.realized(trade);
    return total;
  }

  equity(trades, bid, spread) {
    let total = this.balance(trades);
    for (const trade of trades) total += this.unrealized(trade, bid, spread);
    return total;
  }

  /**
   * Turn "close this % of what is open" into a share of the original size, in whole 0.01 lots.
   * Returns { fraction, units } or { error }.
   */
  partial(trade, percent) {
    const open = this.openUnits(trade);
    const closing = Math.round(open * percent / 100);
    if (closing < 1 || closing >= open) {
      return { error: `${formatLots(open)} lots is too small to close ${percent}% of. Use Close to close all of it.` };
    }
    return { fraction: closing / this.units(trade), units: closing };
  }
}
