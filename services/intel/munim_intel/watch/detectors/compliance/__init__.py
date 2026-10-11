"""Compliance & Assets specialist detectors (packs/compliance-assets.md §4; T-050).

Every date a detector mints with is the outlet's business date from core's one tz module (run-frame). The templates read
temperature readings and waste in the outlet's own zone and cutoff, so expiry, excursions and checklists are judged in
outlet time.

`compliance.licence_expiring` mints with the run-frame's `licence_kinds` (rule 7: no kind named in code). Licence expiry
and missed logs draft `goals.task.create.v1` for the outlet's manager (`tasks.py`; 0023's `manager_member_id` cell), or
abstain `assignee_missing` where the outlet has none.
"""

from munim_intel.watch.detectors.compliance import amc_waste as amc_waste
from munim_intel.watch.detectors.compliance import energy_drift as energy_drift
from munim_intel.watch.detectors.compliance import licence_expiring as licence_expiring
from munim_intel.watch.detectors.compliance import maintenance_overdue as maintenance_overdue
from munim_intel.watch.detectors.compliance import missed_logs as missed_logs
from munim_intel.watch.detectors.compliance import temp_excursion as temp_excursion
