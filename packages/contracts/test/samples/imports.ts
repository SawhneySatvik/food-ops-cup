import { MEMBER, T, T_PG, u } from "./_ids.ts";

const SIG = "3f1c0a7e5b2d4c6f8a9b0c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f7";
const formatApprove = {
  format_id: u(300),
  kind: "bank_statement",
  name: "Synthetic bank layout",
  header: ["Posted", "Ref", "Amt (Rs)", "Mode", "A/c"],
  header_signature: SIG,
  mapping: [
    { source: "Posted", target: "txn_date", unit: "date_dmy" },
    { source: "Ref", target: "reference" },
    { source: "Amt (Rs)", target: "amount", unit: "rupees" },
    { source: "Mode", target: "mode" },
    { source: "A/c", target: "account" },
  ],
};
const run = {
  import_run_id: u(301),
  document_id: u(302),
  kind: "payout_statement",
  parser: "swiggy_orders_v1",
  format_id: null,
  status: "previewed",
  rows_ok: 9,
  rows_quarantined: 3,
  control_total_minor: 1254300,
  currency: "INR",
  total_matches: true,
  draft_id: u(303),
  decision_id: null,
  created_at: T,
  updated_at: T_PG,
};
const document = {
  document_id: u(302),
  kind: "payout_statement",
  media_type: "text/csv",
  filename: "synthetic_payout_sept.csv",
  byte_size: 2048,
  sha256: SIG,
  uploaded_by: MEMBER,
  created_at: T_PG,
};

export const SAMPLES: Record<string, unknown> = {
  "imports.format.approve.v1": formatApprove,
  "imports.run.commit.v1": { import_run_id: u(301) },
  "proposal.imports.format.approve.v1": formatApprove,
  "proposal.imports.run.commit.v1": { import_run_id: u(301) },
  "v1.imports.document": document,
  "v1.imports.run": run,
  "v1.imports.upload.request": { kind: "payout_statement", filename: "synthetic_payout_sept.csv", media_type: "text/csv", content_base64: "UGF5b3V0IFJlZg==" },
  "v1.imports.upload.response": { duplicate: false, document, run: { ...run, status: "parsing", rows_ok: 0, rows_quarantined: 0, control_total_minor: null, currency: null, total_matches: null, draft_id: null }, header: null },
  "v1.imports.run.create.request": { document_id: u(302) },
  "v1.imports.runs.response": { runs: [run], next_cursor: null },
  "v1.imports.run.rows.response": {
    staged: [{ row_no: 2, target_table: "core.settlement_line", data: { payout_ref: "SYN-PAY-1", line_kind: "order", net_minor: 26208 }, amount_minor: 26208, external_ref: "SYN-ORD-1" }],
    quarantined: [{ row_no: 5, raw: "SYN-PAY-1,31-02-2026,…", reason_code: "date_unreadable" }],
  },
  "v1.imports.format.propose.request": { document_id: u(302), kind: "bank_statement", name: "Synthetic bank layout", mapping: formatApprove.mapping },
  "v1.imports.format.propose.response": { draft_id: u(304) },
  "v1.conversations": { items: [{ conversation_id: u(3700), outlet_id: u(2), kind: "handover", title: "Evening handover", document_id: null, created_at: T }], next_cursor: null },
  "v1.conversation.messages": {
    items: [{ message_id: u(3701), conversation_id: u(3700), author_member_id: null, author_label: "Synthetic <b>chef</b>", body: "Walk-in fridge is warm; <script>alert(1)</script> call the technician", sent_at: T }],
    next_cursor: null,
  },
};
