"""Kitchen specialist detectors (packs/kitchen.md §4). Restaurants and cloud kitchens only: the pack is off for shops
(§1), so every spec here names `outlet_kinds` without `store` and a shop outlet mints nothing."""

from munim_intel.watch.detectors.kitchen import overprep as overprep
from munim_intel.watch.detectors.kitchen import prep_time_gap as prep_time_gap
from munim_intel.watch.detectors.kitchen import remakes as remakes
from munim_intel.watch.detectors.kitchen import ticket_drift as ticket_drift
