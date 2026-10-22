// Run with:  node --test web/tests/*.test.mjs
// Money on other pairs: GBPUSD is priced like EURUSD; USDJPY's profit is in yen and is converted to dollars
// at the price each amount happens at.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Account, pointValueFor } from "../js/account.js";
import { Side, Status } from "../js/broker.js";

const near = (got, want, message) => assert.ok(Math.abs(got - want) < 1e-6, `${message || "value"}: ${got} vs ${want}`);

test("a point is worth $1 a lot on pairs quoted in dollars, and 100 yen in dollars on USDJPY", () => {
  assert.equal(pointValueFor("EURUSD", 5), 1);
  assert.equal(pointValueFor("GBPUSD", 5), 1);
  const jpy = pointValueFor("USDJPY", 3);
  near(jpy(150000), 100000 / 150000, "at 150.000"); // 100 yen / 150 = $0.667 a point, $6.67 a pip
  near(jpy(100000) * 10, 10, "a pip at 100.000 is $10");
  assert.equal(pointValueFor("AUDUSD", 5), 1); // quoted in dollars, like EURUSD
  const cad = pointValueFor("USDCAD", 5); // profit in Canadian dollars: 1 CAD a point per lot, / price = US dollars
  near(cad(137000), 100000 / 137000, "at 1.37000"); // $0.73 a point, $7.30 a pip
  assert.throws(() => pointValueFor("EURGBP", 5), /needs another rate/);
});

test("USDJPY: the size from risk uses the entry price, and profit is converted at the exit price", () => {
  const account = new Account({ startingBalance: 10000, sizeMode: "risk", riskPercent: 1, commissionPerLot: 4 }, pointValueFor("USDJPY", 3));
  // $100 at risk over a 20-pip (200-point) stop at 150.000: 0.01 lots risks 200 x 0.6667 / 100 = $1.333, so 75 x 0.01 lots
  const sized = account.size(200, 10000, 150000);
  assert.equal(sized.units, 75);
  near(sized.riskMoney, 75 * 200 * (100000 / 150000) / 100, "risk money");
  assert.throws(() => account.money(75, 200), /needs the price/); // never silently priced as if it were EURUSD
  const trade = {
    id: 1, side: Side.SELL, status: Status.CLOSED, entryPrice: 150000, plannedEntry: 150000, plannedRisk: 200,
    exitPrice: 149800, remaining: 1, partials: [],
  };
  account.attach(trade, sized);
  // +200 points on 0.75 lots, converted at the exit (149.800), minus $4 x 0.75 commission
  near(account.realized(trade), 75 * 200 * (100000 / 149800) / 100 - 3, "realized");
  const partly = { ...trade, id: 2, remaining: 0.6, partials: [{ price: 149900, fraction: 0.4 }] };
  account.attach(partly, sized);
  const expected = 75 * (0.4 * 100) * (100000 / 149900) / 100 + 75 * (0.6 * 200) * (100000 / 149800) / 100 - 3;
  near(account.realized(partly), expected, "each part converted at its own price");
  const open = { ...trade, id: 3, status: Status.OPEN, exitPrice: null };
  account.attach(open, sized);
  near(account.unrealized(open, 149700, 0), 75 * 300 * (100000 / 149700) / 100, "open trade at the price now");
});

test("EURUSD money is unchanged: the same numbers with or without a price", () => {
  const account = new Account({ startingBalance: 10000, sizeMode: "risk", riskPercent: 1, commissionPerLot: 4 }, pointValueFor("EURUSD", 5));
  assert.equal(account.size(100, 10000).units, account.size(100, 10000, 108500).units);
  assert.equal(account.money(100, 50), account.money(100, 50, 108500));
});
