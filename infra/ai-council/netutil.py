#!/usr/bin/env python3
"""AI Council — общий SSL-контекст для исходящих HTTPS. Только stdlib.

Отдельный модуль, потому что копий этой функции уже было две (клиент Notion, удалён в OPS-26, и
.claude/scripts/glm_client.py), а с облачным ярусом стало бы три. Проблема одна и та же:
python.org-сборки на macOS не подхватывают системные CA, и любой urlopen к внешнему API
падает с CERTIFICATE_VERIFY_FAILED — не «иногда», а всегда, пока не запущен
`Install Certificates.command`.

Проверку сертификата не отключаем ни при каком фолбэке: молча ходить в облако без
верификации TLS — это не «удобно», это MITM-канал с ключами внутри.
"""
from __future__ import annotations

import ssl
from pathlib import Path

# Порядок: certifi (если установлен) → системный bundle macOS/Linux → дефолт Python.
_CA_CANDIDATES = ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt")


def ssl_context() -> ssl.SSLContext:
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass
    for candidate in _CA_CANDIDATES:
        if Path(candidate).exists():
            return ssl.create_default_context(cafile=candidate)
    return ssl.create_default_context()


SSL_CTX = ssl_context()
