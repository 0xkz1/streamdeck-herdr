#!/usr/bin/env python3
"""Claude のプラン使用率を JSON で出す: {"session":{"pct":8,"resets":"..."},"week":{...}}。`claude -p /usage` はモデルを呼ばない(トークン消費なし)。"""
import json, os, re, shutil, subprocess, sys
CLAUDE = shutil.which("claude") or os.path.expanduser("~/.local/bin/claude")
out = subprocess.run([CLAUDE, "-p", "/usage"], capture_output=True, text=True, timeout=45, cwd="/tmp").stdout
res = {}
for key, label in (("session", "Current session"), ("week", "Current week \\(all models\\)")):
    m = re.search(label + r":\s*(\d+)% used(?: · resets ([^\n]+))?", out)
    if m:
        res[key] = {"pct": int(m.group(1)), "resets": (m.group(2) or "").strip()}
if not res:
    sys.exit("usage not found")
print(json.dumps(res, ensure_ascii=False))
