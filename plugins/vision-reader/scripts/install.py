#!/usr/bin/env python3
"""Install the vision_reader agent and merged Codex router config."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

PLUGIN_ROOT = Path(__file__).resolve().parents[1]


def load_object(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Could not read JSON object {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise RuntimeError(f"Expected a JSON object in {path}")
    return value


def catalog_text_only_patterns(codex_home: Path, profile: str | None) -> list[str]:
    command = ["codex"]
    if profile:
        command += ["--profile", profile]
    command += ["debug", "models"]
    env = os.environ.copy()
    env["CODEX_HOME"] = str(codex_home)
    try:
        result = subprocess.run(
            command,
            cwd=codex_home,
            env=env,
            text=True,
            capture_output=True,
            check=True,
            timeout=30,
        )
        catalog = json.loads(result.stdout)
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.strip() or str(exc)
        raise RuntimeError(f"Could not read the effective Codex model catalog: {detail}") from exc
    except (FileNotFoundError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Could not read the effective Codex model catalog: {exc}") from exc

    models = catalog.get("models") if isinstance(catalog, dict) else None
    if not isinstance(models, list):
        raise RuntimeError("Codex model catalog does not contain a models array")

    patterns: set[str] = set()
    for entry in models:
        if not isinstance(entry, dict) or not isinstance(entry.get("slug"), str):
            continue
        modalities = entry.get("input_modalities")
        if not isinstance(modalities, list) or not all(
            isinstance(value, str) for value in modalities
        ):
            continue
        normalized = {value.lower() for value in modalities}
        if "text" in normalized and "image" not in normalized:
            patterns.add(f"^{re.escape(entry['slug'])}$")
    return sorted(patterns)


def string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Install vision_reader agent and merged router config."
    )
    parser.add_argument(
        "--vision-model",
        default="gpt-5.6-luna",
        help="Vision-capable model slug for vision_reader (default: gpt-5.6-luna)",
    )
    parser.add_argument(
        "--codex-home",
        default=os.environ.get("CODEX_HOME", str(Path.home() / ".codex")),
        help="Codex home directory (default: ~/.codex)",
    )
    parser.add_argument(
        "--profile",
        help="Codex profile whose effective model catalog should be used",
    )
    args = parser.parse_args()

    codex_home = Path(args.codex_home).expanduser()
    agent_dest = codex_home / "agents" / "vision-reader.toml"
    config_dest = codex_home / "vision-router.json"
    codex_home.mkdir(parents=True, exist_ok=True)

    try:
        catalog_patterns = catalog_text_only_patterns(codex_home, args.profile)
        default_config = load_object(PLUGIN_ROOT / "config" / "default-config.json")
        existing_config = load_object(config_dest)
    except RuntimeError as exc:
        print(f"Installation aborted: {exc}", file=sys.stderr, flush=True)
        return 1

    config = {**default_config, **existing_config}
    config["text_only_model_patterns"] = list(
        dict.fromkeys(
            string_list(default_config.get("text_only_model_patterns"))
            + string_list(existing_config.get("text_only_model_patterns"))
            + catalog_patterns
        )
    )

    agent_dest.parent.mkdir(parents=True, exist_ok=True)
    template = (PLUGIN_ROOT / "agents" / "vision-reader.toml.template").read_text(
        encoding="utf-8"
    )
    rendered = template.replace("__VISION_MODEL__", args.vision_model.replace('"', ""))
    agent_dest.write_text(rendered, encoding="utf-8")
    print(f"Installed agent: {agent_dest}", flush=True)

    config_dest.write_text(
        json.dumps(config, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Merged config: {config_dest}", flush=True)
    print(f"Catalog text-only models: {len(catalog_patterns)}", flush=True)
    print(
        "\nDone. Restart Codex and start a new chat to activate the vision subagent.",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
