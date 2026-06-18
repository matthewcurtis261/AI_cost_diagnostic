#!/usr/bin/env python3
"""Build a committed snapshot from the curated seed when HuggingFace is unavailable."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEED_PATH = ROOT / "data" / "quality-scores.seed.json"
OUTPUT_PATH = ROOT / "data" / "quality-scores.snapshot.json"


def main() -> int:
    if not SEED_PATH.exists():
        print(f"Missing seed file: {SEED_PATH}")
        return 1
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SEED_PATH, OUTPUT_PATH)
    data = json.loads(OUTPUT_PATH.read_text(encoding="utf-8"))
    print(f"Wrote {OUTPUT_PATH} from seed ({data['coverage']['total_models']} models)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
