from copy import deepcopy

import pytest

from app.presentations.confirmation_constraints import UnsupportedPresentationInput, validate_submission
from test_ppt_generate import confirmed_free_design, preparation
from test_ppt_production_contracts import contract


@pytest.mark.parametrize("field,value", [("generation_mode", "split"), ("proactive_custom_animations", True),
    ("proactive_narration_audio", True), ("image_usage", ["ai"]), ("page_count", "21"), ("image_usage", ["provided"])])
def test_unsupported_design_can_be_corrected_without_writing_receipts(preparation, field, value):
    p = preparation
    confirmed_free_design(p)
    manifest = p.preparer.manifests.load()
    job = {**p.job, "confirmation": None}  # Stage 2 wait clears the latest binding.
    before = p.repository.get(p.job["id"], p.context)
    original = p.preparer.files.read("confirm_ui/result.json")
    payload = {**contract().final, "stage": "final"}
    invalid = deepcopy(payload)
    invalid[field] = value
    with pytest.raises(UnsupportedPresentationInput):
        validate_submission(job, p.preparer.root, manifest, invalid)
    validate_submission(job, p.preparer.root, manifest, payload)
    assert p.repository.get(p.job["id"], p.context) == before
    assert p.preparer.files.read("confirm_ui/result.json") == original
