// Gate: for EVERY manifest entry — a valid sample in zod → validate + re-serialise through the generated
// Pydantic model (uv run --with pydantic) → re-parse in zod → deep-equal to the original.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { loadRegistry } from "../src/registry.ts";
import { PKG, loadSamples, manifestNames } from "./helpers.ts";

const PYDANTIC = "pydantic==2.14.0";
const reg = await loadRegistry();
const schema = (n: string): z.ZodType => reg.schemas.find(([name]) => name === n)![1];
const SAMPLES = await loadSamples();
const AU = (await import("../src/packs/index.ts")).PACKS.AU;
/** Extra cases beyond one-per-entry: key "<name>#<tag>". */
const EXTRA: Record<string, unknown> = {
  "country-pack#AU": AU,
  "catalogue.item.upsert.v1#sku": (await import("./samples/catalogue.ts")).skuItem,
  "v1.tender#card": (await import("./samples/orders.ts")).cardTender,
};
const NAMES = manifestNames();

describe("TS ↔ Pydantic round trip", () => {
  it("there is exactly one sample per MANIFEST.d entry", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...NAMES].sort());
  });

  it("every sample is valid in zod", () => {
    const bad = [...NAMES.map((n) => [n, SAMPLES[n]] as const), ...Object.entries(EXTRA)].flatMap(([k, v]) => {
      const r = schema(k.split("#")[0]!).safeParse(v);
      return r.success ? [] : [`${k}: ${JSON.stringify(r.error.issues)}`];
    });
    expect(bad).toEqual([]);
  });

  it("round-trips every MANIFEST.d entry through the generated Pydantic models", { timeout: 180_000 }, () => {
    const input: Record<string, unknown> = {};
    for (const n of NAMES) input[n] = schema(n).parse(SAMPLES[n]);
    for (const [k, v] of Object.entries(EXTRA)) input[k] = schema(k.split("#")[0]!).parse(v);
    const raw = execFileSync("uv", ["run", "--no-project", "--quiet", "--with", PYDANTIC, "python", join(PKG, "scripts", "roundtrip.py")], {
      input: JSON.stringify(input),
      encoding: "utf8",
    });
    const out = JSON.parse(raw) as Record<string, { ok?: unknown; error?: string }>;
    const passed: string[] = [];
    const failed: string[] = [];
    for (const k of Object.keys(input)) {
      const r = out[k];
      if (!r || r.error !== undefined) {
        failed.push(`${k}: python ${r?.error ?? "missing"}`);
        continue;
      }
      const back = schema(k.split("#")[0]!).safeParse(r.ok);
      if (!back.success) failed.push(`${k}: zod re-parse ${JSON.stringify(back.error.issues)}`);
      else if (JSON.stringify(back.data) !== JSON.stringify(input[k]) || !isDeepStrictEqual(back.data, input[k]))
        failed.push(`${k}: differs after round trip: ${JSON.stringify(r.ok)}`);
      else passed.push(k);
    }
    console.log(`round trip: ${passed.length}/${Object.keys(input).length} passed (${NAMES.length} manifest entries + ${Object.keys(EXTRA).length} extra)`);
    expect(failed).toEqual([]);
    expect(passed.filter((k) => !k.includes("#")).length).toBe(NAMES.length);
  });
});
