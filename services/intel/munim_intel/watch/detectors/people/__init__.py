"""People specialist detectors (packs/people.md §4). They read attendance, rosters and advances; no event names those
yet, so they run on sweeps only."""

from munim_intel.watch.detectors.people import advance_unrecovered as advance_unrecovered
from munim_intel.watch.detectors.people import labour_pct_high as labour_pct_high
from munim_intel.watch.detectors.people import overstaffed_slot as overstaffed_slot
from munim_intel.watch.detectors.people import overtime_drift as overtime_drift
