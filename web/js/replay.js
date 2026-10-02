// The replay clock.
//
// The whole app has ONE clock: `position`, the number of M5 candles revealed.
// Every chart timeframe is derived from it (see TimeframeView), so no view can
// ever show a candle the clock has not reached.
//
// `furthest` remembers the furthest position reached in this replay. Stepping
// back lets you look at history, but you are only "live" (and, from day 4,
// allowed to trade) when position === furthest. That stops you from rewinding
// to take a trade on a move you have already watched.

export const SPEEDS = [1, 2, 5, 10, 30, 100]; // M5 candles revealed per second

export class ReplayClock {
  /**
   * @param {number} total  number of M5 candles in the dataset
   * @param {object} timers { setInterval, clearInterval } (injectable for tests)
   */
  constructor(total, timers = globalThis) {
    this.total = total;
    this.timers = timers;
    this.active = false;
    this.position = total;
    this.furthest = total;
    this.playing = false;
    this.speed = SPEEDS[0];
    this.listeners = new Set();
    this.timer = null;
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(reason) {
    for (const listener of this.listeners) listener(this, reason);
  }

  get live() {
    return this.position === this.furthest;
  }

  get finished() {
    return this.position >= this.total;
  }

  /** Enter replay with `position` M5 candles revealed. */
  start(position) {
    this.pause(false);
    this.active = true;
    this.position = this.furthest = Math.max(1, Math.min(position, this.total));
    this.emit("start");
  }

  /** Leave replay: everything is visible again. */
  stop() {
    this.pause(false);
    this.active = false;
    this.position = this.furthest = this.total;
    this.emit("stop");
  }

  moveTo(position, reason) {
    const next = Math.max(1, Math.min(position, this.total));
    if (next === this.position) return false;
    this.position = next;
    if (next > this.furthest) this.furthest = next;
    this.emit(reason);
    return true;
  }

  /** Reveal `count` more M5 candles. */
  advance(count = 1) {
    if (!this.active) return false;
    const moved = this.moveTo(this.position + count, "advance");
    if (this.finished) this.pause();
    return moved;
  }

  /**
   * Step forward to the end of the current chart candle: finishes a forming
   * candle, or reveals the next whole one. `view` is the chart's TimeframeView.
   */
  stepForward(view) {
    if (!this.active || this.finished) return false;
    const k = view.bucketOf[this.position]; // candle that the next hidden M5 candle belongs to
    return this.moveTo(view.endOf(k), "step");
  }

  /** Step back to the end of the previous chart candle (look only; you are no longer live). */
  stepBack(view) {
    if (!this.active || this.position <= 1) return false;
    const k = view.bucketOf[this.position - 1]; // candle containing the last revealed M5 candle
    return this.moveTo(Math.max(1, view.firstIndex[k]), "back"); // hide that whole candle
  }

  backToLive() {
    return this.active && this.moveTo(this.furthest, "live");
  }

  setSpeed(speed) {
    this.speed = speed;
    if (this.playing) {
      this.pause(false);
      this.play();
    }
    this.emit("speed");
  }

  play() {
    if (!this.active || this.playing || this.finished) return;
    this.playing = true;
    // Up to 20 screen updates a second; faster speeds reveal several candles per update.
    const perTick = Math.ceil(this.speed / 20);
    this.timer = this.timers.setInterval(() => this.advance(perTick), (1000 * perTick) / this.speed);
    this.emit("play");
  }

  pause(announce = true) {
    if (this.timer !== null) {
      this.timers.clearInterval(this.timer);
      this.timer = null;
    }
    const was = this.playing;
    this.playing = false;
    if (announce && was) this.emit("pause");
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }
}
