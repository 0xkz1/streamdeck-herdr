#!/usr/bin/env python3
"""作業中の Claude Code が「いま何をしているか」を、画面の文字から判定する。  出力: {"<pane>": "<動作>", ...}
動作: read / write / run / search / web / agent / think (道具を使っていない)
Claude Code にしか効かない(他のエージェントは判定しない)。画面の表記が変わると外れるので、外れたら think になるだけ。
"""
import os
import json
import re
import subprocess

HERDR = os.path.expanduser("~/.local/bin/herdr")

# 下から探して、最初に当たった道具の行で決める。進行形(Reading…)も過去形(Read 2 files)もある
RULES = [
    ("web", r"\b(Fetching|Fetched|WebFetch|WebSearch|Searching the web|web search)\b"),
    ("agent", r"\b(Task\(|Agent\(|subagent|Spawn(ed|ing))"),
    ("write", r"\b(Editing|Edited|Writing|Wrote|Updating|Updated|Creating|Created|Write\(|Edit\(|Update\(|MultiEdit)\b"),
    ("run", r"\b(Running|Ran \d|Bash\(|Executing)\b"),
    ("search", r"\b(Searching|Searched|Grep\(|Glob\(|Listing|Listed|Search\()\b"),
    ("read", r"\b(Reading|Read \d|Read\(|Viewing)\b"),
]


def classify(screen: str) -> str:
    lines = [l for l in screen.splitlines() if l.strip()]
    # 入力欄より上の、直近の十数行だけ見る
    for line in reversed(lines[-30:]):
        s = line.strip().lstrip("●⎿✻✢✳⏺·• ").strip()
        for name, pat in RULES:
            if re.search(pat, s):
                return name
    return "think"


def main():
    out = {}
    agents = json.loads(subprocess.run([HERDR, "agent", "list"], capture_output=True, text=True, timeout=10).stdout)["result"]["agents"]
    for a in agents:
        if a["agent"] != "claude" or a["agent_status"] != "working":
            continue
        r = subprocess.run([HERDR, "agent", "read", a["pane_id"], "--source", "visible", "--lines", "40"], capture_output=True, text=True, timeout=10)
        out[a["pane_id"]] = classify(r.stdout)
    print(json.dumps(out))


if __name__ == "__main__":
    main()
