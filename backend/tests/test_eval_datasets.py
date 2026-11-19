"""Offline product contracts; run with ordinary pytest and backend CI."""
import pytest

from eval_harness import assert_eval_expected, load_eval_cases, run_eval_case


@pytest.mark.parametrize("case", load_eval_cases(), ids=lambda case: case["description"])
def test_current_product_evaluation(case):
    assert_eval_expected(run_eval_case(case), case["vars"].get("expected", {}))
