"""Object operations against a pre-provisioned private Tencent Cloud COS bucket."""

import re
from contextlib import closing
from typing import Any

from boto3.session import Session
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from ..config import Settings


class CosAttachmentStorage:
    """Read, write and delete attachment objects over the COS S3 API."""

    def __init__(self, settings: Settings) -> None:
        if not settings.cos_configured:
            raise RuntimeError("缺少 COS_REGION、COS_BUCKET、COS_SECRET_ID 或 COS_SECRET_KEY")
        if not re.fullmatch(r"[a-z]+(?:-[a-z0-9]+)+", settings.cos_region):
            raise RuntimeError("COS_REGION 格式无效")
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]*-[0-9]+", settings.cos_bucket):
            raise RuntimeError("COS_BUCKET 必须包含存储桶名称与 APPID")
        self.bucket = settings.cos_bucket
        # COS 的 S3 接口使用虚拟主机寻址。禁止 SDK 自动添加分块校验尾部。
        self.client = Session().client(
            "s3",
            endpoint_url=f"https://cos.{settings.cos_region}.myqcloud.com",
            region_name=settings.cos_region,
            aws_access_key_id=settings.cos_secret_id,
            aws_secret_access_key=settings.cos_secret_key,
            config=Config(
                signature_version="s3",
                s3={"addressing_style": "virtual"},
                request_checksum_calculation="when_required",
                response_checksum_validation="when_required",
                connect_timeout=5,
                read_timeout=20,
                retries={"mode": "standard", "total_max_attempts": 3},
            ),
        )

    def _request(self, operation: str, key: str, **kwargs: Any) -> Any:
        try:
            return getattr(self.client, operation)(Bucket=self.bucket, Key=key, **kwargs)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"NoSuchKey", "404", "NotFound"}:
                if operation == "get_object":
                    raise ValueError("附件原文件不存在，可能已被移除") from exc
                if operation == "delete_object":
                    return None
            raise RuntimeError("COS 附件存储暂不可用") from exc
        except BotoCoreError as exc:
            raise RuntimeError("COS 附件存储暂不可用") from exc

    def put(self, key: str, content: bytes, content_type: str) -> None:
        """Upload one private attachment without creating or listing buckets."""
        self._request("put_object", key, Body=content, ContentType=content_type)

    def get(self, key: str) -> bytes:
        """Read the attachment body and always close the response."""
        response = self._request("get_object", key)
        try:
            with closing(response["Body"]) as body:
                return body.read()
        except BotoCoreError as exc:
            raise RuntimeError("COS 附件存储暂不可用") from exc

    def delete(self, key: str) -> None:
        """Delete an attachment object, allowing a repeated delete."""
        self._request("delete_object", key)
