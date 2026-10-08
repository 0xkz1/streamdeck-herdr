#!/usr/bin/env python3
"""Save Claude's session context for Herdr, then run the existing status line."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time


raw = sys.stdin.buffer.read()
try:
    data = json.loads(raw)
    session = data.get("session_id", "")
    model = (data.get("model") or {}).get("id")
    if re.fullmatch(r"[0-9a-f-]{36}", session) and isinstance(model, str) and model:
        # model-chime.sh が最初のメッセージ送信時に読む(Claude のフック入力にはモデル名が無い)
        chime = Path.home() / ".cache/model-chime/model"
        chime.mkdir(parents=True, exist_ok=True)
        (chime / session).write_text(model)
    context = data.get("context_window") or {}
    remaining = context.get("remaining_percentage")
    size = context.get("context_window_size")
    if re.fullmatch(r"[0-9a-f-]{36}", session) and isinstance(remaining, (int, float)) and isinstance(size, int) and size > 0:
        target = Path.home() / ".cache/herdr/context/claude" / f"{session}.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{session}.{os.getpid()}.tmp")
        saved = {"remainingPct": max(0, min(100, remaining)), "window": size, "updatedAt": time.time()}
        limits = data.get("rate_limits") or {}
        for name, key in (("fiveHour", "five_hour"), ("week", "seven_day")):
            used = (limits.get(key) or {}).get("used_percentage")
            if isinstance(used, (int, float)) and 0 <= used <= 100:
                saved[name] = round(100 - used)
        temporary.write_text(json.dumps(saved))
        os.replace(temporary, target)
except (OSError, ValueError, TypeError):
    pass

if len(sys.argv) > 1:
    result = subprocess.run(sys.argv[1:], input=raw, capture_output=True)
    sys.stdout.buffer.write(result.stdout)
    sys.stderr.buffer.write(result.stderr)
    sys.exit(result.returncode)
