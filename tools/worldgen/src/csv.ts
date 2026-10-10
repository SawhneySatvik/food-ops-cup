// Minimal RFC 4180 writer for the import files a merchant would export (synthetic layouts, see formats.ts of core-api).
const cell = (v: string | number): string => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
export const csv = (rows: ReadonlyArray<ReadonlyArray<string | number>>): string => `${rows.map((r) => r.map(cell).join(",")).join("\n")}\n`;

/** Minor units → the decimal text a major-unit column holds ("1234.50"). */
export function major(minor: number, digits = 2): string {
  const neg = minor < 0;
  const s = String(Math.abs(minor)).padStart(digits + 1, "0");
  return `${neg ? "-" : ""}${s.slice(0, -digits)}.${s.slice(-digits)}`;
}
