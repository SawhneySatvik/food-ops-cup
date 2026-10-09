import { readFileSync } from "node:fs";
import { join } from "node:path";

const pack = (c: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "packs", `${c}.json`), "utf8"));

export const SAMPLES: Record<string, unknown> = { "country-pack": pack("IN") };
