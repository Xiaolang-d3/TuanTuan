from .contracts import ExecutionUnavailable
from .local_processes import process_identity


async def confirm_local_execution_stopped(record: dict) -> None:
    identity = record.get("identity")
    if not identity:
        # No handshake was released; the supervisor's bounded startup wait exits.
        return
    try:
        current = process_identity(identity["pid"])
    except (OSError, KeyError, TypeError) as exc:
        raise ExecutionUnavailable("无法确认原本机执行进程已停止") from exc
    if current is None or any(current.get(key) != identity.get(key) for key in ("created", "executable")):
        # Original identity no longer exists. Never kill a reused PID.
        return
    raise ExecutionUnavailable("原本机执行进程尚未停止，暂不能恢复或发布成果")
