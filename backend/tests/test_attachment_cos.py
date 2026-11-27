from io import BytesIO
from unittest.mock import Mock

import pytest
from botocore.exceptions import ClientError

from app.api.attachments import attachments_file
from app.attachments import cos, service
from app.config import Settings
from app.db import init_db


@pytest.fixture
def cos_store(tmp_path, monkeypatch):
    settings = Settings(
        attachment_storage="cos",
        cos_region="ap-guangzhou",
        cos_bucket="attachments-1250000000",
        cos_secret_id="test-id",
        cos_secret_key="test-key",
    )
    monkeypatch.setattr(service, "get_settings", lambda: settings)
    store = service.AttachmentStore(tmp_path / "attachments", storage="cos")
    session = Mock()
    monkeypatch.setattr(cos, "Session", lambda: session)
    return store, session


def test_cos_upload_download_and_delete_without_local_copy(tmp_path, cos_store, monkeypatch):
    store, session = cos_store
    client = session.client.return_value
    db = tmp_path / "attachments.db"
    init_db(db)
    attachment = service.create_attachment(1, "document", "中文.txt", b"notes", db_path=db, store=store)
    _, params = client.put_object.call_args
    key = params["Key"]
    assert key.startswith("cos/")
    assert params == dict(Bucket="attachments-1250000000", Key=key, Body=b"notes", ContentType="text/plain")
    args, kwargs = session.client.call_args
    assert args == ("s3",)
    assert kwargs["endpoint_url"] == "https://cos.ap-guangzhou.myqcloud.com"
    assert kwargs["region_name"] == "ap-guangzhou"
    assert kwargs["config"].signature_version == "s3"
    assert kwargs["config"].s3 == {"addressing_style": "virtual"}
    assert kwargs["config"].request_checksum_calculation == "when_required"
    assert not store.local_root.exists()

    # 停止向 COS 写入时，之前的 COS 附件仍可下载并删除。
    local = service.AttachmentStore(store.local_root, storage="local")
    body = BytesIO(b"notes")
    client.get_object.return_value = {"Body": body}
    from app.api import attachments

    monkeypatch.setattr(attachments, "get_attachment_download", lambda attachment_id: service.get_attachment_download(
        attachment_id, db_path=db, store=local
    ))
    response = attachments_file(attachment["id"])
    assert response.body == b"notes"
    assert response.headers["content-disposition"] == "attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87.txt"
    assert body.closed
    assert not store.local_root.exists()
    assert service.delete_attachment(attachment["id"], db_path=db, store=local)
    client.delete_object.assert_called_once_with(Bucket="attachments-1250000000", Key=key)


def test_cos_preserves_legacy_local_attachments(tmp_path, cos_store):
    store, session = cos_store
    local = service.AttachmentStore(store.local_root)
    db = tmp_path / "attachments.db"
    init_db(db)
    attachment = service.create_attachment(1, "document", "old.txt", b"old", db_path=db, store=local)
    path, _, _ = service.get_attachment_download(attachment["id"], db_path=db, store=store)
    assert path.read_bytes() == b"old"
    assert service.delete_attachment(attachment["id"], db_path=db, store=store)
    assert not path.exists()
    session.client.assert_not_called()


def test_cos_reports_missing_objects_and_service_failure(cos_store):
    store, session = cos_store
    client = session.client.return_value
    client.get_object.side_effect = ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
    with pytest.raises(ValueError, match="原文件不存在"):
        store.get("cos/ab/attachment.txt")
    client.put_object.side_effect = ClientError({"Error": {"Code": "AccessDenied"}}, "PutObject")
    with pytest.raises(RuntimeError, match="COS 附件存储暂不可用"):
        store.put("attachment", "new.txt", b"data")
    assert not store.local_root.exists()
