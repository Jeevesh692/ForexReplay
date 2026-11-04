# 0028: Jump to setup time

- **Date:** 4 Nov 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (`JUMP_TO_SETUP_BRIEF.md`: "one key press that takes the replay straight to that moment and pauses there"), with Claude on the details below

## What it is

Each strategy can have a `jump` in `strategy.json`. It is either a session's start or end, taken from either preset (Tokyo, London and New York sessions, and the ICT killzones), or a time of day in a chosen zone, with an optional offset in minutes. **J** (or the ⇥ Setup button) moves the replay forward to the next time it occurs and pauses there. Keys **1**, **2** and **3** do the same for the next Tokyo, London and New York open, without any strategy setting.

## How it works, and why

- **Each target keeps its own city's clock.** It is worked out from the session's zone on each day (`sessions.js` `sessionWindow`), so London's open follows UK summer time and New York's killzone follows US summer time. Those clocks change on different dates. It does not depend on which sessions are shaded on the chart.
- **Every candle is still played.** `ReplayClock.jumpTo` reveals the base candles one at a time, in order, to the same reveal listeners that playing uses. So stops, targets, pending orders and challenge limits are checked exactly as before. The trading engine already processed each revealed candle in order; revealing them one at a time adds one thing: the jump can stop on the exact candle where something changed. A test plays the same minutes both ways and gets the same trade.
- **It stops early when a trade changes.** If a position or order is open, the jump ends at the candle where one fills, closes or changes size, or where the challenge ends. The hint bar says which. With nothing open, it goes all the way.
- **Only forward, only from the live edge.** While you are looking back at history, the buttons are disabled with a tooltip saying why.
- **Where it lands:** every candle that opened before the target is shown. On M1, a jump to the Tokyo close shows the 17:59 candle, which closes at 18:00.
- **Gaps and closed days (Claude's call):**
  - A target with no candle within 6 hours after it is a closed day (a weekend or a holiday) and is skipped.
  - A target in a shorter gap lands just after it, showing the first candle once trading resumes.
- **Saving and resuming:** a jump is only a clock move, so a session that used jumps rebuilds the same way any other does. A test rebuilds 30 random sessions with jumps mixed in.
- **Keys (Claude's call):** J for jump, and 1, 2 and 3 for Tokyo, London and New York, in the order they open. None of these keys had a use before.
- **Validation:** JavaScript (`jump.js` `validateJump`) and Python (`strategy_folders.clean_jump`) apply the same rules. A damaged value reads as no jump and never breaks the strategy list. A bad value sent to be saved is refused with the reason.

## Not yet done

- November was checked in tests only: the app's data ends on 14 Oct 2026.
- There is no separate "end of the jump" marker on the chart. The hint bar says where you are.
