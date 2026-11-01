from app.version import APP_VERSION, USER_AGENT


def test_application_version_is_consistent() -> None:
    assert APP_VERSION == "2.0.0"
    assert USER_AGENT == f"tuantuan/{APP_VERSION}"
