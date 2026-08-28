#!/usr/bin/env python3
"""Resolve run-task-with-model model selection: custom catalog or codex debug."""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


def load_json_file(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def models_from_catalog(value):
    if isinstance(value, dict) and isinstance(value.get("models"), list):
        return value["models"]
    if isinstance(value, list):
        return value
    raise ValueError("catalog must contain a models array")


def catalog_from_file(path):
    return models_from_catalog(load_json_file(path))


def catalog_from_codex_debug():
    result = subprocess.run(
        ["codex", "debug", "models"],
        check=True,
        capture_output=True,
        text=True,
    )
    return models_from_catalog(json.loads(result.stdout))


def load_catalog(explicit_path=None):
    if explicit_path and Path(explicit_path).is_file():
        return catalog_from_file(explicit_path), "custom", explicit_path
    env_path = os.getenv("USE_MODEL_CATALOG")
    if env_path and Path(env_path).is_file():
        return catalog_from_file(env_path), "custom", env_path
    # codex debug models resolves the same catalog the Codex host uses:
    # dynamic mode refreshes through the configured base URL, static mode
    # reads the file referenced by model_catalog_json.
    return catalog_from_codex_debug(), "codex-debug", "codex debug models"


def normalized_reasoning(value):
    if not isinstance(value, list):
        return []
    efforts = []
    for item in value:
        if isinstance(item, str):
            efforts.append(item)
        elif isinstance(item, dict) and isinstance(item.get("effort"), str):
            efforts.append(item["effort"])
    return efforts


def summarize_model(model):
    keys = (
        "slug", "display_name", "name", "aliases", "family", "variant",
        "rank", "priority", "default_reasoning_level",
    )
    summary = {key: model.get(key) for key in keys if model.get(key) is not None}
    supported = normalized_reasoning(model.get("supported_reasoning_levels"))
    if supported:
        summary["supported_reasoning_levels"] = supported
    return summary


def match_score(model, query):
    query = query.lower()
    values = [model.get("slug"), model.get("display_name"), model.get("name"), model.get("family"), model.get("variant")]
    aliases = model.get("aliases") or []
    if isinstance(aliases, str):
        aliases = [aliases]
    values.extend(aliases)
    values = [str(value).lower() for value in values if value]
    if any(value == query for value in values):
        return 2
    if any(query in value for value in values):
        return 1
    return 0


def model_rank(model):
    try:
        return float(model.get("rank") or model.get("priority") or 0)
    except (TypeError, ValueError):
        return 0


def is_flash(model):
    text = " ".join([
        str(model.get("variant", "")),
        str(model.get("slug", "")),
        str(model.get("display_name", "")),
    ]).lower()
    return "flash" in text


def is_free(model):
    text = " ".join([
        str(model.get("variant", "")),
        str(model.get("slug", "")),
        str(model.get("display_name", "")),
    ]).lower()
    return "free" in text


def select_model(models, requested):
    matches = [model for model in models if match_score(model, requested) > 0]
    if not matches:
        raise ValueError(f"no model matches {requested}")
    matches = [model for model in matches if not is_free(model)]
    if not matches:
        raise ValueError(f"no usable model matches {requested} (free models excluded)")
    ranked = sorted(
        matches,
        key=lambda model: (match_score(model, requested), model_rank(model), len(str(model.get("slug", "")))),
        reverse=True,
    )
    flash = [model for model in ranked if is_flash(model)]
    return flash if flash else ranked


def resolve_reasoning(model, requested):
    supported = normalized_reasoning(model.get("supported_reasoning_levels"))
    if requested:
        if supported and requested not in supported:
            return supported[-1]
        return requested
    if not supported:
        return "max"
    if "max" in supported:
        return "max"
    return supported[-1]


def main():
    parser = argparse.ArgumentParser(description="Resolve the model used by run-task-with-model")
    parser.add_argument("--model", help="model ID, alias, or family")
    parser.add_argument("--reasoning", help="reasoning level")
    parser.add_argument("--catalog", help="custom catalog JSON file")
    parser.add_argument("--list", action="store_true", help="list all models")
    args = parser.parse_args()

    models, source, catalog_source = load_catalog(args.catalog)
    if args.list:
        print(json.dumps({"source": source, "catalog_path": catalog_source, "models": [summarize_model(model) for model in models]}, ensure_ascii=False))
        return
    if not args.model:
        parser.error("--model or --list must be specified")

    try:
        preferred = select_model(models, args.model)
    except ValueError as error:
        print(json.dumps({"message": str(error)}, ensure_ascii=False))
        sys.exit(1)

    usable = [(model, resolve_reasoning(model, args.reasoning)) for model in preferred]

    if len(usable) > 1:
        print(json.dumps({
            "candidates": [
                {"model": model.get("slug"), "display_name": model.get("display_name"), "reasoning": reasoning}
                for model, reasoning in usable
            ],
        }, ensure_ascii=False, indent=2))
        return

    selected, reasoning = usable[0]
    print(json.dumps({
        "model": selected.get("slug"),
        "display_name": selected.get("display_name"),
        "reasoning": reasoning,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
