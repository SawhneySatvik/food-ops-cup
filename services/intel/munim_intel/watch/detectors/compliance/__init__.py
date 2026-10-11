"""Compliance & Assets specialist detectors (packs/compliance-assets.md §4; T-050).

Every date a detector mints with is the outlet's business date from core's one tz module (run-frame). The templates read
temperature readings and waste in the outlet's own zone and cutoff, so expiry, excursions and checklists are judged in
outlet time.

Not here yet: `compliance.licence_expiring`, whose `required_kinds` param is the country pack's `licence_kinds`. The
run-frame carries only integer thresholds, and naming kinds in code would be country logic (R21). Also not here: the
`goals.task.create` draft, which needs an assignee member that no template carries. Both are reported.
"""

from munim_intel.watch.detectors.compliance import amc_waste as amc_waste
from munim_intel.watch.detectors.compliance import energy_drift as energy_drift
from munim_intel.watch.detectors.compliance import maintenance_overdue as maintenance_overdue
from munim_intel.watch.detectors.compliance import missed_logs as missed_logs
from munim_intel.watch.detectors.compliance import temp_excursion as temp_excursion
