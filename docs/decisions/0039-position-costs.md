# 0039: The position tool with costs (order flow, Phase 7)

- **Date:** 9 Nov 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (the order-flow brief, Phase 7), with Claude on the points the brief left open (marked below)

## What changed

The existing **Long** and **Short** drawings (Alt + L, Alt + S) are the position tool (Claude's call: building on them, not a second tool). Their labels now show:

- **Target line:** pips, R:R, and **R after costs**, e.g. "Target 1.12094 · 20.0 pips · 2.00R · 1.94R after costs".
- **Stop line:** pips and the loss after costs, e.g. "Stop 1.11794 · 10.0 pips · −1.06R after costs".
- **Entry line:** lots, risk in dollars, and the round trip's cost in R and dollars, e.g. "1.00 lots · risk $100.00 · costs 0.06R ($6.00)".
- **A warning line** beyond the stop's label, only when needed:
  - stop under the pair's minimum (EURUSD 6 pips, gold 2.00) or over its maximum (20 pips / 8.00)
  - target under the model's minimum after costs (Model A 2R, Model B 1.5R)

The settings are under **Account settings**:
- **Commission:** the existing $ per lot, plus a new **"charged per side"** box.
- **Under "Position tool":**
  - slippage (0.2 pip)
  - which model's minimum target applies (A, B or none) and the two minimums
  - the stop limits for the pair on screen. A blank maximum means no limit.

## The definition

There is one definition, written twice: `forex_replay/costs.py` and `web/js/costs.js`. They are held to `web/tests/fixtures/costs_golden.json` (240 cases on EURUSD, gold and USDJPY, including wrong-side stops and sizes under 0.01 lots), written by `python -m forex_replay.costs_golden`.

1. **Size** is the account's own rule: the largest whole number of 0.01 lots whose loss at the stop is no more than risk % of the balance. The tool uses the account's risk % (Claude's call), so the drawing and the order ticket never disagree.
   - **Note:** the account's default is 1%, not the brief's 0.5%; the saved setting is what counts.
2. **The cost of a round trip** for one lot = (spread + slippage) × $ per point + commission.
   - **Commission** is $4 a lot round turn, or twice that when "per side" is on.
   - **The spread** (Claude's call) is the spread the data records on the 1-minute candle at the position's entry time, never past the replay's cursor, and at least your minimum spread. That is "the spread at that time". On EURUSD it is often 0 on FundedNext's data.
3. **Cost in R** = that cost ÷ the loss at the stop for one lot. It does not depend on how the lots round, so a position too small to trade still shows its cost.
4. **After costs:**
   - a win at the target is R:R − cost in R
   - a loss at the stop is −1 − cost in R

   1R stays the loss at the stop before costs (Claude's call), so the costs show up as a share of the risk.
5. **The target warning** compares the target's R **after** costs with the model's minimum (Claude's call). The brief says results are always reported after costs, and Phase 9's "target under 2R: skip" will use this same rule.
6. **"Per side" is a real account setting** (Claude's call). The account then charges twice a lot, so the account's P&L and the tool agree. Each trade keeps the rate it was opened with, so changing the setting later does not rewrite past trades.
7. **Slippage** is in the costs only (Claude's call). The replay still fills at exact prices, because changing fills means changing both engines (`broker.py` and `broker.js`) and their golden file.

## Checked

- **By hand:**
  - **EURUSD, 10-pip stop, 1 pip of spread:** 0.50 lots and 0.16R of costs; 0.20R with per-side commission.
  - **A short:** mirrors the long.
  - **Wrong sides:** refused.
  - **Each warning:** checked one by one.
  - **Sizes and pairs:** the account's sizing rule on USDJPY; a size too small for 0.01 lots still has its cost in R.
- **Golden:** JavaScript matches all 240 cases.
- **In the browser:**
  - **EURUSD, 10-pip stop:** 1.00 lots, $100 of risk, costs 0.06R ($6.00), that is $4 commission + $2 slippage on a minute with no spread; 1.94R after costs at a 2.00R target; Model A's warning.
  - **With a 4.4-pip stop and "per side" on:** 2.27 lots, costs 0.23R ($22.70), 4.32R after costs, "stop under 6 pips".
  - **Gold, $1.00 stop:** 1.00 lots, $100, costs 0.48R ($48.00) with the minute's $0.38 spread; both warnings.
- **Broken on purpose:**
  - "per side" ignored
  - the target compared before costs

  Each made tests fail.

## Found while building

- **Labels running off the chart:** with warnings on the entry line, the label ran off the chart's left edge. On a short box, a warning line placed just under the entry overlapped the stop's label. Warnings now sit one line beyond the stop's label.
- **A blank maximum stop** was first stored as a number the settings refuse, which would have brought the 20-pip limit back. It is now stored as 100,000 pips.

## Not yet done, and open for Jeevesh

- **The journal and analytics** (v2) still report R from prices and commission in dollars, as before. Should the journal's R also be after costs? That changes `stats.py` and its golden file, so it waits for your say.
- **The order ticket** does not show the cost line yet. "Use in ticket" carries the prices over as before.
- **Risk %:** the brief's 0.5% versus the account's 1% default. Which should the default be?
