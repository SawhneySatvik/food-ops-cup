"""Registered detectors, one package per specialist (BOARD W3: `watch/detectors/<pack>/` belongs to that pack's lane).
Importing this package registers every detector in munim_intel.detect.REGISTRY."""

from munim_intel.watch.detectors import catalogue as catalogue
from munim_intel.watch.detectors import compliance as compliance
from munim_intel.watch.detectors import customers as customers
from munim_intel.watch.detectors import finance as finance
from munim_intel.watch.detectors import inventory_purchasing as inventory_purchasing
from munim_intel.watch.detectors import kitchen as kitchen
from munim_intel.watch.detectors import market as market
from munim_intel.watch.detectors import people as people
