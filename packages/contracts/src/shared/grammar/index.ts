// Number-grammar data — the single definition (03-architecture §1.7). The matcher lives in
// packages/core-domain/envelope; intel reads the same JSON file. Data only: no matching logic here.
import words from "./number-words.json" with { type: "json" };

/** English cardinals one…ninety-nine (hyphenated compounds) + hundred, thousand, million, billion,
 *  lakh, crore, dozen + their plurals (hundreds … dozens). Whole words only. */
export const ENGLISH_CARDINALS: readonly string[] = words.english_cardinals;
/** The plural magnitude words (also included in ENGLISH_CARDINALS): "thousands of rupees" is a number. */
export const ENGLISH_MAGNITUDE_PLURALS: readonly string[] = words.english_magnitude_plurals;
/** Hindi number words in Devanagari, NFC-normalised (nukta and nukta-less spellings both listed). */
export const DEVANAGARI_NUMBER_WORDS: readonly string[] = words.devanagari;
/** Digit-free magnitude forms; a violation only when attached to a ref (e.g. `⟨snap:…⟩k`). */
export const MAGNITUDE_SUFFIXES: readonly string[] = words.magnitude_suffixes;
/** Percent signs (ASCII, full-width, Arabic). */
export const NUMBER_SYMBOLS: readonly string[] = words.symbols;
/** Words deliberately NOT in any list, with the reason (false-positive controls). */
export const EXCLUDED_AMBIGUOUS: readonly string[] = words.excluded_ambiguous.map((e) => e.word);
export const EXCLUDED_AMBIGUOUS_REASONS: ReadonlyArray<{ word: string; why: string }> = words.excluded_ambiguous;
/** Any Unicode numeric character (\p{N}: digits of every script, ½, ², Ⅻ) outside a ref is a violation. */
export const NUMERIC_CHAR_SOURCE = "\\p{N}";
export const NUMERIC_CHAR = /\p{N}/u;
