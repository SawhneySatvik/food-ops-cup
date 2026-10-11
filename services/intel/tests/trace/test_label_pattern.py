"""A bare number is not a trace label (R25); the same cases as packages/contracts/test/trace-label.test.ts."""

import pytest

from munim_intel.trace.buffer import TraceLabelError, check_payload

ACCEPT = ["read_below_reorder", "1", "12", "123", "3x4500", "2026-10-11", "01920000-0000-7000-8000-000000000001", "a" * 200]
REFUSE = ["450000", "4500.50", "1234", "What needs me today?", "", " lead", "a" * 201]


@pytest.mark.parametrize("v", ACCEPT)
def test_label_accepted(v: str) -> None:
    assert check_payload({"tool": v}) == {"tool": v}


@pytest.mark.parametrize("v", REFUSE)
def test_label_refused(v: str) -> None:
    with pytest.raises(TraceLabelError):
        check_payload({"tool": v})
    with pytest.raises(TraceLabelError):
        check_payload({"tool": ["ok", v]})
