#!/usr/bin/env python3
"""Codex and Claude Code hook for conditional vision-subagent routing."""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

PLUGIN_ROOT = Path(
    os.environ.get("CLAUDE_PLUGIN_ROOT")
    or os.environ.get("PLUGIN_ROOT")
    or Path(__file__).resolve().parents[1]
)
DEFAULT_CONFIG = PLUGIN_ROOT / "config" / "default-config.json"
USER_CONFIG = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "vision-router.json"

IMAGE_MARKERS = (
    '"type":"image"', '"type": "image"',
    '"type":"localImage"', '"type": "localImage"',
    '"type":"input_image"', '"type": "input_image"',
    "data:image/", "<image", "[image]", "[图片]", "截图", "图片",
)

def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def merged_config(platform: str) -> dict[str, Any]:
    cfg = load_json(DEFAULT_CONFIG)
    if platform == "codex":
        cfg.update(load_json(USER_CONFIG))
    return cfg


def string_list(cfg: dict[str, Any], key: str) -> list[str]:
    value = cfg.get(key, [])
    return [str(item) for item in value] if isinstance(value, list) else []


def matches_any(value: str, patterns: list[str]) -> bool:
    for pattern in patterns:
        try:
            if re.search(pattern, value, re.IGNORECASE):
                return True
        except re.error:
            continue
    return False


def model_is_text_only(model: str, cfg: dict[str, Any]) -> bool:
    return matches_any(model, string_list(cfg, "text_only_model_patterns"))


def contains_image_signal(text: str, cfg: dict[str, Any]) -> bool:
    if not text:
        return False
    lower = text.lower()
    if any(marker.lower() in lower for marker in IMAGE_MARKERS):
        return True
    extensions = [value.lower() for value in string_list(cfg, "image_extensions")]
    if not extensions:
        return False
    ext_group = "|".join(re.escape(ext) for ext in extensions)
    return bool(re.search(rf"(?:^|[\s\"'=:(])[^\s\"']+(?:{ext_group})(?:$|[\s\"'),;:\]])", lower))


def transcript_tail(path_value: Any, max_bytes: int) -> str:
    if not path_value:
        return ""
    path = Path(str(path_value))
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - max_bytes))
            return handle.read().decode("utf-8", errors="replace")
    except OSError:
        return ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--platform", choices=("codex", "claude"), required=True
    )
    args = parser.parse_args()

    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError):
        return 0
    if not isinstance(payload, dict):
        return 0

    cfg = merged_config(args.platform)
    model = str(payload.get("model") or "")
    prompt = str(payload.get("prompt") or "")
    if args.platform == "claude":
        marker = "CLAUDE_VISION_ROUTER_V1"
        agent = "vision-reader:vision-reader"
        vision_model = os.environ.get("CLAUDE_PLUGIN_OPTION_VISION_MODEL", "sonnet")
        if not re.fullmatch(r"[A-Za-z0-9._:/-]{1,200}", vision_model):
            vision_model = "sonnet"
    else:
        marker = "CODEX_VISION_ROUTER_V1"
        agent = str(cfg.get("vision_agent") or "vision_reader")

    # Prevent recursive or duplicate routing instructions.
    if marker in prompt or str(payload.get("agent_type") or "") in {agent, "vision-reader"}:
        return 0
    if args.platform == "codex" and not model_is_text_only(model, cfg):
        return 0

    try:
        max_bytes = int(cfg.get("scan_transcript_bytes", 262144))
    except (TypeError, ValueError):
        max_bytes = 262144
    has_image = contains_image_signal(prompt, cfg)
    if not has_image:
        has_image = contains_image_signal(transcript_tail(payload.get("transcript_path"), max_bytes), cfg)
    if not has_image:
        return 0

    if args.platform == "claude":
        context = f"""{marker}
This plugin is enabled because the active main model is treated as text-only, and image content is present or referenced.
Before making any claim about the image, delegate the visual question to the `{agent}` custom subagent with the Agent tool and set the Agent call's `model` parameter to `{vision_model}` instead of inheriting the main model. Pass every relevant absolute local image path or attachment plus the user's exact question, include `{marker}` in the child task, and explicitly require the child to call `Read` for each local path before analysis. Wait for its structured report, then continue from that report. Keep the child task narrowly scoped and avoid copying unrelated repository context. Do not claim to see the image directly. If `Read` fails, report its exact error instead of guessing."""
    else:
        context = f"""{marker}
The active model `{model or 'unknown'}` is treated as text-only, and image content is present or referenced.
Before making any claim about the image, delegate the visual question to the `{agent}` custom subagent. Pass every relevant absolute local image path or attachment plus the user's exact question, include `{marker}` in the child task, and explicitly require the child to call `view_image` for each local path before analysis. Wait for its structured report, then continue from that report. Keep the child task narrowly scoped and avoid copying unrelated repository context. Do not claim to see the image directly. If `view_image` fails, report its exact error instead of guessing."""
    output = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": context,
        }
    }
    json.dump(output, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
