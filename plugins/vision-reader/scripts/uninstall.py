#!/usr/bin/env python3
"""Uninstall the vision_reader custom agent and router config.

Removes the generated agent file. The merged router config is preserved:
  - removes ~/.codex/agents/vision-reader.toml
  - keeps ~/.codex/vision-router.json

To remove the plugin itself, run: codex plugin remove vision-reader@codex-cliproxy
"""
from __future__ import annotations

import os
from pathlib import Path


def main() -> int:
    codex_home = Path(
        os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))
    ).expanduser()

    targets = [codex_home / "agents" / "vision-reader.toml"]

    removed = False
    for target in targets:
        if target.is_dir():
            continue
        if target.exists() or target.is_symlink():
            target.unlink()
            print(f"Removed: {target}", flush=True)
            removed = True

    if not removed:
        print("Nothing to remove.", flush=True)

    print(f"Preserved merged config: {codex_home / 'vision-router.json'}", flush=True)
    print(
        "\nTo remove the plugin itself: codex plugin remove vision-reader@codex-cliproxy",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
