# ForexReplay v2.7.0

Jump to setup time, built on 4 Nov 2026 to `JUMP_TO_SETUP_BRIEF.md`.

## What is new

- **Jump to setup time.** Each strategy can have a jump, set in the Strategies dialog (the **Jump** button on its row):
  - a session's start or end, from the standard sessions or the ICT killzones, each in its own city's clock
  - or a time of day in any zone, with an optional offset in minutes (for example the Tokyo close − 15 min)

  During a replay, **J** (or **⇥ Setup**) goes to the next one and pauses. It skips weekends and closed days and never goes back.
- **Next session open.** **1**, **2** and **3** (or the Tokyo, London and NY buttons) go to the next Tokyo, London or New York open.
- **Nothing is skipped.** Every 1-minute candle on the way is still played, so stops, targets, pending orders and challenge limits work as if you had played through. If a trade or order is open, the jump stops on the candle where it fills or closes, and says so.

## Tests

115 Python and 162 JavaScript tests, all passing. The new ones cover:

- targets across the different US and UK clock changes
- weekends, a target already passed, offsets and gaps
- a stop hit in the middle of a jump: the jump stops there, with the same result as playing through
- rebuilding 30 random sessions that used jumps
- checking the `jump` setting on both sides

The key tests were broken on purpose (no weekend skip, no early stop, the wrong clock, Python accepting any session) and failed each time.
