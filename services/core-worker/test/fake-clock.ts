// Deterministic Clock for cron tests: time moves only through advance(), which fires due timers in time
// order and lets the promise chains they start run before moving on.
import type { Clock } from "../src/ports.ts";

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

export class FakeClock implements Clock {
  #t: number;
  #seq = 0;
  #timers = new Map<number, { at: number; fn: () => void }>();

  constructor(start: string) {
    this.#t = Date.parse(start);
  }

  now(): Date {
    return new Date(this.#t);
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.#t + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  sleep(ms: number): Promise<void> {
    return new Promise((r) => this.setTimeout(r, ms));
  }

  async advance(ms: number): Promise<void> {
    const end = this.#t + ms;
    for (;;) {
      await settle();
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.#timers) if (e[1].at <= end && (!next || e[1].at < next[1].at || (e[1].at === next[1].at && e[0] < next[0]))) next = e;
      if (!next) break;
      this.#timers.delete(next[0]);
      this.#t = next[1].at;
      next[1].fn();
    }
    this.#t = end;
    await settle();
  }
}
