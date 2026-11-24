"""Purpose choices preserve service identity and preview never unlocks secrets."""
import pytest

from app.agent import model_purposes
from app.agent.model_router import bind_text_model
from test_model_catalog_api import client  # noqa: F401


def sample_catalog():
    return {
        "connections": [
            {"id": "one", "protocol": "auto", "enabled": True, "api_key_configured": True},
            {"id": "two", "protocol": "auto", "enabled": True, "api_key_configured": True},
        ],
        "profiles": [
            {"id": "chat-one", "connection_id": "one", "model_name": "gpt-4.1", "enabled": True},
            {"id": "image-two", "connection_id": "two", "model_name": "gpt-image-2", "enabled": True},
            {"id": "chat-two", "connection_id": "two", "model_name": "gpt-4.1", "enabled": True},
        ],
        "purpose_defaults": {"chat": "chat-two"}, "service_connection_id": "one",
    }


def select(catalog, purpose, profile_id=None, **kwargs):
    return model_purposes.select_model_for_purpose(catalog, purpose, profile_id, **kwargs)


def test_selection_uses_cross_service_purpose_default_and_preserves_same_name_identity():
    catalog = sample_catalog()
    chosen = select(catalog, "chat")
    assert (chosen["profile_id"], chosen["connection_id"], chosen["model_name"]) == ("chat-two", "two", "gpt-4.1")
    assert chosen["reason"] == "purpose_default"
    chosen = select(catalog, "chat", "chat-one")
    assert chosen["profile_id"] == "chat-one" and chosen["reason"] == "explicit_profile"
    assert select(catalog, "image")["profile_id"] == "image-two"


def test_selection_does_not_substitute_for_explicit_mismatch_or_missing_profile():
    for profile_id in ("image-two", "missing"):
        chosen = select(sample_catalog(), "chat", profile_id)
        assert chosen["eligible"] is False
        assert chosen["profile_id"] == profile_id
        assert chosen["error"] and chosen["reason"]


@pytest.mark.parametrize("purpose,model,protocol,caps,reason", [
    ("chat", "private-alias", "auto", {}, "未知"),
    ("image", "gemini-image-alias", "gemini", {"image_generation": "supported", "chat": "unsupported"}, "接口"),
    ("image", "grok-4.7", "openai", {"image_generation": "supported"}, "接口"),
    ("video", "sora-2", "auto", {"video_generation": "supported"}, "暂未接入"),
])
def test_declared_outputs_cannot_invent_adapter_actions(purpose, model, protocol, caps, reason):
    catalog = sample_catalog()
    catalog["profiles"] = [{"id": "candidate", "connection_id": "one", "model_name": model, "capabilities": caps, "enabled": True}]
    catalog["connections"][0]["protocol"] = protocol
    result = select(catalog, purpose)
    assert result["eligible"] is False
    assert reason in result["excluded"][0]["reason"]


def test_supported_gateway_image_alias_uses_images_adapter_only_on_compatible_services():
    from app.model_protocol import model_protocol_for_profile
    caps = {"chat": "unsupported", "image_generation": "supported"}
    catalog = sample_catalog()
    catalog["profiles"][1].update(model_name="provider/private-image-v2", capabilities=caps)
    assert select(catalog, "image")["profile_id"] == "image-two"
    assert model_protocol_for_profile("provider/private-image-v2", "auto", caps) == "images"
    assert model_protocol_for_profile("provider/private-image-v2", "gemini", caps) == "gemini"


def test_exclusions_explain_disabled_missing_credentials_and_strict_unknown():
    catalog = sample_catalog()
    catalog["profiles"][0]["enabled"] = False
    catalog["connections"][1]["api_key_configured"] = False
    result = select(catalog, "chat")
    reasons = {item["profile_id"]: item["reason"] for item in result["excluded"]}
    assert "停用" in reasons["chat-one"] and "凭证" in reasons["chat-two"]
    catalog = sample_catalog()
    result = select(catalog, "image", strict_capabilities=True)
    assert result["eligible"] is False
    assert any("确认" in item["reason"] for item in result["excluded"])


def test_automatic_choice_is_stable_when_catalog_order_changes():
    catalog = sample_catalog()
    catalog["purpose_defaults"] = {}
    first = select(catalog, "chat")
    catalog["profiles"].reverse()
    catalog["connections"].reverse()
    assert select(catalog, "chat")["profile_id"] == first["profile_id"] == "chat-one"


def add_service(client, name, model_name="gpt-4.1", protocol="auto"):
    response = client.post("/agent/model-connections", json={"name": name, "api_key": "synthetic-preview-key", "model_base_url": f"https://{name}.example.test/v1", "model_protocol": protocol, "model_name": model_name})
    assert response.status_code == 200, response.text
    source = next(item for item in response.json()["connections"] if item["name"] == name)
    profile = next(item for item in response.json()["profiles"] if item["connection_id"] == source["id"])
    return source, profile


def test_preview_endpoint_has_no_network_secret_resolution_or_catalog_mutation(client, monkeypatch):
    from app.agent import model_catalog, settings
    from app import db
    source, profile = add_service(client, "preview")
    with db.connect() as conn:
        before = conn.execute("SELECT payload_json FROM model_routing_policy WHERE id=1").fetchone()[0]
    def forbidden(*args, **kwargs):
        pytest.fail("preview must not resolve credentials, initialize catalog or call providers")
    monkeypatch.setattr(model_catalog, "_secret", forbidden)
    monkeypatch.setattr(model_catalog, "_secret_preview", forbidden)
    monkeypatch.setattr(model_catalog, "_ensure_catalog", forbidden)
    monkeypatch.setattr(settings, "get_secret", forbidden)
    monkeypatch.setattr("app.models.build_model_provider", forbidden)
    response = client.post("/agent/model-selection/preview", json={"purpose": "chat", "profile_id": profile["id"]})
    assert response.status_code == 200, response.text
    chosen = response.json()
    assert chosen["eligible"] is True and chosen["connection_id"] == source["id"]
    assert "synthetic-preview-key" not in response.text
    assert not {"api_key", "secret_ref", "credential_fingerprint"} & chosen.keys()
    with db.connect() as conn:
        assert conn.execute("SELECT payload_json FROM model_routing_policy WHERE id=1").fetchone()[0] == before
    rejected = client.post("/agent/model-selection/preview", json={"purpose": "image", "profile_id": profile["id"]})
    assert rejected.status_code == 200 and rejected.json()["eligible"] is False
    assert response.headers["cache-control"] == "no-store"


def test_production_gateway_alias_resolves_live_credential_and_images_protocol(client):
    from app.agent.model_catalog import get_profile_connection
    source, profile = add_service(client, "alias", "provider/private-image-v2")
    response = client.patch(f'/agent/model-profiles/{profile["id"]}', json={"expected_revision": profile["revision"], "capabilities": {"chat": "unsupported", "image_generation": "supported"}})
    assert response.status_code == 200, response.text
    connection = get_profile_connection(profile["id"])
    assert connection["connection_id"] == source["id"]
    assert connection["api_key"] == "synthetic-preview-key"
    assert connection["resolved_model_protocol"] == "images"


def test_ppt_uses_chat_purpose_default_and_does_not_bind_images_only(client):
    from app.agent.model_catalog import get_model_catalog, set_default_model_profile
    from app.agent.model_purposes import save_purpose_default
    from app.presentations.service import resolve_model
    _, chat = add_service(client, "text")
    _, image = add_service(client, "images", "gpt-image-2")
    set_default_model_profile(image["id"])
    catalog = get_model_catalog()
    save_purpose_default("chat", {"profile_id": chat["id"], "expected_version": catalog["purpose_version"]})
    set_default_model_profile(image["id"])
    selected = resolve_model()
    assert selected["profile_id"] == chat["id"]
    assert selected["selection_reason"] == "purpose_default"
    with pytest.raises(ValueError):
        resolve_model(profile_id=image["id"])


def test_text_binding_excludes_unknown_alias_and_keeps_advanced_text_stages():
    catalog = sample_catalog()
    catalog["purpose_defaults"] = {}
    catalog["profiles"].insert(0, {"id": "alias", "connection_id": "one", "model_name": "private-alias", "enabled": True})
    current = {"profile_id": "old-image", "connection_id": "one", "model_name": "gpt-image-2", "model_protocol": "images", "policy_version": 1,
               "stage_connections": {"classify": {"profile_id": "advanced", "model_name": "gpt-4.1", "model_protocol": "openai"}, "plan": {"profile_id": "advanced", "model_name": "gpt-4.1", "model_protocol": "openai"}, "execute": {"model_name": "gpt-image-2", "model_protocol": "images"}}}
    resolved = {"profile_id": "chat-one", "connection_id": "one", "model_name": "gpt-4.1", "model_protocol": "openai", "api_key": "synthetic", "capabilities": {}}
    def resolve(profile_id):
        assert profile_id == "chat-one", "unknown alias must not be selected just because its protocol accepts text"
        return resolved
    result = bind_text_model(current, catalog=catalog, resolve=resolve)
    assert result["profile_id"] == "chat-one"
    assert result["stage_connections"]["plan"]["profile_id"] == "advanced"


def test_image_edit_action_skips_responses_default_and_selects_supported_images_adapter(client):
    from app.agent.model_catalog import get_model_catalog
    from app.agent.model_purposes import save_purpose_default
    from app.chat.image_editing import _image_connection
    _, dual = add_service(client, "dual", "grok-4.7", "responses")
    _, image = add_service(client, "editable", "gpt-image-2")
    catalog = get_model_catalog()
    save_purpose_default("image", {"profile_id": dual["id"], "expected_version": catalog["purpose_version"]})
    assert _image_connection()["profile_id"] == image["id"]


def test_ensure_uses_current_service_discovery_for_image_alias_and_preserves_override(client):
    from app import db
    from app.agent.model_catalog import ensure_service_model_profile, get_profile_connection, update_model_profile
    from app.models.catalog_discovery import store_discovery
    source, _ = add_service(client, "discovered")
    alias = "provider/opaque-output-v3"
    with db.connect() as conn:
        assert store_discovery(conn, source["id"], source["revision"], [{"id": alias, "output_types": ["image"], "output_types_source": "provider"}])
    profile = ensure_service_model_profile(source["id"], {"model_name": alias, "expected_revision": source["revision"]})
    assert profile["capabilities"]["chat"] == "unsupported"
    assert profile["capabilities"]["image_generation"] == "supported"
    assert get_profile_connection(profile["id"])["resolved_model_protocol"] == "images"
    update_model_profile(profile["id"], {"capabilities": {"image_generation": "unsupported"}})
    reused = ensure_service_model_profile(source["id"], {"model_name": alias, "expected_revision": source["revision"]})
    assert reused["id"] == profile["id"] and reused["capabilities"]["image_generation"] == "unsupported"


def test_ensure_does_not_reuse_discovery_from_old_connection_revision(client):
    from app import db
    from app.agent.model_catalog import ensure_service_model_profile, update_model_connection
    from app.models.catalog_discovery import store_discovery
    source, _ = add_service(client, "stale")
    alias = "opaque-output-v4"
    with db.connect() as conn:
        store_discovery(conn, source["id"], source["revision"], [{"id": alias, "output_types": ["image"], "output_types_source": "provider"}])
    updated = update_model_connection(source["id"], {"expected_revision": source["revision"], "name": "renamed"})
    profile = ensure_service_model_profile(source["id"], {"model_name": alias, "expected_revision": updated["revision"]})
    assert profile["capabilities"]["image_generation"] == "unknown"


def test_known_video_preference_switches_text_to_chat_before_building_runtime(client, monkeypatch):
    from app.agent import bootstrap
    from app.agent.model_catalog import get_model_catalog
    from app.agent.model_purposes import save_purpose_default
    _, chat = add_service(client, "chat")
    _, video = add_service(client, "video", "sora-2")
    catalog = get_model_catalog()
    save_purpose_default("chat", {"profile_id": chat["id"], "expected_version": catalog["purpose_version"]})
    monkeypatch.setattr(bootstrap, "_cached_components", lambda connection: (connection, {}))
    result = bootstrap.get_agent_runtime(video["id"], user_content="你好")
    assert result["profile_id"] == chat["id"]
    assert result["selection_reason"] == "text_intent"


@pytest.mark.parametrize("model_name,protocol", [("gpt-image-2", "images"), ("sora-2", "auto")])
def test_chatgpt_subscription_text_rebind_requires_an_interactive_turn(client, monkeypatch, model_name, protocol):
    from app import chatgpt_subscription, db
    from app.agent import bootstrap
    from app.agent.model_catalog import add_model_profile, ensure_chatgpt_connection, get_model_catalog
    from app.agent.model_purposes import save_purpose_default
    from app.models.catalog_discovery import store_discovery
    from app.workspace import resolve_db_path

    _, non_chat = add_service(client, "non-chat", model_name, protocol)
    account_id = "subscription-test-account"
    monkeypatch.setattr(chatgpt_subscription, "local_enabled", lambda: True)
    monkeypatch.setattr(chatgpt_subscription, "binding", lambda path, cid: "fake-generation" if cid == account_id else "")
    # Use the real saved purpose defaults and catalog rather than stubbing re-selection.
    ensure_chatgpt_connection(account_id, "ChatGPT", resolve_db_path())
    with db.connect() as conn:
        assert store_discovery(conn, account_id, 1, [{"id": "subscription-chat", "output_types": ["chat"]}])
    chat = add_model_profile({"connection_id": account_id, "model_name": "subscription-chat"})
    save_purpose_default("chat", {"profile_id": chat["id"], "expected_version": get_model_catalog()["purpose_version"]})

    def no_runtime(connection):
        pytest.fail("External turns must reject subscription rebinding before constructing a runtime")

    monkeypatch.setattr(bootstrap, "_cached_components", no_runtime)
    with pytest.raises(ValueError, match="不支持外部消息渠道"):
        bootstrap.get_agent_runtime(non_chat["id"], user_content="你好", allow_chatgpt_subscription=False)
    with pytest.raises(ValueError, match="不支持外部消息渠道"):
        bootstrap.get_agent_runtime(non_chat["id"], user_content="你好")

    monkeypatch.setattr(bootstrap, "_cached_components", lambda connection: (connection, {}))
    interactive = bootstrap.get_agent_runtime(non_chat["id"], user_content="你好", allow_chatgpt_subscription=True)
    assert interactive["profile_id"] == chat["id"]
    assert interactive["selection_reason"] == "text_intent"
    assert {stage["profile_id"] for stage in interactive["stage_connections"].values()} == {chat["id"]}


def test_image_input_binds_vision_default_only_for_new_vision_turns(client, monkeypatch):
    from app.agent import bootstrap
    from app.agent.model_binding import internal_model_selection
    from app.agent.model_catalog import get_model_catalog
    from app.agent.model_purposes import save_purpose_default

    _, text = add_service(client, "text-service", "gpt-3.5-turbo")
    _, vision = add_service(client, "vision-service", "gpt-4.1")
    for purpose, profile in (("chat", text), ("vision", vision)):
        save_purpose_default(purpose, {"profile_id": profile["id"], "expected_version": get_model_catalog()["purpose_version"]})
    monkeypatch.setattr(bootstrap, "_cached_components", lambda connection: (connection, {}))
    assert bootstrap.get_agent_runtime(user_content="你好")["profile_id"] == text["id"]
    binding = bootstrap.get_agent_runtime(user_content="看看这张图", has_image_input=True)
    assert binding["profile_id"] == vision["id"]
    assert binding["selection_reason"] == "vision_default"
    assert binding["stage_connections"]["classify"]["profile_id"] == text["id"]
    assert binding["stage_connections"]["execute"]["vision_status"] == "supported"

    save_purpose_default("vision", {"profile_id": None, "expected_version": get_model_catalog()["purpose_version"]})
    restored = bootstrap.get_agent_runtime(selection=internal_model_selection(binding))
    assert restored["profile_id"] == vision["id"]
    assert restored["stage_connections"]["execute"]["vision_status"] == "supported"


def test_vision_input_never_silently_switches_an_unavailable_saved_default(client, monkeypatch):
    from app.agent import bootstrap
    from app.agent.model_catalog import get_model_catalog
    from app.agent.model_purposes import save_purpose_default
    from app.agent.model_routing import set_capability_record

    _, selected = add_service(client, "vision-first", "gpt-4.1")
    _, alternative = add_service(client, "vision-second", "gpt-4o")
    save_purpose_default("vision", {"profile_id": selected["id"], "expected_version": get_model_catalog()["purpose_version"]})
    set_capability_record(selected["id"], "vision", "unsupported")
    monkeypatch.setattr(bootstrap, "_cached_components", lambda connection: (connection, {}))
    with pytest.raises(ValueError, match="图像理解默认模型"):
        bootstrap.get_agent_runtime(user_content="看看这张图", has_image_input=True)
    assert bootstrap.get_agent_runtime(alternative["id"], user_content="看看这张图", has_image_input=True)["profile_id"] == alternative["id"]


def test_catalog_preserves_current_discovery_provenance(client):
    from app import db
    from app.agent.model_catalog import get_model_catalog
    from app.models.catalog_discovery import store_discovery
    source, profile = add_service(client, "provenance")
    entry = {"id": "gpt-4.1", "output_types": ["chat"], "output_types_source": "provider", "display_name": "Provider text"}
    with db.connect() as conn:
        store_discovery(conn, source["id"], source["revision"], [entry])
    public = next(item for item in get_model_catalog()["profiles"] if item["id"] == profile["id"])
    assert public["discovery"] == entry


def test_auto_native_service_cannot_gain_images_action_from_alias_metadata():
    catalog = sample_catalog()
    catalog["profiles"][1].update(model_name="opaque-image-alias", capabilities={"chat": "unsupported", "image_generation": "supported"})
    catalog["connections"][1]["effective_base_url"] = "https://generativelanguage.googleapis.com/v1beta"
    assert select(catalog, "image")["eligible"] is False


def test_model_service_facade_selects_provider_identity_without_agent_runtime():
    from app.models.service import select_model_for_purpose
    chosen = select_model_for_purpose(sample_catalog(), "image")
    assert chosen["eligible"] is True
    assert (chosen["profile_id"], chosen["connection_id"], chosen["model_name"]) == ("image-two", "two", "gpt-image-2")


@pytest.mark.parametrize("model_name,caps", [("sora-2", {}), ("opaque-alias", {"chat": "unsupported"})])
def test_legacy_non_chat_default_repairs_all_inherited_stages(client, monkeypatch, model_name, caps):
    from app import db
    from app.agent import bootstrap
    from app.agent.model_catalog import get_model_catalog, update_model_profile
    from app.agent.model_purposes import save_purpose_default
    _, chat = add_service(client, "chat-stages")
    _, other = add_service(client, "non-chat-stages", model_name)
    if caps:
        update_model_profile(other["id"], {"capabilities": caps})
    save_purpose_default("chat", {"profile_id": chat["id"], "expected_version": get_model_catalog()["purpose_version"]})
    # Historical installations could retain a non-chat default before purpose
    # defaults existed; only their inherited stages should be repaired.
    with db.connect() as conn:
        conn.execute("UPDATE agent_settings SET default_model_profile_id=? WHERE id=1", (other["id"],))
    monkeypatch.setattr(bootstrap, "_cached_components", lambda connection: (connection, {}))
    result = bootstrap.get_agent_runtime(user_content="你好")
    assert {value["profile_id"] for value in result["stage_selections"].values()} == {chat["id"]}


def test_preview_respects_saved_strict_image_capability_policy(client):
    from app.agent.model_router import get_routing_policy, save_routing_policy
    _, image = add_service(client, "strict", "gpt-image-2")
    policy = get_routing_policy()
    save_routing_policy({"roles": {}, "strict_capabilities": True, "expected_version": policy["version"]})
    response = client.post("/agent/model-selection/preview", json={"purpose": "image", "profile_id": image["id"]})
    assert response.status_code == 200
    assert response.json()["eligible"] is False
    assert "确认" in response.json()["reason"]
