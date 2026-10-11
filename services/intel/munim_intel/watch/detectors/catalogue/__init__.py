"""Menu & Pricing specialist detectors (packs/catalogue.md §4): all six, each registered on import."""

from munim_intel.watch.detectors.catalogue import above_mrp as above_mrp
from munim_intel.watch.detectors.catalogue import below_cost as below_cost
from munim_intel.watch.detectors.catalogue import cost_drift as cost_drift
from munim_intel.watch.detectors.catalogue import deal_loss as deal_loss
from munim_intel.watch.detectors.catalogue import negative_margin as negative_margin
from munim_intel.watch.detectors.catalogue import recipe_waste_gap as recipe_waste_gap
