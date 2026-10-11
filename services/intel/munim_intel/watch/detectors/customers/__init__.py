"""Customers & Growth specialist detectors (packs/customers-growth.md §4; T-049).

§6 drafts: coupon cap evasion tightens the coupon (`catalogue.coupon.set.v1` from `coupon_current` v2, 0023 C1). The
win-back campaign stays unwired (DECISIONS 11 Oct, W3.2 integration): `consented_audience` must count the at-risk
segment only, per channel consent, before an approved campaign can be trusted not to reach customers outside the finding.
"""

from munim_intel.watch.detectors.customers import coupon_cap_evasion as coupon_cap_evasion
from munim_intel.watch.detectors.customers import coupon_spike as coupon_spike
from munim_intel.watch.detectors.customers import rating_drop as rating_drop
from munim_intel.watch.detectors.customers import regulars_lapsing as regulars_lapsing
from munim_intel.watch.detectors.customers import staff_applied_coupon as staff_applied_coupon
