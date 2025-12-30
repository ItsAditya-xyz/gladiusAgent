import json
import logging
import os
from typing import Any

_CONFIGURED = False


def setup_logging() -> None:
    global _CONFIGURED
    if _CONFIGURED:
        return
    level = os.getenv("LOG_LEVEL", "INFO").upper()
    if level not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
        level = "INFO"
    logging.basicConfig(
        level=level,
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    )
    for noisy in ("httpx", "openai", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    _CONFIGURED = True


def get_logger(name: str) -> logging.Logger:
    setup_logging()
    return logging.getLogger(name)


def compact_json(obj: Any, max_len: int = 1200) -> str:
    try:
        text = json.dumps(obj, ensure_ascii=True, sort_keys=True)
    except Exception:
        text = str(obj)
    if len(text) > max_len:
        return text[:max_len] + "...(truncated)"
    return text
