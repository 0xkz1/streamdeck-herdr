#!/usr/bin/env python3
"""One-line usage display for Herdr's bottom-right tab bar status area."""

import json
import os
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
HERDR = os.path.expanduser("~/.local/bin/herdr")


def compact(tokens):
    if tokens >= 1_000_000:
        return f"{tokens / 1_000_000:.1f}M"
    if tokens >= 1_000:
        return f"{round(tokens / 1_000)}k"
    return str(tokens)


def main():
    pane = os.environ.get("HERDR_ACTIVE_PANE_ID")
    if not pane:
        return
    snapshot = json.loads(subprocess.check_output([HERDR, "api", "snapshot"], timeout=3))["result"]["snapshot"]
    agent = next((a for a in snapshot["agents"] if a["pane_id"] == pane), None)
    if not agent:
        return
    tab = {"paneId": pane, "agent": agent["agent"], "sessionId": (agent.get("agent_session") or {}).get("value")}
    data = json.loads(subprocess.check_output([sys.executable, str(HERE / "context.py")], input=json.dumps([tab]).encode(), timeout=8))
    usage = data.get(pane)
    name = agent["agent"].capitalize()
    if not usage:
        print(f"{name} 使用量 —")
        return
    amount = f"~{compact(usage['remainingTokens'])}" if usage["approximate"] else compact(usage["remainingTokens"])
    parts = [f"{name} 残{amount} ({usage['remainingPct']}%)"]
    if "fiveHour" in usage:
        parts.append(f"5h残{usage['fiveHour']}%")
    if "week" in usage:
        parts.append(f"週残{usage['week']}%")
    print("  ".join(parts))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        pass
