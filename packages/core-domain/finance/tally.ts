// Tally export (story 3 step 13): a journal-voucher CSV of committed entries — one row per posting, every
// figure a posting row's own amount (R26). Ledger names are owner-entered text: quoted, and a leading
// formula character is neutralised so a spreadsheet never evaluates it. Narration carries ids only.
import { decimalString } from "../money/index.ts";

export type TallyVoucher = {
  entry_id: string;
  entry_date: string;
  /** memo_key or posting rule id — a slug, never free text. */
  narration: string;
  postings: ReadonlyArray<{ account_code: string; account_name: string; amount_minor: number }>;
};

export const TALLY_HEADER = ["Date", "Voucher Type", "Voucher No", "Ledger Code", "Ledger", "Debit", "Credit", "Narration"] as const;

function cell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** dd-mm-yyyy, the date form Tally's import accepts. */
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

export function tallyCsv(vouchers: readonly TallyVoucher[], minorUnit: number): string {
  const rows: string[] = [TALLY_HEADER.join(",")];
  for (const v of vouchers) {
    for (const p of v.postings) {
      const amt = decimalString(Math.abs(p.amount_minor), minorUnit);
      rows.push([
        ddmmyyyy(v.entry_date), "Journal", v.entry_id, p.account_code, p.account_name,
        p.amount_minor > 0 ? amt : "", p.amount_minor < 0 ? amt : "", v.narration,
      ].map(cell).join(","));
    }
  }
  return rows.join("\r\n") + "\r\n";
}
