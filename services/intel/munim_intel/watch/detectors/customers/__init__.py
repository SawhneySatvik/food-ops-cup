"""Customers & Growth specialist detectors (packs/customers-growth.md §4; T-049).

Not here yet: the §6 drafts. The win-back campaign's audience must count the at-risk segment only (`consented_audience`
v1 counts every customer of the churn snapshot), and `catalogue.coupon.set` needs `coupon_current` v2 (code, kind,
validity). Both are migrator requests (W3.2 integration report).
"""

from munim_intel.watch.detectors.customers import coupon_cap_evasion as coupon_cap_evasion
from munim_intel.watch.detectors.customers import coupon_spike as coupon_spike
from munim_intel.watch.detectors.customers import rating_drop as rating_drop
from munim_intel.watch.detectors.customers import regulars_lapsing as regulars_lapsing
from munim_intel.watch.detectors.customers import staff_applied_coupon as staff_applied_coupon
