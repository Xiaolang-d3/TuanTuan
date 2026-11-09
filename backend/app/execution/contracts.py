from dataclasses import dataclass


class ExecutionUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class BackendStatus:
    available: bool
    code: str
    reason: str
    image: str = ""


@dataclass(frozen=True)
class ProcessResult:
    returncode: int
    stdout: str
    stderr: str
