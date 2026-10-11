"""Inventory & purchasing specialist detectors (packs/inventory-purchasing.md §4), T-046.

Supplier negotiation (the PO draft from quotes) is T-055, not a detector here.
"""

from munim_intel.watch.detectors.inventory_purchasing import dead_stock as dead_stock
from munim_intel.watch.detectors.inventory_purchasing import expiry_risk as expiry_risk
from munim_intel.watch.detectors.inventory_purchasing import near_duplicate_invoice as near_duplicate_invoice
from munim_intel.watch.detectors.inventory_purchasing import overbilled as overbilled
from munim_intel.watch.detectors.inventory_purchasing import price_creep as price_creep
from munim_intel.watch.detectors.inventory_purchasing import shortfall as shortfall
from munim_intel.watch.detectors.inventory_purchasing import shrinkage as shrinkage
from munim_intel.watch.detectors.inventory_purchasing import waste_spike as waste_spike
