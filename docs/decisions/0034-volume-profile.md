# 0034: The volume profile engine (order flow, Phase 2)

- **Date:** 9 Nov 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (the order-flow brief, Phase 2), with Claude on the points the brief left open (marked below)

## The definition

There is one definition, written twice: `forex_replay/profile.py` and `web/js/profile.js`. Both add the numbers in the same order, so they give the same answers. `web/tests/fixtures/profile_golden.json` holds them to it: 45 profiles, 40 random and 5 with edge cases, written by `python -m forex_replay.profile_golden`. A Python test fails if that file is out of date.

1. **Bins** (Claude's call: one grid from zero): bin k holds prices from k × bin to (k + 1) × bin, so two profiles over the same prices share their bins. Prices and bin sizes are whole numbers in the order-flow files' units (2 × points). The default bin is EURUSD 1 pip (20) and gold $0.50 (100).
2. **Volume:** each bar's tick count is spread evenly over the bins from the one holding its low to the one holding its high.
3. **POC:** the biggest bin.
   - **Claude's call, for ties:** the bin nearest the middle of the profile, and then the lower one.
4. **Value area:** 70% by default. It starts at the POC and adds the larger of the two bins just outside, one bin a step, as the brief says.
   - **Claude's call, for ties:** the upper bin is added first.
   - VAL is the bottom of the lowest bin in the area, and VAH the top of the highest.
5. **Smoothing:** a centred moving average over 3 bins (1 means none), over fewer bins at the edges.
   - **Claude's call:** the brief says "smooth before finding nodes". So **HVNs and LVNs use the smoothed volumes, and the POC and value area use the raw ones**, which keeps them exact rather than shifted by the smoothing.
6. **HVN:** a peak: higher than the bin below and at least as high as the bin above. Of a flat top, the first bin counts.
   - **Claude's call:** an edge bin must be higher than its one neighbour, so a flat profile has none.
7. **LVN zone:** a run of consecutive smoothed bins below 35% of the **smoothed** POC volume (Claude's call: the threshold is measured on the same smoothed numbers), with a heavier bin on both sides. So a thin tail at the top or bottom is not a zone. It is reported as a price range, as the brief asks, not a line.

## No look-ahead

`profileFromBars` / `profile_from_bars` take the replay cursor and count only bars that had **closed** by then: a bar's open time plus its length is at the cursor or before. A bar still forming is never read. A test checks that cutting the data at the cursor gives the same profile as the full data with the cursor.

## Checked

- **By hand:**
  - spreading over bins
  - the value area of 5, 10, 40, 20, 15, 10 (bins 2 to 4, holding 75)
  - both tie rules
  - smoothing
  - two HVNs with a valley of three bins between them, while the tails are not zones
  - a flat profile
  - the cursor
- **Golden:** JavaScript matches Python on all 45 profiles; 13 of them have LVN zones, and 31 have more than one HVN.
- **Broken on purpose:**
  - a value-area tie adding the lower bin
  - tails counted as LVN zones
  - a POC tie taking the upper bin

  Each made tests fail. The first was at first caught only by Python's tests, so a tie case was added to the golden file and to the JavaScript tests, and it is now caught there too.

## Not yet done

- Drawing it on the chart (Phase 3).
- It has not been run on real data yet; the Phase 1 download comes first.
