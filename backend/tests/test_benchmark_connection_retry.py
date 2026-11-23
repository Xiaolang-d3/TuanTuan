import httpx
import pytest

from app.config import Settings
from app.feeds import benchmarks, media_benchmarks


@pytest.fixture(params=["language", "media"])
def fetch_benchmark(request):
    if request.param == "language":
        return benchmarks.fetch
    return lambda: media_benchmarks.fetch(media_benchmarks.BOARDS[0])


def use_official_transport(monkeypatch, handler):
    client = httpx.Client
    monkeypatch.setattr("app.config.get_settings", lambda: Settings(artificial_analysis_api_key="fixture-key"))
    monkeypatch.setattr(httpx, "Client", lambda **kwargs: client(transport=httpx.MockTransport(handler), **kwargs))


def test_benchmark_recovers_from_one_connection_timeout(monkeypatch, fetch_benchmark):
    requests = []

    def respond(request):
        requests.append(request)
        if len(requests) == 1:
            raise httpx.ConnectTimeout("connection failed", request=request)
        return httpx.Response(200, json={
            "tier": "free",
            "pagination": {"page": 1, "total_pages": 1, "has_more": False},
            "data": [{"id": "model-1", "name": "Official model"}],
        })

    use_official_transport(monkeypatch, respond)

    assert [model["id"] for model in fetch_benchmark()] == ["model-1"]
    assert len(requests) == 2
    assert requests[0].url == requests[1].url
    assert requests[1].headers["x-api-key"] == "fixture-key"


def test_benchmark_stops_after_a_second_connection_error(monkeypatch, fetch_benchmark):
    requests = []

    def reject(request):
        requests.append(request)
        raise httpx.ConnectError("private transport details", request=request)

    use_official_transport(monkeypatch, reject)

    with pytest.raises(ValueError, match="无法连接官方评测 API") as error:
        fetch_benchmark()
    assert "private transport details" not in str(error.value)
    assert len(requests) == 2


def test_benchmark_does_not_retry_quota_response(monkeypatch, fetch_benchmark):
    requests = []

    def limited(request):
        requests.append(request)
        return httpx.Response(429)

    use_official_transport(monkeypatch, limited)

    with pytest.raises(ValueError, match="请求额度受限"):
        fetch_benchmark()
    assert len(requests) == 1
