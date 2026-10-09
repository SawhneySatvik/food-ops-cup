// Gate: generated artefacts are current. The stamp recorded by `gen` must equal a fresh digest of
// (a) gen's inputs — zod sources, generator scripts, package.json — and (b) gen's outputs (catches a
// hand-edited or deleted generated file).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STAMP_FILE, type Stamp, outputsDigest, sourcesDigest } from "../scripts/stamp.ts";

const recorded = JSON.parse(readFileSync(STAMP_FILE, "utf8")) as Stamp;
const drift = (a: Record<string, string>, b: Record<string, string>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter((f) => a[f] !== b[f]);

describe("stale generation", () => {
  it("sources unchanged since the last `pnpm -F @munim/contracts gen`", () => {
    const now = sourcesDigest();
    expect(Object.keys(now.files).length).toBeGreaterThan(10);
    expect({ drifted: drift(now.files, recorded.sources.files), sha256: now.sha256 }, "zod sources or generator changed — run `make contracts`").toEqual({
      drifted: [],
      sha256: recorded.sources.sha256,
    });
  });

  it("generated outputs unchanged since they were generated", () => {
    const now = outputsDigest();
    expect(Object.keys(now.files).length).toBeGreaterThan(10);
    expect({ drifted: drift(now.files, recorded.outputs.files), sha256: now.sha256 }, "generated files edited or deleted — run `make contracts`").toEqual({
      drifted: [],
      sha256: recorded.outputs.sha256,
    });
  });
});
