import { S1, T, T_PG, snapRef, u } from "./_ids.ts";

const schedule = { maintenance_id: u(300), outlet_id: u(2), asset_id: u(301), kind: "preventive", due_on: "2026-11-15", estimated_cost_minor: 250000, vendor_note: null };

export const SAMPLES: Record<string, unknown> = {
  "compliance.licence.upsert.v1": {
    licence_id: u(310), outlet_id: u(2), kind: "fssai", number: "SYN-FSSAI-0001", issuer: null, valid_from: "2026-01-01", valid_to: "2027-01-01",
    document_id: null, supersedes_licence_id: null,
  },
  "compliance.checklist.upsert.v1": {
    checklist_id: u(311), outlet_id: null, name_key: "ops.checklist.closing", kind: "closing", frequency: "daily", due_time: "23:00",
    items: ["ops.item.lights", "ops.item.floor"], active: true,
  },
  "compliance.checklist.complete.v1": {
    run_id: u(312), checklist_id: u(311), outlet_id: u(2), business_date: "2026-10-09", results: { "ops.item.lights": true, "ops.item.floor": false },
  },
  "compliance.temp.record.v1": { log_id: u(313), outlet_id: u(2), asset_id: u(301), reading_milli_c: 3500, read_at: T, note: null },
  "compliance.asset.upsert.v1": {
    asset_id: u(301), outlet_id: u(2), kind: "chiller", name: "Walk-in chiller", make_model: null, serial_no: null,
    safe_min_milli_c: 0, safe_max_milli_c: 5000, installed_on: "2025-04-01", active: true,
  },
  "compliance.amc.record.v1": {
    amc_id: u(314), asset_id: u(301), vendor: "Synthetic Cool Care", valid_from: "2026-01-01", valid_to: "2026-12-31",
    cost: { amount_minor: 1200000, currency: "INR" }, document_id: null,
  },
  "compliance.maintenance.schedule.v1": schedule,
  "compliance.maintenance.record.v1": {
    maintenance_id: u(300), asset_id: u(301), kind: "preventive", done_on: "2026-11-14", cost_minor: 240000, vendor: "Synthetic Cool Care", amc_id: null, note: null,
  },
  "proposal.compliance.maintenance.schedule.v1": { ...schedule, estimated_cost_minor: snapRef(S1, 0, "last_preventive_cost_minor") },
  "v1.compliance.licences": { items: [{ id: u(310), outlet_id: u(2), kind: "fssai_licence", number: "12345678901234", issuer: "Synthetic Authority", valid_from: "2026-01-01", valid_to: "2026-12-31", document_id: null, status: "active" }] },
  "v1.compliance.licences-expiring": { items: [{ id: u(310), outlet_id: null, kind: "fssai_licence", number: "12345678901234", valid_to: "2026-10-20", document_id: null, days_left: 10, expired: false }] },
  "v1.compliance.assets": { items: [{ id: u(301), outlet_id: u(2), kind: "chiller", name: "Walk-in chiller", make_model: null, serial_no: null, safe_min_milli_c: 0, safe_max_milli_c: 5000, installed_on: "2025-04-01", active: true }] },
  "v1.compliance.temp-logs": { items: [{ id: u(311), outlet_id: u(2), asset_id: u(301), reading_milli_c: 3500, read_at: T_PG, recorded_by: u(8), note: null, local_date: "2026-10-09", out_of_range: false }] },
  "v1.compliance.checklists": { items: [{ id: u(312), outlet_id: null, name_key: "checklist.opening", kind: "opening", frequency: "daily", due_time: "09:00:00", items: ["item.unlock", "item.lights"], active: true }] },
  "v1.compliance.checklist-runs": { items: [{ id: u(313), checklist_id: u(312), outlet_id: u(2), business_date: "2026-10-09", results: { "item.unlock": true, "item.lights": false }, completed_by: u(8), completed_at: T_PG }] },
  "v1.compliance.amcs": { items: [{ id: u(314), asset_id: u(301), vendor: "Synthetic Cool Care", valid_from: "2026-04-01", valid_to: "2027-03-31", cost_minor: 1200000, currency: "INR", document_id: null }] },
  "v1.compliance.maintenance": { items: [{ id: u(300), asset_id: u(301), kind: "preventive", status: "scheduled", due_on: "2026-11-14", done_on: null, estimated_cost_minor: 240000, cost_minor: null, currency: null, vendor: null, amc_id: null, note: null }] },
};
