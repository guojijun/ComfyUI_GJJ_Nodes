from __future__ import annotations

from typing import Any


def send_node_progress(
    unique_id: Any,
    text: str,
    progress: float | None = None,
    **extra: Any,
) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        payload: dict[str, Any] = {"node": str(unique_id), "text": str(text or "")}
        if progress is not None:
            payload["progress"] = max(0.0, min(1.0, float(progress)))
        for key, value in extra.items():
            if value is not None:
                payload[str(key)] = value
        PromptServer.instance.send_sync("gjj_node_progress", payload)
    except Exception:
        pass
