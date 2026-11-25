"""Classify image-request failures without exposing upstream diagnostics."""
from __future__ import annotations

import re

import httpx
from openai import APIConnectionError, APIStatusError

from .base import ModelProviderError


_MESSAGES = {
    "authentication_failed": "图片服务 API Key 无效，请检查或更新密钥。",
    "image_quota_exceeded": "图片服务额度不足，请检查账户余额或套餐额度。",
    "service_unavailable": "图片模型服务暂时不可用。",
    "image_model_connection_failed": "无法连接图片模型服务，请检查连接地址和网络。",
    "image_feature_unsupported": "当前模型服务不支持此图片功能，请切换支持该功能的模型。",
    "transparent_background_unsupported": "当前模型服务不支持透明背景，无法完成移除背景。请切换支持透明背景的图像模型。",
    "image_request_rejected": "服务拒绝了图片请求，请检查模型权限和请求参数。",
    "image_outcome_unknown": "未收到可确认的图片服务结果。",
}


class ImageRequestError(ModelProviderError):
    """A safe message plus independent evidence of non-execution."""

    def __init__(self, code: str, *, definitely_rejected: bool) -> None:
        self.definitely_rejected = definitely_rejected
        message = _MESSAGES[code]
        if not definitely_rejected:
            message += "暂未确认生成结果；未自动重新提交。"
        super().__init__(code, message)


_AUTH_CODES = {"invalid_api_key", "incorrect_api_key", "api_key_invalid", "invalid_token", "invalid_authentication"}
_QUOTA_CODES = {"insufficient_quota", "quota_exceeded", "billing_hard_limit_reached", "insufficient_credits", "insufficient_balance"}
_UNSUPPORTED_CODES = {"unsupported_model", "unsupported_endpoint", "unsupported_feature", "operation_not_supported", "model_not_found"}
_REJECTION_STATUSES = {400, 401, 402, 403, 404, 405, 422, 429, 501}
_UNSUPPORTED = re.compile(r"\b(?:not supported|unsupported|does not support|not available for)\b|不支持")
_IMAGE_FEATURE = re.compile(r"\b(?:image(?:s| generation| editing| edit|_generation)?|background|mask|tool|size|endpoint|operation)\b|图片|画幅")
_QUOTA = re.compile(r"\b(?:insufficient (?:quota|credits?|balance)|(?:exceeded|exhausted|insufficient) your (?:current )?quota|quota (?:exceeded|exhausted)|billing hard limit)\b|额度不足|余额不足")
_AUTH = re.compile(r"\b(?:invalid|incorrect|expired) api[ _-]?key\b|\bapi[ _-]?key (?:is )?(?:invalid|incorrect|expired)\b")


def _diagnostics(exc: APIStatusError) -> tuple[set[str], str]:
    # Use only structured fields or bounded provider message text as classifier
    # input; never attach any of these values to the public error.
    body = exc.body
    if isinstance(body, dict):
        error = body.get("error", body)
    else:
        error = body
    codes = (getattr(exc, "code", None), getattr(exc, "type", None))
    if isinstance(error, dict):
        codes += (error.get("code"), error.get("type"))
        error = error.get("message")
    return {value.lower() for value in codes if isinstance(value, str)}, error[:4096].lower() if isinstance(error, str) else ""


def image_request_error(exc: Exception) -> ImageRequestError:
    """Call only for the provider submission, before consuming output/streams."""
    if isinstance(exc, APIConnectionError) and isinstance(exc.__cause__, (httpx.ConnectError, httpx.ConnectTimeout)):
        return ImageRequestError("image_model_connection_failed", definitely_rejected=True)
    if isinstance(exc, APIStatusError):
        status = exc.status_code
        if status in _REJECTION_STATUSES:
            codes, detail = _diagnostics(exc)
            if status == 401 or codes & _AUTH_CODES or _AUTH.search(detail):
                code = "authentication_failed"
            elif status == 402 or codes & _QUOTA_CODES or _QUOTA.search(detail):
                code = "image_quota_exceeded"
            elif "transparent background" in detail and _UNSUPPORTED.search(detail):
                code = "transparent_background_unsupported"
            elif status in {404, 405, 501} or codes & _UNSUPPORTED_CODES or (_IMAGE_FEATURE.search(detail) and _UNSUPPORTED.search(detail)):
                code = "image_feature_unsupported"
            elif status == 429:
                code = "service_unavailable"
            else:
                code = "image_request_rejected"
            return ImageRequestError(code, definitely_rejected=True)
        if 500 <= status < 600:
            return ImageRequestError("service_unavailable", definitely_rejected=False)
    return ImageRequestError("image_outcome_unknown", definitely_rejected=False)
