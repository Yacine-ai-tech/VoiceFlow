"""
Relay payload formatting — /integrations/relay posts a JSON payload to
whatever webhook URL the caller gives it. That's sufficient for n8n and
Zapier catch-hooks: both accept arbitrary JSON and let the user map fields
downstream in their own UI, so no transformation is needed for them.

Slack incoming webhooks are different: they reject arbitrary JSON and only
accept {"text": "..."} or Block Kit's {"blocks": [...]}. Without this, a
raw VoiceFlow result payload posted to a Slack webhook URL just fails
silently on Slack's side. This module detects the target and reformats
only when the target actually needs it — n8n/Zapier/custom payloads pass
through completely unchanged.
"""
from __future__ import annotations

from typing import Any, Dict, Optional
from urllib.parse import urlparse


def detect_target(url: str) -> str:
    """Best-effort target detection from the URL. n8n is almost always
    self-hosted at an arbitrary domain, so there's no reliable pattern for
    it — pass target="n8n" explicitly if you want it labeled as such
    (it needs no special formatting either way)."""
    host = (urlparse(url).hostname or "").lower()
    if host.endswith("hooks.slack.com"):
        return "slack"
    if host.endswith("hooks.zapier.com"):
        return "zapier"
    return "generic"


def _format_value(value: Any, indent: int = 0) -> str:
    pad = "  " * indent
    if isinstance(value, dict):
        lines = []
        for k, v in value.items():
            if isinstance(v, (dict, list)) and v:
                lines.append(f"{pad}• *{k}*:")
                lines.append(_format_value(v, indent + 1))
            elif v not in (None, "", [], {}):
                lines.append(f"{pad}• *{k}*: {v}")
        return "\n".join(lines)
    if isinstance(value, list):
        lines = []
        for item in value[:10]:
            if isinstance(item, dict):
                summary = ", ".join(f"{k}: {v}" for k, v in item.items() if v not in (None, "", [], {}))
                lines.append(f"{pad}• {summary}")
            else:
                lines.append(f"{pad}• {item}")
        if len(value) > 10:
            lines.append(f"{pad}• … +{len(value) - 10} more")
        return "\n".join(lines)
    return f"{pad}{value}"


def to_slack_message(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Turn any VoiceFlow result (or custom JSON) into a readable Slack
    message. Works for every analysis_type's schema and custom-field
    extractions alike — it walks whatever keys are actually present rather
    than assuming one fixed shape."""
    if isinstance(payload.get("text"), str) and payload["text"].strip():
        return {"text": payload["text"]}

    title = payload.get("title") or payload.get("kind") or payload.get("event") or "VoiceFlow result"
    skip = {"title", "kind", "event"}
    body = _format_value({k: v for k, v in payload.items() if k not in skip})
    text = f"*{title}*" + (f"\n{body}" if body else "")
    text = text[:2900]  # Slack block text has a ~3000-char limit
    return {"blocks": [{"type": "section", "text": {"type": "mrkdwn", "text": text}}]}


def format_for_target(target: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    if target == "slack":
        return to_slack_message(payload)
    return payload  # n8n, zapier, generic/custom — sent through unchanged


def resolve_target(url: str, explicit: Optional[str]) -> str:
    explicit = (explicit or "").strip().lower()
    return explicit if explicit in ("slack", "zapier", "n8n", "generic") else detect_target(url)
