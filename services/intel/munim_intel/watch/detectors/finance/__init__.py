"""Finance specialist detectors (packs/finance.md §4): all five. Three read the version-2 templates requested from the
migrator (tests/packs/finance/requested_templates_v2.sql) and stay silent on version 1."""

from munim_intel.watch.detectors.finance import gst_mismatch as gst_mismatch
from munim_intel.watch.detectors.finance import missing_payout as missing_payout
from munim_intel.watch.detectors.finance import short_payout as short_payout
from munim_intel.watch.detectors.finance import tender_gap as tender_gap
from munim_intel.watch.detectors.finance import unapproved_ad_fee as unapproved_ad_fee
