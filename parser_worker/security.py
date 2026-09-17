from __future__ import annotations

import ctypes
import os
import re
import sqlite3
from ctypes import wintypes
from pathlib import Path


_REDACTIONS = (
    re.compile(r"(?i)\b(api[_-]?hash|bot[_-]?token|openrouter[_-]?(?:api[_-]?)?key|password|2fa|session)\s*[:=]\s*\S+"),
    re.compile(r"(?i)(authorization\s*:\s*bearer\s+)\S+"),
    re.compile(r"(?<!\d)\+\d[\d\s()\-]{7,}\d"),
)


def redact_text(value: object) -> str:
    text = str(value or "").replace("\r", " ").replace("\n", " ")
    text = re.sub(r"[\x00-\x1f\x7f]+", " ", text)
    for pattern in _REDACTIONS:
        if pattern.pattern.startswith("(?i)(authorization"):
            text = pattern.sub(r"\1[redacted]", text)
        elif "api[_-]?hash" in pattern.pattern:
            text = pattern.sub(lambda match: f"{match.group(1)}=[redacted]", text)
        else:
            text = pattern.sub("[redacted]", text)
    return re.sub(r"\s+", " ", text).strip()[:500]


if os.name == "nt":
    class _DataBlob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]


    _crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _crypt32.CryptProtectData.argtypes = [
        ctypes.POINTER(_DataBlob), wintypes.LPCWSTR, ctypes.POINTER(_DataBlob), ctypes.c_void_p,
        ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_DataBlob),
    ]
    _crypt32.CryptProtectData.restype = wintypes.BOOL
    _crypt32.CryptUnprotectData.argtypes = [
        ctypes.POINTER(_DataBlob), ctypes.POINTER(wintypes.LPWSTR), ctypes.POINTER(_DataBlob),
        ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_DataBlob),
    ]
    _crypt32.CryptUnprotectData.restype = wintypes.BOOL
    _kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    _kernel32.LocalFree.restype = ctypes.c_void_p


def _blob(value: bytes):
    buffer = ctypes.create_string_buffer(value)
    return _DataBlob(len(value), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte))), buffer


def _protect(value: bytes) -> bytes:
    if os.name != "nt":
        raise RuntimeError("Windows DPAPI is required for Parser secrets")
    source, source_buffer = _blob(value)
    entropy, entropy_buffer = _blob(b"JARVIS Parser v1")
    output = _DataBlob()
    if not _crypt32.CryptProtectData(
        ctypes.byref(source), "JARVIS Parser", ctypes.byref(entropy), None, None, 0x1, ctypes.byref(output)
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(output.pbData, output.cbData)
    finally:
        _kernel32.LocalFree(output.pbData)
        del source_buffer, entropy_buffer


def _unprotect(value: bytes) -> bytes:
    if os.name != "nt":
        raise RuntimeError("Windows DPAPI is required for Parser secrets")
    source, source_buffer = _blob(value)
    entropy, entropy_buffer = _blob(b"JARVIS Parser v1")
    output = _DataBlob()
    description = wintypes.LPWSTR()
    if not _crypt32.CryptUnprotectData(
        ctypes.byref(source), ctypes.byref(description), ctypes.byref(entropy), None, None, 0x1, ctypes.byref(output)
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(output.pbData, output.cbData)
    finally:
        if description:
            _kernel32.LocalFree(description)
        _kernel32.LocalFree(output.pbData)
        del source_buffer, entropy_buffer


class DpapiSecretStore:
    def __init__(self, database_path: str | Path):
        self.database_path = Path(database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.database_path, timeout=5)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=FULL")
        self.connection.execute(
            "CREATE TABLE IF NOT EXISTS encrypted_secrets (name TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
        )
        self.connection.commit()

    def set(self, name: str, value: str) -> None:
        if not re.fullmatch(r"[a-z][a-z0-9_]{1,63}", str(name)):
            raise ValueError("Invalid secret name")
        encrypted = _protect(str(value).encode("utf-8"))
        self.connection.execute(
            "INSERT INTO encrypted_secrets(name, value, updated_at) VALUES(?, ?, CURRENT_TIMESTAMP) "
            "ON CONFLICT(name) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP",
            (name, sqlite3.Binary(encrypted)),
        )
        self.connection.commit()

    def get(self, name: str) -> str | None:
        row = self.connection.execute("SELECT value FROM encrypted_secrets WHERE name=?", (name,)).fetchone()
        if row is None:
            return None
        return _unprotect(bytes(row[0])).decode("utf-8")

    def has(self, name: str) -> bool:
        return self.connection.execute("SELECT 1 FROM encrypted_secrets WHERE name=?", (name,)).fetchone() is not None

    def delete(self, name: str) -> None:
        self.connection.execute("DELETE FROM encrypted_secrets WHERE name=?", (name,))
        self.connection.commit()

    def close(self) -> None:
        self.connection.close()
