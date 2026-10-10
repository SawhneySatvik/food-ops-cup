"""Registered detectors, one package per specialist (BOARD W3: `watch/detectors/<pack>/` belongs to that pack's lane).
Importing this package registers every detector in munim_intel.detect.REGISTRY."""

from munim_intel.watch.detectors import catalogue as catalogue
from munim_intel.watch.detectors import finance as finance
