#!/usr/bin/env python3
"""Claude / Codex が使用上限で止まったのを見つけて記録する(引き継ぎは自動でしない。人がボタンで押す)。

使い方:
  limit_watch.py scan                 全ペインを見て、台帳(~/.local/state/herdr-limit/state.json)を更新する。タイマーが2分ごとに呼ぶ
  limit_watch.py status               未処理の上限停止を JSON で出す(Stream Deck のキーが読む)
  limit_watch.py go <ID> [引き継ぎ先]    handoff.py --from-limit で引き継ぐ。先を省くと ORDER の先頭(上限中は飛ばす)
  limit_watch.py dismiss <ID>         見なかったことにする
  limit_watch.py digest <ペインID>      引き継ぎメモ用の抜粋を出す(確認用)

見つけ方: idle/done のペインで、画面の末尾の行が上限メッセージで「始まって」いたら上限停止とみなす。
文中の引用(「…」や `…`、箇条書き)は、行頭が記号なので当たらない。Claude 側の文面は未確認(Codex は実ログで確認済み)。
当たった行は台帳に残るので、外れていたら CLAUDE を直す。
"""
import fcntl
import glob
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
HERDR = os.path.expanduser("~/.local/bin/herdr")
STATE_DIR = os.path.expanduser("~/.local/state/herdr-limit")
STATE = os.path.join(STATE_DIR, "state.json")
TAIL = 25  # 画面の末尾から見る非空行の数
# 引き継ぎ先の優先順。Claude と Codex が先、そのあと Hermes、agy。いま上限で止まっているもの(下の limited_kinds)は飛ばす。先も上限なら handoff.py が失敗で止まる(それでよい)
ORDER = {"claude": ["codex", "hermes", "agy"], "codex": ["claude", "hermes", "agy"]}
START_ARGS = {"hermes": "-m deep-review", "agy": "--model gemini-3.1-pro-high"}  # どちらも Gemini 3.1 Pro(Hermes は LiteLLM 経由の API、agy は Antigravity)
LIMIT_WINDOW_H = 5  # 引き継ぎ済みでも、これだけの時間は「そのエージェントは上限中」とみなす(Claude の5時間枠)
LEAD = r"[\s■⎿✗✘⚠!│┃▌]*(?:(?:api )?error:\s*)?"
CLAUDE = r"(you'?ve hit your (usage )?limit|(5-hour|weekly|session|usage|opus) limit reached|claude usage limit reached)"
CODEX = r"you'?ve hit your usage limit"
LIMIT = {k: re.compile(LEAD + v, re.I) for k, v in (("claude", CLAUDE), ("codex", CODEX))}
RESET = re.compile(r"(?:try again at|resets?(?: at)?)\s*([0-9:]+\s*[ap]\.?m\.?|[0-9]{1,2}:[0-9]{2})", re.I)


def herdr(*args, timeout=20):
    r = subprocess.run([HERDR, *args], capture_output=True, text=True, timeout=timeout)
    try:
        return json.loads(r.stdout)
    except Exception:
        return {}


def tail_lines(pane):
    r = subprocess.run([HERDR, "agent", "read", pane, "--lines", "80"], capture_output=True, text=True, timeout=15)
    return [ln.rstrip() for ln in r.stdout.splitlines() if ln.strip()][-TAIL:]


def find_hit(kind, lines):
    return next((ln.strip() for ln in reversed(lines) if LIMIT[kind].match(ln)), None)


@contextmanager
def ledger():
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(os.path.join(STATE_DIR, "lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            st = json.load(open(STATE, encoding="utf-8"))
        except Exception:
            st = {}
        st.setdefault("events", {})
        st.setdefault("rev", {})
        yield st
        tmp = STATE + ".tmp"
        json.dump(st, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        os.replace(tmp, STATE)


def scan():
    panes = {p["pane_id"]: p for p in herdr("pane", "list").get("result", {}).get("panes", [])}
    now = datetime.now().isoformat(timespec="seconds")
    with ledger() as st:
        for ev in st["events"].values():  # 消えた/動き出したペインの未処理は、上限が解けたとみなして片付ける
            p = panes.get(ev["pane_id"])
            if ev["status"] == "pending" and (not p or p.get("agent_status") == "working" or p.get("terminal_id") != ev["terminal_id"]):
                ev["status"] = "cleared"
        for pid, p in panes.items():
            kind = p.get("agent")
            if kind not in LIMIT or p.get("agent_status") not in ("idle", "done"):
                continue
            if st["rev"].get(pid) == p.get("revision"):  # 画面が変わっていなければ読み直さない
                continue
            st["rev"][pid] = p.get("revision")
            line = find_hit(kind, tail_lines(pid))
            mine = [e for e in st["events"].values() if e["pane_id"] == pid and e["status"] == "pending"]
            if not line:
                for e in mine:
                    e["status"] = "cleared"
                continue
            eid = hashlib.sha1(f"{p.get('terminal_id')}|{line}".encode()).hexdigest()[:8]
            if eid in st["events"]:
                continue  # 同じ停止は一度だけ(処理済み・片付け済みも含む)
            m = RESET.search(line)
            st["events"][eid] = {
                "id": eid, "status": "pending", "pane_id": pid, "terminal_id": p.get("terminal_id"), "agent": kind,
                "cwd": p.get("cwd"), "label": p.get("label") or p.get("terminal_title_stripped") or "",
                "session": (p.get("agent_session") or {}).get("value"), "line": line[:200],
                "reset": m.group(1).rstrip(".") if m else "", "detected_at": now,
            }
            print(f"{now} limit: {kind} {pid} {line[:80]}", flush=True)
        st["rev"] = {k: v for k, v in st["rev"].items() if k in panes}


def limited_kinds(events, now=None):
    now = now or datetime.now()
    return {e["agent"] for e in events if e["status"] in ("pending", "handed")
            and (now - datetime.fromisoformat(e["detected_at"])).total_seconds() < LIMIT_WINDOW_H * 3600}


def pick_target(agent, limited):
    return next((k for k in ORDER[agent] if k not in limited), ORDER[agent][0])


def pending():
    with ledger() as st:
        return [e for e in st["events"].values() if e["status"] == "pending"]


def status():
    with ledger() as st:
        limited = limited_kinds(st["events"].values())
        ev = sorted((e for e in st["events"].values() if e["status"] == "pending"), key=lambda e: e["detected_at"])
    print(json.dumps({"pending": len(ev), "events": [{**e, "target": pick_target(e["agent"], limited)} for e in ev]}, ensure_ascii=False))


def mark(eid, status):
    with ledger() as st:
        if eid in st["events"]:
            st["events"][eid]["status"] = status


def go(eid, target=None):
    with ledger() as st:
        limited = limited_kinds(st["events"].values())
    ev = next((e for e in pending() if e["id"] == eid), None)
    if not ev:
        sys.exit(f"no pending event: {eid}")
    mark(eid, "handed")  # 先に印を付ける。二重に押されても、引き継ぎが2つ立たない
    target = target or pick_target(ev["agent"], limited)
    env = {**os.environ, "HANDOFF_START_ARGS": os.environ.get("HANDOFF_START_ARGS", START_ARGS.get(target, ""))}
    r = subprocess.run([sys.executable, os.path.join(HERE, "handoff.py"), "--from-limit", ev["pane_id"], target], env=env)
    sys.exit(r.returncode)


# ---- 会話記録から引き継ぎメモの材料を取る(上限で止まった本人はメモを書けない) ----

def text_of(content):
    if isinstance(content, str):
        return content
    return "\n".join(b.get("text", "") for b in content or [] if isinstance(b, dict) and b.get("type") in ("text", "input_text", "output_text"))


def find_transcript(kind, session, cwd):
    if kind == "claude":
        if session:
            hit = glob.glob(os.path.expanduser(f"~/.claude/projects/*/{session}.jsonl"))
            if hit:
                return hit[0]
        files = glob.glob(os.path.expanduser("~/.claude/projects/" + cwd.replace("/", "-") + "/*.jsonl"))
    else:
        files = glob.glob(os.path.expanduser(f"~/.codex/sessions/*/*/*/rollout-*{session}.jsonl")) if session else []
        if files:
            return files[0]
        files = []
        for f in sorted(glob.glob(os.path.expanduser("~/.codex/sessions/*/*/*/rollout-*.jsonl")), key=os.path.getmtime, reverse=True)[:30]:
            try:
                if json.loads(open(f, encoding="utf-8").readline()).get("payload", {}).get("cwd") == cwd:
                    return f
            except Exception:
                pass
    return max(files, key=os.path.getmtime) if files else None


def messages(path):
    """[(role, text)] を古い順に。システム注入(<…> や AGENTS.md)は除く"""
    out = []
    for ln in open(path, encoding="utf-8", errors="replace"):
        try:
            d = json.loads(ln)
        except Exception:
            continue
        if d.get("type") in ("user", "assistant") and "message" in d:  # Claude
            role, text = d["type"], text_of(d["message"].get("content"))
        elif d.get("type") == "response_item" and d.get("payload", {}).get("type") == "message":  # Codex
            role, text = d["payload"].get("role"), text_of(d["payload"].get("content"))
        else:
            continue
        text = text.strip()
        if role in ("user", "assistant") and text and not text.startswith(("<", "# AGENTS.md", "Caveat:", "This session is being continued")):
            out.append((role, text))
    return out


def digest(kind, session, cwd, screen):
    path = find_transcript(kind, session, cwd)
    msgs = messages(path) if path else []
    users = [t for r, t in msgs if r == "user"][-5:]
    last = next((t for r, t in reversed(msgs) if r == "assistant"), "")
    clip = lambda t, n: t if len(t) <= n else t[:n] + " …(省略)"
    parts = ["# 直近のユーザー指示(古い順。最後が最新)"]
    parts += [f"{i}. {clip(t, 700)}" for i, t in enumerate(users, 1)] or ["(会話記録が見つからなかった)"]
    parts += ["", "# 元のエージェントの最後の発言", clip(last, 2000) or "(なし)", "", "# 画面の最後の部分", "```", screen.rstrip(), "```",
              "", f"会話記録: {path or '(なし)'}"]
    return "\n".join(parts)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "scan":
        scan()
    elif cmd == "status":
        status()
    elif cmd == "go" and len(sys.argv) > 2:
        go(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
    elif cmd == "dismiss" and len(sys.argv) > 2:
        mark(sys.argv[2], "dismissed")
    elif cmd == "digest" and len(sys.argv) > 2:
        a = herdr("agent", "get", sys.argv[2]).get("result", {}).get("agent", {})
        print(digest(a.get("agent"), (a.get("agent_session") or {}).get("value"), a.get("cwd", ""), "\n".join(tail_lines(sys.argv[2]))))
    else:
        sys.exit(__doc__)
