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
