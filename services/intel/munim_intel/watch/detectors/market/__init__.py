"""Market & Strategy specialist detectors (packs/market-strategy.md §4). `goal_off_track` enumerates the outlet's goals
through `market.goals` (migration 0022)."""

from munim_intel.watch.detectors.market import competitor_undercut as competitor_undercut
from munim_intel.watch.detectors.market import event_ahead as event_ahead
from munim_intel.watch.detectors.market import goal_off_track as goal_off_track
