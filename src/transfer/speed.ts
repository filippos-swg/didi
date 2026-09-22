// Transfer speed over a sliding window, and a throttle so progress reaches React
// a few times a second rather than once per block.

const WINDOW_MS = 3000;
const MIN_SPAN_MS = 500;
const REPORT_EVERY_MS = 250;

export class SpeedMeter {
  private samples: { time: number; bytes: number }[] = [];
  private lastReport = -Infinity;

  /** Records a byte count; returns true if it is time to report progress. */
  add(bytes: number, time = performance.now()): boolean {
    this.samples.push({ time, bytes });
    while (this.samples.length > 2 && (this.samples[1]?.time ?? time) <= time - WINDOW_MS) this.samples.shift();
    if (time - this.lastReport < REPORT_EVERY_MS) return false;
    this.lastReport = time;
    return true;
  }

  /** Null until there is enough history to say anything honest. */
  bytesPerSecond(): number | null {
    const first = this.samples[0];
    const last = this.samples.at(-1);
    if (first === undefined || last === undefined || last.time - first.time < MIN_SPAN_MS) return null;
    return ((last.bytes - first.bytes) / (last.time - first.time)) * 1000;
  }
}

/** How long nothing may move before a transfer counts as stalled. */
export const STALL_AFTER_SECONDS = 10;

/**
 * Checks once a second whether anything has moved, and reports how long it has
 * not. `sample` returns a marker that changes whenever data moves, null while
 * nothing is expected to move (the file is being finalised), or undefined once the
 * transfer is over, which stops the watch.
 */
export function watchForStalls(sample: () => string | null | undefined, report: (seconds: number | null) => void): void {
  let marker: string | null | undefined = sample();
  let lastMoved = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const next = sample();
    if (next === undefined) {
      clearInterval(timer);
      return;
    }
    if (next === null || next !== marker) {
      marker = next;
      lastMoved = now;
      report(null);
      return;
    }
    const idle = (now - lastMoved) / 1000;
    report(idle >= STALL_AFTER_SECONDS ? Math.floor(idle) : null);
  }, 1000);
}
