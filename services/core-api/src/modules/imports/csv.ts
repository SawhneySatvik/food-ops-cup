// RFC 4180 CSV reader: quoted fields, doubled quotes, CRLF or LF, a leading UTF-8 BOM. Returns one array of
// cells per record with its 1-based line number (the header is line 1), so a quarantined row can be shown as
// the row the owner sees in their spreadsheet. Blank records are dropped.
export interface CsvRecord {
  line: number;
  cells: string[];
  /** The record's own text, for the quarantine view (plain text only, never in traces). */
  raw: string;
}

export class CsvError extends Error {
  override name = "CsvError";
}

export function readCsv(text: string): CsvRecord[] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const out: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let startLine = 1;
  let start = 0;
  const push = (end: number) => {
    cells.push(cell);
    if (!(cells.length === 1 && cells[0]!.trim() === "")) out.push({ line: startLine, cells, raw: s.slice(start, end) });
    cells = [];
    cell = "";
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      push(i);
      if (ch === "\r" && s[i + 1] === "\n") i++;
      line++;
      startLine = line;
      start = i + 1;
    } else cell += ch;
  }
  if (quoted) throw new CsvError("unterminated quoted field");
  if (cell !== "" || cells.length > 0) push(s.length);
  return out;
}
