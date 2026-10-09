// R21 / project rule 7: no country logic in code paths. Scans the package source (tests and fixtures
// excluded) for literals that name a country pack. The forbidden list is built from the pack documents
// themselves, so a new pack widens the scan without editing this file.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKS } from "@munim/contracts/packs";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === "node_modules" || name === "test") return [];
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|js|mjs|json)$/.test(name) && !/(package|tsconfig)\.json$/.test(name) && name !== "vitest.config.ts" ? [p] : [];
  });
}

const literals = new Set<string>();
for (const p of Object.values(PACKS)) {
  [p.code, p.currency.code, p.locale, p.tax.regime, ...p.timezones, ...p.tax_ids.map((t) => t.code), ...p.aggregators.map((a) => a.code), ...p.tax.classes.map((c) => c.code)].forEach((l) =>
    literals.add(l),
  );
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const alternation = [...literals].map(esc).join("|");
const FORBIDDEN = new RegExp(`(["'\`])(?:${alternation})\\1|\\.(?:${[...Object.keys(PACKS)].join("|")})\\b`, "g");

describe("no country-code literals in core-domain source", () => {
  it("scans every source file for every pack literal and finds 0", () => {
    const files = sourceFiles(ROOT);
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(literals.size).toBeGreaterThanOrEqual(20);
    const hits = files.flatMap((f) => [...readFileSync(f, "utf8").matchAll(FORBIDDEN)].map((m) => `${relative(ROOT, f)}: ${m[0]}`));
    expect(hits).toEqual([]);
  });
});
