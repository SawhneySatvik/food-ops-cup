"""R-E 2-C: a recorded-fixture miss fails its test even when the code under test swallowed it (the DecisionModel abstains on
any error; run_agent wraps it), unless the test is marked `fixture_miss_expected` — a miss inside a module-scoped fixture
included. The guard is tests/conftest.py's; this runs it — the real conftest, copied — over four tiny tests in a
throwaway pytest session and reads the outcomes."""

from __future__ import annotations

import pytest

from conftest import INTEL

pytest_plugins = ["pytester"]

BODY = """
import pytest
from munim_intel.llm.recorded import RecordedFixtureMissing


def swallowed():
    try:
        raise RecordedFixtureMissing("k" * 64, "{}")
    except RecordedFixtureMissing:
        return "fallback"


def test_swallowed_miss():
    assert swallowed() == "fallback"


@pytest.mark.fixture_miss_expected
def test_marked_miss():
    assert swallowed() == "fallback"


def test_no_miss():
    assert True


@pytest.fixture(scope="module")
def swallowing_module():
    # A module-scoped fixture that runs a model and degrades: built in its first test's setup, before any
    # function-scoped fixture could count.
    return swallowed()


def test_module_fixture_miss(swallowing_module):
    assert swallowing_module == "fallback"
"""


def test_an_unmarked_swallowed_miss_fails_and_a_marked_one_or_none_passes(pytester: pytest.Pytester) -> None:
    pytester.makeconftest((INTEL / "tests" / "conftest.py").read_text("utf8"))
    pytester.makeini(
        "[pytest]\nmarkers =\n    fixture_miss_expected: the test proves a degrade path by missing a recorded fixture on purpose\n"
    )
    pytester.makepyfile(test_guarded=BODY)
    result = pytester.runpytest_subprocess("-p", "no:cacheprovider")
    assert result.ret != 0, "an unmarked miss must make the session exit non-zero"
    result.assert_outcomes(passed=4, errors=2)
    result.stdout.fnmatch_lines(["*ERROR at teardown of test_swallowed_miss*", "1 recorded fixture miss(es) in a test not marked*"])
    result.stdout.fnmatch_lines(["*ERROR at teardown of test_module_fixture_miss*"])
