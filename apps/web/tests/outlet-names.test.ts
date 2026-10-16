// [unit] C3: an Ask answer, a finding or the snapshot drawer that cites an outlet (the snapshot cell `outlet_id`) shows the
// outlet's name, from the outlets the session already has. The cell stays the snapshot's; only its look changes.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiSegment } from "@/components/staff/source";
import { drawerCell, formatCell, outletNames } from "@/lib/munim/refs";
import { uuidv7 } from "@/lib/munim/uuid";
import { OUTLETS } from "@/mock-server/data";

const HZG = OUTLETS[0]!;
const GOMTI = OUTLETS[1]!;
const base = { locale: "en-IN", currency: "INR" };
const fmt = { ...base, outletNames: outletNames(OUTLETS.map((o) => ({ id: o.outlet_id, name: o.name }))) };

describe("an outlet_id cell is shown by the outlet's name", () => {
  it("formatCell: a known outlet by name; an unknown one, or no names, as stored", () => {
    expect(formatCell(HZG.outlet_id, "outlet_id", fmt)).toBe(HZG.name);
    expect(formatCell(GOMTI.outlet_id, "outlet_id", fmt)).toBe(GOMTI.name);
    expect(formatCell("019f0000-0000-7000-8000-00000000dead", "outlet_id", fmt)).toBe("019f0000-0000-7000-8000-00000000dead");
    expect(formatCell(HZG.outlet_id, "outlet_id", base)).toBe(HZG.outlet_id);
  });
  it("only the outlet_id column: the same id in another column is left alone", () => {
    expect(formatCell(HZG.outlet_id, "supplier_id", fmt)).toBe(HZG.outlet_id);
  });
  it("an Ask answer's segment: the name on screen, the raw id nowhere, and the cell is still a traced value with its chip", () => {
    const ref = `⟨snap:${uuidv7()}·0·outlet_id⟩`;
    const html = renderToStaticMarkup(createElement(AiSegment, {
      segment: { text: `Most waste was at ${ref}.`, refs: [ref] },
      resolved: [{ ref, value: HZG.outlet_id }],
      fmt,
      onOpen: () => {},
    }));
    expect(html).toContain(HZG.name);
    expect(html).not.toContain(HZG.outlet_id);
    expect(html).toContain("Source");
  });
  it("an outlet the session has no name for is still shown as stored, never hidden or guessed", () => {
    const ref = `⟨snap:${uuidv7()}·0·outlet_id⟩`;
    const html = renderToStaticMarkup(createElement(AiSegment, { segment: { text: `At ${ref}.`, refs: [ref] }, resolved: [{ ref, value: GOMTI.outlet_id }], fmt: { ...base, outletNames: { [HZG.outlet_id]: HZG.name } }, onOpen: () => {} }));
    expect(html).toContain(GOMTI.outlet_id);
  });
  it("the snapshot drawer: the outlet column by name, any other id column by its last 8 characters", () => {
    expect(drawerCell("uuid", HZG.outlet_id, "outlet_id", fmt)).toBe(HZG.name);
    expect(drawerCell("uuid", HZG.outlet_id, "supplier_id", fmt)).toBe(`…${HZG.outlet_id.slice(-8)}`);
    expect(drawerCell("uuid", "019f0000-0000-7000-8000-00000000dead", "outlet_id", fmt)).toBe("…0000dead");
    expect(drawerCell("integer", 486000, "waste_minor", fmt)).toBe("₹4,860.00");
    expect(drawerCell("uuid", undefined, "outlet_id", fmt)).toBe("…—");
  });
});

describe("every staff page that builds a cell format passes the outlets", () => {
  it("each `{ locale: …, currency: … }` in components/staff/pages carries outletNames", () => {
    const dir = join(__dirname, "../components/staff/pages");
    const sites = readdirSync(dir).filter((f) => f.endsWith(".tsx")).flatMap((f) =>
      [...readFileSync(join(dir, f), "utf8").matchAll(/\{ locale: [^}]*currency: [^}]*\}/g)].map((m) => `${f}: ${m[0]}`));
    expect(sites.length).toBeGreaterThanOrEqual(10); // ask, campaigns, cares, desk, draft-detail, inbox, investigation, owner-home, purchase-order, suppliers
    expect(sites.filter((s) => !s.includes("outletNames: outletNames(outlets)"))).toEqual([]);
  });
});
