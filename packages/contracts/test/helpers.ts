// Shared test helpers: the hand-kept manifest, sample discovery, canonical sample ids and times.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const PKG = join(import.meta.dirname, "..");
export const MANIFEST_DIR = join(PKG, "MANIFEST.d");

/** module → schema names, from MANIFEST.d/<module>.txt (one name per line; no blanks, no comments). */
export function manifest(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of readdirSync(MANIFEST_DIR).filter((n) => n.endsWith(".txt")).sort()) {
    const lines = readFileSync(join(MANIFEST_DIR, f), "utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    out[f.slice(0, -4)] = lines;
  }
  return out;
}
export const manifestNames = (): string[] => Object.values(manifest()).flat();

/** Merge every test/samples/<module>.ts SAMPLES export (files starting with "_" are helpers). */
export async function loadSamples(): Promise<Record<string, unknown>> {
  const dir = join(import.meta.dirname, "samples");
  const all: Record<string, unknown> = {};
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.startsWith("_")).sort()) {
    const mod = (await import(pathToFileURL(join(dir, f)).href)) as { SAMPLES: Record<string, unknown> };
    for (const [k, v] of Object.entries(mod.SAMPLES)) {
      if (k in all) throw new Error(`sample '${k}' defined twice`);
      all[k] = v;
    }
  }
  return all;
}
