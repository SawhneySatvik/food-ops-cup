"""Customers & Growth specialist detectors (packs/customers-growth.md §4; T-049).

§6 drafts: the coupon.set tightening is unwired (R-B S1-A: it changed nothing core executes; see coupon_cap_evasion). The
win-back campaign is drafted by regulars_lapsing's mapping (R67, T-128) with the finding's own at-risk count as its audience;
core admits it on a demo business only. Elsewhere the 11 Oct ruling stands (DECISIONS, W3.2 integration): `consented_audience`
must count the at-risk segment only, per channel consent, before an approved campaign can be trusted not to reach customers
outside the finding, and core refuses an intel campaign draft (`campaign_audience_unscoped`).
"""

from munim_intel.watch.detectors.customers import coupon_cap_evasion as coupon_cap_evasion
from munim_intel.watch.detectors.customers import coupon_spike as coupon_spike
from munim_intel.watch.detectors.customers import rating_drop as rating_drop
from munim_intel.watch.detectors.customers import regulars_lapsing as regulars_lapsing
from munim_intel.watch.detectors.customers import staff_applied_coupon as staff_applied_coupon
