// The one messages module: no key defined twice across the per-surface files, and every literal t("…") key used in
// apps/web source exists (a missing key would throw at render).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { messages, SOURCES } from "../lib/i18n/index.ts";

test("no key is defined in two message files", () => {
  const seen = new Map<string, string>();
  const dupes: string[] = [];
  for (const [file, msgs] of Object.entries(SOURCES)) {
    for (const k of Object.keys(msgs)) {
      if (seen.has(k)) dupes.push(`${k} (${seen.get(k)}, ${file})`);
      seen.set(k, file);
    }
  }
  expect(seen.size).toBeGreaterThan(40);
  expect(dupes).toEqual([]);
});

test("every literal t(\"key\") in apps/web source exists", () => {
  const root = join(import.meta.dirname, "..");
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n === "node_modules" || n.startsWith(".next") || n === "test") continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(n)) files.push(p);
    }
  };
  walk(root);
  const used = files.flatMap((f) => [...readFileSync(f, "utf8").matchAll(/\bt\("([a-z0-9_.]+)"/g)].map((m) => m[1]!));
  expect(used.length).toBeGreaterThan(20);
  expect(used.filter((k) => !(k in messages))).toEqual([]);
});
