#!/usr/bin/env python3
"""Narrow, one-request JSON-lines worker. No shell, network, or process-spawning operations."""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = 1
MAX_INPUT_BYTES = 64 * 1024
MAX_PREVIEW_BYTES = 32 * 1024
MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
SECRET_PATTERNS = [
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----", re.I),
    re.compile(r"\b(?:sk-[A-Za-z0-9_-]{12,}|sk_live_[A-Za-z0-9]{12,}|sk_test_[A-Za-z0-9]{12,})\b"),
    re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\b(?:xox[baprs]-)[A-Za-z0-9-]{10,}\b"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._~+/\-]{12,}={0,2}", re.I),
    re.compile(r"\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)\s*([=:])\s*[\"']?([^\s\"'&,;]{4,})[\"']?", re.I),
]
SENSITIVE_KEYS = re.compile(r"(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|private[_-]?key|credential[_-]?value)", re.I)


def redact_text(text: str) -> str:
    result = text
    for pattern in SECRET_PATTERNS:
        def replace(match: re.Match[str]) -> str:
            label = match.group(1) if match.lastindex else None
            if label and SENSITIVE_KEYS.fullmatch(label):
                return f"{label}=[REDACTED]"
            return "[REDACTED]"
        result = pattern.sub(replace, result)
    return result


def fail(message: str, code: str = "WORKER_ERROR") -> dict[str, Any]:
    return {"ok": False, "error": {"code": code, "message": message}}


class PathDenied(ValueError):
    """Raised when a requested path is not safely contained in the workspace."""


def inside_root(path: Path, root: Path) -> Path:
    try:
        resolved_root = root.resolve(strict=True)
        candidate = path.resolve(strict=True)
        candidate.relative_to(resolved_root)
    except (OSError, ValueError):
        raise PathDenied("Requested path is missing or escapes the selected workspace.")
    if not candidate.is_file():
        raise ValueError("Requested path is not a regular file.")
    if candidate.stat().st_size > MAX_FILE_BYTES:
        raise ValueError("Requested file exceeds the worker size limit.")
    return candidate


def digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def handle_request(request: dict[str, Any]) -> dict[str, Any]:
    allowed_keys = {"protocolVersion", "id", "operation", "workspaceRoot", "path", "maxBytes"}
    if set(request) - allowed_keys:
        return fail("Request contains unsupported fields.", "INVALID_REQUEST")
    if request.get("protocolVersion") != PROTOCOL_VERSION:
        return fail("Unsupported worker protocol version.", "PROTOCOL_MISMATCH")
    request_id = request.get("id")
    if not isinstance(request_id, str) or not (1 <= len(request_id) <= 128):
        return fail("Request id must be a non-empty string of at most 128 characters.", "INVALID_REQUEST")
    operation = request.get("operation")
    if operation == "ping":
        return {"ok": True, "data": {"worker": "rsl-python-worker", "protocolVersion": PROTOCOL_VERSION, "pythonVersion": sys.version.split()[0]}}
    root_value = request.get("workspaceRoot")
    if not isinstance(root_value, str) or not Path(root_value).is_absolute():
        return fail("Workspace root must be an absolute path.", "INVALID_REQUEST")
    root = Path(root_value).resolve(strict=True)
    if not root.is_dir():
        return fail("Workspace root is not a directory.", "INVALID_REQUEST")
    relative_value = request.get("path")
    if not isinstance(relative_value, str) or not relative_value.strip():
        return fail("A workspace-relative path is required for this operation.", "INVALID_REQUEST")
    requested = Path(relative_value)
    if requested.is_absolute():
        return fail("Worker paths must be relative to the workspace root.", "PATH_DENIED")
    candidate = inside_root(root / requested, root)

    if operation == "hash_file":
        return {"ok": True, "data": {"relativePath": candidate.relative_to(root).as_posix(), "sizeBytes": candidate.stat().st_size, "sha256": digest_file(candidate)}}
    if operation == "inspect_file":
        with candidate.open("rb") as handle:
            header = handle.read(16)
        return {"ok": True, "data": {
            "relativePath": candidate.relative_to(root).as_posix(),
            "name": candidate.name,
            "suffix": candidate.suffix.lower(),
            "sizeBytes": candidate.stat().st_size,
            "modifiedAt": datetime.fromtimestamp(candidate.stat().st_mtime, timezone.utc).isoformat(),
            "sha256": digest_file(candidate),
            "headerHex": header.hex(),
        }}
    if operation == "read_text_preview":
        max_bytes = request.get("maxBytes", 8192)
        if not isinstance(max_bytes, int) or max_bytes < 1 or max_bytes > MAX_PREVIEW_BYTES:
            return fail("maxBytes must be an integer between 1 and 32768.", "INVALID_REQUEST")
        with candidate.open("rb") as handle:
            data = handle.read(max_bytes + 1)
        truncated = len(data) > max_bytes
        text = data[:max_bytes].decode("utf-8", errors="replace")
        return {"ok": True, "data": {"relativePath": candidate.relative_to(root).as_posix(), "text": redact_text(text), "truncated": truncated, "bytesReturned": min(len(data), max_bytes)}}
    return fail("Operation is not allow-listed by the Python worker.", "OPERATION_DENIED")


def main() -> int:
    raw = sys.stdin.buffer.readline(MAX_INPUT_BYTES + 1)
    if not raw or len(raw) > MAX_INPUT_BYTES or not raw.endswith(b"\n"):
        response = {"ok": False, "error": {"code": "INVALID_REQUEST", "message": "Request must be one newline-terminated JSON object under 64 KiB."}}
        sys.stdout.write(json.dumps({"protocolVersion": PROTOCOL_VERSION, "id": None, **response}, separators=(",", ":")) + "\n")
        return 0
    try:
        request = json.loads(raw.decode("utf-8"))
        if not isinstance(request, dict):
            response = fail("Request must be a JSON object.", "INVALID_REQUEST")
        else:
            response = handle_request(request)
    except (UnicodeDecodeError, json.JSONDecodeError):
        response = fail("Request JSON is malformed.", "INVALID_REQUEST")
    except PathDenied:
        response = fail("The requested path is missing or escapes the selected workspace.", "PATH_DENIED")
    except Exception as exc:  # no traceback or path-bearing exception is sent to renderer
        message = str(exc)
        if isinstance(exc, PermissionError):
            response = fail("The worker was not permitted to access the requested path.", "PATH_DENIED")
        else:
            response = fail(redact_text(message)[:300] or "Worker operation failed.")
    request_id = request.get("id") if isinstance(request, dict) and isinstance(request.get("id"), str) else None
    envelope = {"protocolVersion": PROTOCOL_VERSION, "id": request_id, **response}
    sys.stdout.write(json.dumps(envelope, separators=(",", ":"), ensure_ascii=True) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
