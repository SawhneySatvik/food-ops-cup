// Gate: generated JSON Schema count = Σ MANIFEST.d lines, and each module's registered names equal its
// hand-kept MANIFEST.d/<module>.txt (the independent expectation; gen never reads it).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRegistry, moduleNames } from "../src/registry.ts";
import { PKG, manifest, manifestNames } from "./helpers.ts";

const reg = await loadRegistry();
const M = manifest();

describe("generated JSON Schema vs MANIFEST.d", () => {
  const files = readdirSync(join(PKG, "generated", "json-schema")).filter((f) => f.endsWith(".schema.json"));
  const all = manifestNames();

  it("MANIFEST.d lists a positive number of unique names", () => {
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((n, i) => all.indexOf(n) !== i)).toEqual([]);
    expect(all.filter((n) => n.trim() !== n || n === "" || n.startsWith("#"))).toEqual([]);
  });

  it("generated schema file count = Σ MANIFEST.d lines", () => {
    const perModule = Object.entries(M).map(([m, l]) => `${m}=${l.length}`).join(" ");
    console.log(`json-schema files: ${files.length}; Σ MANIFEST.d lines: ${all.length} (${perModule})`);
    expect(files.length).toBe(all.length);
  });

  it("generated file names = MANIFEST.d names", () => {
    expect(files.map((f) => f.slice(0, -".schema.json".length)).sort()).toEqual([...all].sort());
  });

  it("source modules and MANIFEST.d files match 1:1", () => {
    expect(moduleNames()).toEqual(Object.keys(M).sort());
  });

  it.each(moduleNames())("module %s registers exactly its MANIFEST.d names", (m) => {
    expect(reg.schemas.filter(([, , mod]) => mod === m).map(([n]) => n).sort()).toEqual([...(M[m] ?? [])].sort());
  });
});
