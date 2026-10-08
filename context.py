#!/usr/bin/env python3
"""Return the latest known per-pane context and quota headroom for Herdr."""

import json
import datetime
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys

HOME = Path.home()
CODEX = HOME / ".codex/sessions"
CLAUDE = HOME / ".cache/herdr/context/claude"
OPENCODE_DB = HOME / ".local/share/opencode/opencode.db"
OPENCODE_MODELS = HOME / ".cache/opencode/models.json"


def metric(window, used, approximate=True):
    if not isinstance(window, (int, float)) or not isinstance(used, (int, float)) or window <= 0 or used < 0:
        return None
    left = max(0, round(window - used))
    return {"remainingTokens": left, "remainingPct": max(0, min(100, round(left / window * 100))), "approximate": approximate}


def claude(session):
    if not re.fullmatch(r"[0-9a-f-]{36}", session):
        return None
    try:
        data = json.loads((CLAUDE / f"{session}.json").read_text())
        pct, window = data["remainingPct"], data["window"]
        if 0 <= pct <= 100 and window > 0:
            value = {"remainingTokens": round(window * pct / 100), "remainingPct": round(pct), "approximate": True}
            for name in ("fiveHour", "week"):
                if isinstance(data.get(name), (int, float)):
                    value[name] = data[name]
            return value
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None


def codex(session, files):
    path = files.get(session)
    if not path:
        return None
    last = None
    rates = None
    try:
        with path.open(errors="replace") as handle:
            for line in handle:
                if '"token_count"' not in line:
                    continue
                event = json.loads(line)
                payload = event.get("payload") or {}
                if event.get("type") == "event_msg" and payload.get("type") == "token_count" and payload.get("info"):
                    last = payload["info"]
                    rates = payload.get("rate_limits") or {}
    except (OSError, ValueError):
        return None
    if not last:
        return None
    usage = last.get("last_token_usage") or {}
    prompt = usage.get("input_tokens")
    output = usage.get("output_tokens", 0)
    if not isinstance(prompt, (int, float)) or not isinstance(output, (int, float)):
        return None
    value = metric(last.get("model_context_window"), prompt + output)
    if value:
        for name, key in (("fiveHour", "primary"), ("week", "secondary")):
            used = (rates.get(key) or {}).get("used_percent") if isinstance(rates, dict) else None
            if isinstance(used, (int, float)) and 0 <= used <= 100:
                value[name] = round(100 - used)
    return value


def codex_session_for_pane(pane, candidates):
    """Match older Codex panes only when process start and rollout start agree."""
    try:
        info = json.loads(subprocess.check_output(["herdr", "pane", "process-info", "--pane", pane], text=True, timeout=3))["result"]["process_info"]
        process = next(p for p in info["foreground_processes"] if p["name"] == "codex")
        stat = Path(f"/proc/{process['pid']}/stat").read_text().rsplit(")", 1)[1].split()
        boot = next(int(line.split()[1]) for line in Path("/proc/stat").read_text().splitlines() if line.startswith("btime "))
        started = boot + int(stat[19]) / os.sysconf("SC_CLK_TCK")
        nearest = sorted(((abs(stamp - started), session) for stamp, session, cwd in candidates if cwd == process["cwd"]), key=lambda x: x[0])
        if nearest and nearest[0][0] <= 120 and (len(nearest) == 1 or nearest[1][0] > 120):
            return nearest[0][1]
    except (OSError, ValueError, KeyError, StopIteration, subprocess.SubprocessError):
        pass
    return None


def codex_candidates(files):
    result = []
    for session, path in files.items():
        try:
            with path.open(errors="replace") as handle:
                meta = json.loads(handle.readline())
            stamp = datetime.datetime.fromisoformat(meta["timestamp"].replace("Z", "+00:00")).timestamp()
            result.append((stamp, session, meta.get("payload", {}).get("cwd")))
        except (OSError, ValueError, KeyError):
            pass
    return result


def opencode(session, db, models):
    if not db:
        return None
    try:
        rows = db.execute("SELECT data FROM message WHERE session_id=? ORDER BY time_created DESC LIMIT 30", (session,))
        for (raw,) in rows:
            message = json.loads(raw)
            tokens = message.get("tokens") or {}
            used = tokens.get("total")
            if not isinstance(used, (int, float)) or used <= 0:
                continue
            provider = message.get("providerID")
            model = message.get("modelID")
            limit = models.get(provider, {}).get("models", {}).get(model, {}).get("limit", {})
            return metric(limit.get("context"), used)
    except (sqlite3.Error, ValueError, TypeError):
        pass
    return None


def hermes(pane):
    try:
        result = subprocess.run(["herdr", "pane", "read", pane, "--source", "visible", "--lines", "8"], capture_output=True, text=True, timeout=3)
        matches = re.findall(r"(\d+(?:\.\d+)?[KM])/(\d+(?:\.\d+)?[KM])\s*│", result.stdout, re.I)
        if not matches:
            return None
        def number(text):
            return float(text[:-1]) * (1000 if text[-1].upper() == "K" else 1000000)
        used, window = map(number, matches[-1])
        return metric(window, used)
    except (OSError, subprocess.TimeoutExpired):
        return None


def main():
    tabs = json.load(sys.stdin)
    # Session IDs are the UUID suffix; the rollout timestamp also contains hyphens.
    files = {}
    if CODEX.exists():
        for path in CODEX.rglob("rollout-*.jsonl"):
            match = re.search(r"([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$", path.name)
            if match:
                files[match.group(1)] = path
    candidates = None
    try:
        db = sqlite3.connect(f"file:{OPENCODE_DB}?mode=ro", uri=True)
    except sqlite3.Error:
        db = None
    try:
        models = json.loads(OPENCODE_MODELS.read_text())
    except (OSError, ValueError):
        models = {}
    result = {}
    for tab in tabs:
        pane, agent, session = tab.get("paneId"), tab.get("agent"), tab.get("sessionId")
        if not pane or not agent:
            continue
        value = None
        if agent == "claude" and session:
            value = claude(session)
        elif agent == "codex":
            if not session:
                if candidates is None:
                    candidates = codex_candidates(files)
                session = codex_session_for_pane(pane, candidates)
            if session:
                value = codex(session, files)
        elif agent == "opencode" and session:
            value = opencode(session, db, models)
        elif agent == "hermes":
            value = hermes(pane)
        if value:
            result[pane] = value
    if db:
        db.close()
    print(json.dumps(result))


if __name__ == "__main__":
    main()
