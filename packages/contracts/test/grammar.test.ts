// Number-grammar data (the matcher itself is T-003's, in core-domain).
import { describe, expect, it } from "vitest";
import { DEVANAGARI_NUMBER_WORDS, ENGLISH_CARDINALS, ENGLISH_MAGNITUDE_PLURALS, EXCLUDED_AMBIGUOUS, MAGNITUDE_SUFFIXES, NUMBER_SYMBOLS, NUMERIC_CHAR } from "../src/shared/grammar/index.ts";

describe("number-word data", () => {
  it("English: one…ninety-nine (99 words) + 7 magnitude words + 7 plurals, unique, lowercase", () => {
    expect(ENGLISH_CARDINALS.length).toBe(99 + 7 + 7);
    expect(new Set(ENGLISH_CARDINALS).size).toBe(ENGLISH_CARDINALS.length);
    expect(ENGLISH_CARDINALS.every((w) => w === w.toLowerCase())).toBe(true);
    for (const w of ["one", "nineteen", "twenty", "twenty-one", "ninety-nine", "hundred", "thousand", "million", "billion", "lakh", "crore", "dozen"])
      expect(ENGLISH_CARDINALS).toContain(w);
  });
  it("Devanagari: NFC, unique, 1…99 plus magnitudes, both nukta spellings", () => {
    expect(DEVANAGARI_NUMBER_WORDS.length).toBeGreaterThanOrEqual(99 + 5);
    expect(DEVANAGARI_NUMBER_WORDS.every((w) => w === w.normalize("NFC"))).toBe(true);
    expect(new Set(DEVANAGARI_NUMBER_WORDS).size).toBe(DEVANAGARI_NUMBER_WORDS.length);
    for (const w of ["एक", "तीन", "निन्यानवे", "सौ", "हज़ार", "हजार", "लाख", "करोड़", "करोड", "दर्जन"]) expect(DEVANAGARI_NUMBER_WORDS).toContain(w.normalize("NFC"));
  });
  it("plural magnitude words are listed (English and Devanagari)", () => {
    const plurals = ["hundreds", "thousands", "millions", "billions", "lakhs", "crores", "dozens"];
    expect([...ENGLISH_MAGNITUDE_PLURALS]).toEqual(plurals);
    expect(plurals.filter((w) => !ENGLISH_CARDINALS.includes(w))).toEqual([]);
    for (const w of ["सैकड़ों", "हज़ारों", "लाखों", "करोड़ों", "दर्जनों"]) expect(DEVANAGARI_NUMBER_WORDS).toContain(w.normalize("NFC"));
  });

  // A minimal whole-word reading of the data (the real matcher is core-domain's): it proves the DATA makes
  // these phrases violations and leaves the false-positive controls alone.
  const listed = new Set([...ENGLISH_CARDINALS, ...DEVANAGARI_NUMBER_WORDS].map((w) => w.normalize("NFC")));
  const violates = (prose: string) => NUMERIC_CHAR.test(prose) || prose.normalize("NFC").toLowerCase().split(/[^\p{L}\p{M}-]+/u).some((w) => listed.has(w));
  it.each([
    ["Paneer cost us thousands of rupees", true],
    ["Margins fell by lakhs this month", true],
    ["We sold dozens of samosas", true],
    ["हज़ारों रुपये का नुकसान", true],
    ["Do you want the quarter-end close?", false],
    ["Sales dipped in the first half", false],
  ])("grammar data: %j → violation=%s", (prose, expected) => {
    expect(violates(prose)).toBe(expected);
  });

  it("ambiguous words (do, teen, half, quarter, double) are excluded from every list", () => {
    for (const w of ["do", "teen", "half", "quarter", "double"]) expect(EXCLUDED_AMBIGUOUS).toContain(w);
    const listed = new Set([...ENGLISH_CARDINALS, ...DEVANAGARI_NUMBER_WORDS].map((w) => w.normalize("NFC")));
    expect(EXCLUDED_AMBIGUOUS.filter((w) => listed.has(w.normalize("NFC")))).toEqual([]);
  });
  it("magnitude suffixes and percent symbols", () => {
    expect([...MAGNITUDE_SUFFIXES]).toEqual(["k", "L", "Cr"]);
    expect(NUMBER_SYMBOLS).toContain("%");
  });
  it("\\p{N} covers ASCII, Devanagari and full-width digits, ½, ², Ⅻ — and not words", () => {
    for (const c of ["7", "७", "７", "½", "²", "Ⅻ"]) expect(NUMERIC_CHAR.test(c)).toBe(true);
    for (const s of ["quarter-end close", "Do you", "first half"]) expect(NUMERIC_CHAR.test(s)).toBe(false);
  });
});
