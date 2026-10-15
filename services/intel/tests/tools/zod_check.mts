// Gate helper (T-080): parse what the generated tools post with core-api's own zod contracts — DraftsRequest (whose
// payload check looks the command type up in the draftable registry, so every module is loaded first: gotcha 28),
// SnapshotsRequest and FindingsRequest. Reads {drafts: [...], snapshots: [...], findings?: [...]} on stdin; prints the
// failing JSON paths per body.
//   node services/intel/tests/tools/zod_check.mts
import { DraftsRequest, FindingsRequest, SnapshotsRequest } from "../../../../packages/contracts/src/internal/index.ts";
import { loadRegistry } from "../../../../packages/contracts/src/registry.ts";

await loadRegistry();
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { drafts, snapshots, findings = [] } = JSON.parse(input) as { drafts: unknown[]; snapshots: unknown[]; findings?: unknown[] };
const issues = (r: { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } }) =>
  r.success ? [] : r.error!.issues.map((i) => i.path.map(String).join("/"));
console.log(JSON.stringify({
  drafts: drafts.map((d) => issues(DraftsRequest.safeParse(d))),
  snapshots: snapshots.map((s) => issues(SnapshotsRequest.safeParse(s))),
  findings: findings.map((f) => issues(FindingsRequest.safeParse(f))),
}));
