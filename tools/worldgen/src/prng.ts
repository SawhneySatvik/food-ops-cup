// Seeded PRNG (mulberry32). The only source of variation in a world: no Math.random, no Date.now.
import { createHash } from "node:crypto";

export class Prng {
  #s: number;
  constructor(seed: string, ...scope: string[]) {
    this.#s = createHash("sha256").update([seed, ...scope].join("|")).digest().readUInt32LE(0);
  }
  /** [0, 1) */
  next(): number {
    this.#s = (this.#s + 0x6d2b79f5) | 0;
    let t = Math.imul(this.#s ^ (this.#s >>> 15), 1 | this.#s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(0, xs.length - 1)]!;
  }
}
