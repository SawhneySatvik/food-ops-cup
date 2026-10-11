"""Finance specialist detectors (packs/finance.md §4): all five. Four read the version-2 templates of migration 0023
(M-C1e: settlement_vs_orders, missing_payouts, tender_vs_bank Σ rows first; gst_check's outlet_id) — core mints the
latest version, so a detector reads exactly those shapes."""

from munim_intel.watch.detectors.finance import gst_mismatch as gst_mismatch
from munim_intel.watch.detectors.finance import missing_payout as missing_payout
from munim_intel.watch.detectors.finance import short_payout as short_payout
from munim_intel.watch.detectors.finance import tender_gap as tender_gap
from munim_intel.watch.detectors.finance import unapproved_ad_fee as unapproved_ad_fee
