#!/usr/bin/env python3
"""全エージェントのセッションを俯瞰し、「今どれを優先すべきか」を日本語で出力する。

データ: herdr の稼働中エージェント(最新) + Claude/Codex の直近セッション履歴 + kanban の blocked。
優先順位は機械的に決め(確認待ち > 完了・結果待ち > 作業中 > 直近の未完了)、LLM は文章化だけを担当する。

使い方: priorities.py [--json]   (--json は LLM を呼ばず集めたデータを出す)
"""
import glob
import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.request

HOME = os.path.expanduser("~")
HERDR = f"{HOME}/.local/bin/herdr"
GATEWAY = "http://localhost:4001/v1/chat/completions"
ENV_FILE = os.path.expanduser(os.environ.get("HERDR_ENV_FILE", "~/.config/herdr-deck/.env"))  # LITELLM_MASTER_KEY / GEMINI_API_KEY をここから読む
MODEL = "mistral-medium"
RECENT_HOURS = 48
MAX_ITEMS = 12


def clip(s: str, n: int) -> str:
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


def tail_lines(path: str, nbytes: int = 400_000):
    with open(path, "rb") as f:
        f.seek(0, 2)
        size = f.tell()
        f.seek(max(0, size - nbytes))
        data = f.read().decode("utf-8", "ignore")
    for line in data.splitlines()[1:] if size > nbytes else data.splitlines():
        try:
            yield json.loads(line)
        except json.JSONDecodeError:
            continue


def text_of(content) -> str:
    if isinstance(content, str):
        return content
    return " ".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") in ("text", "input_text", "output_text"))


# ---------- herdr: 稼働中(最新の真実) ----------
def live_agents() -> list[dict]:
    snap = json.loads(subprocess.run([HERDR, "api", "snapshot"], capture_output=True, text=True, timeout=10).stdout)["result"]["snapshot"]
    ws = {w["workspace_id"]: w["label"] for w in snap["workspaces"]}
    tabs = {t["tab_id"]: t["label"] for t in snap["tabs"]}
    out = []
    for a in snap["agents"]:
        item = {
            "source": "live",
            "agent": a["agent"],
            "status": a["agent_status"],
            "where": f'{ws.get(a["workspace_id"], "?")}/{tabs.get(a["tab_id"], "?")}',
            "title": a.get("terminal_title_stripped", ""),
            "cwd": a.get("cwd", ""),
            "session": (a.get("agent_session") or {}).get("value", ""),
        }
        if a["agent_status"] in ("blocked", "done"):
            r = subprocess.run([HERDR, "agent", "read", a["pane_id"], "--lines", "40"], capture_output=True, text=True, timeout=10)
            item["screen_tail"] = clip(r.stdout, 1200)
        out.append(item)
    return out


# ---------- セッション履歴 ----------
def claude_sessions(since: float) -> list[dict]:
    out = []
    for path in glob.glob(f"{HOME}/.claude/projects/*/*.jsonl"):
        mt = os.path.getmtime(path)
        if mt < since:
            continue
        user = asst = cwd = ""
        for e in tail_lines(path):
            cwd = e.get("cwd") or cwd
            m = e.get("message") or {}
            t = text_of(m.get("content", "")) if m else ""
            if e.get("type") == "user" and t and not t.startswith(("<", "[Request interrupted", "This session is being continued", "Caveat:")):
                user = t
            elif e.get("type") == "assistant" and t:
                asst = t
        if len(user) >= 12:  # 「hi」「push して」のような短い依頼は優先度の材料にならない
            out.append({"source": "history", "agent": "claude", "mtime": mt, "cwd": cwd, "session": os.path.basename(path)[:-6],
                        "last_request": clip(user, 300), "last_reply": clip(asst, 500)})
    return out


def codex_sessions(since: float) -> list[dict]:
    out = []
    for path in glob.glob(f"{HOME}/.codex/sessions/*/*/*/rollout-*.jsonl"):
        mt = os.path.getmtime(path)
        if mt < since:
            continue
        user = asst = ""
        for e in tail_lines(path):
            p = e.get("payload") or {}
            if e.get("type") == "response_item" and p.get("type") == "message":
                t = text_of(p.get("content", []))
                if p.get("role") == "user" and t and not t.startswith("<"):
                    user = t
                elif p.get("role") == "assistant" and t:
                    asst = t
        if len(user) >= 12:
            out.append({"source": "history", "agent": "codex", "mtime": mt, "cwd": "", "session": path.rsplit("-", 5)[-5:][0] if False else os.path.basename(path),
                        "last_request": clip(user, 300), "last_reply": clip(asst, 500)})
    return out


def kanban_blocked() -> list[str]:
    p = f"{HOME}/.hermes/kanban.db"
    if not os.path.exists(p):
        return []
    try:
        return [clip(r[0], 24) for r in sqlite3.connect(p).execute("select title,status from tasks where status='blocked'")]
    except sqlite3.Error:
        return []


# ---------- 優先順位(機械的) ----------
RANK = {"blocked": 0, "done": 1, "working": 2, "idle": 3, "unknown": 4}


# ディレクトリ名 → 声に出す名前
READINGS = {}  # プロジェクト名の読み替え(例: {"my-project": "マイプロジェクト"})

def ago(minutes: int) -> str:
    if minutes < 60:
        return f"{minutes}分前"
    if minutes < 60 * 24:
        return f"{minutes // 60}時間前"
    return f"{minutes // (60 * 24)}日前"


JP = {"blocked": "確認待ち", "done": "完了して結果待ち", "working": "作業中", "idle": "待機中"}


def tidy(a: dict) -> dict:
    """LLM が読み間違えない形にする: 状態は日本語、プロジェクト名はディレクトリ名、題名の接頭辞は除く"""
    a = dict(a)
    if a["source"] == "live":
        a["状態"] = JP.get(a.pop("status"), "不明")
        a["題名"] = a.pop("title", "").removeprefix("OC | ")
        name = os.path.basename(a.pop("cwd", "").rstrip("/"))
        a["プロジェクト"] = READINGS.get(name, name) or a["where"]
    else:
        name = os.path.basename(a.pop("cwd", "").rstrip("/"))
        a["プロジェクト"] = READINGS.get(name, name) or "不明"
        a["いつ"] = ago(a.pop("ago_min"))
        a.pop("status", None)
    for k in ("session", "where", "source"):
        a.pop(k, None)
    return a


def collect() -> list[dict]:
    since = time.time() - RECENT_HOURS * 3600
    live = live_agents()
    live_ids = {a["session"] for a in live if a["session"]}
    hist = [h for h in claude_sessions(since) + codex_sessions(since) if not any(i and i in h["session"] for i in live_ids)]
    now = time.time()
    for h in hist:
        h["status"] = "history"
        h["ago_min"] = int((now - h.pop("mtime")) / 60)
    live.sort(key=lambda a: RANK.get(a["status"], 9))
    hist.sort(key=lambda h: h["ago_min"])
    seen, uniq = set(), []
    for h in hist:  # 同じ場所の履歴は直近の1件だけ
        key = (h["agent"], h["cwd"])
        if key not in seen:
            seen.add(key)
            uniq.append(h)
    hist = uniq
    # 待機中・作業中は人の対応が要らないので個別には並べず、件数だけ伝える
    actionable = [a for a in live if a["status"] in ("blocked", "done")]
    busy = sum(1 for a in live if a["status"] == "working")
    return [tidy(a) for a in (actionable + hist)[:MAX_ITEMS]], busy


SYSTEM = (
    "必ず日本語だけで答える。あなたはユーザーの寡黙で頼れる相棒。敬語は使わず、短く言い切るタメ口(『〜してる』『〜だ』『決めてくれ』)で、無駄な語尾や愛想は付けず、仕事仲間に淡々と報告する。"
    "声で聞いて分かるよう、優先度の高い順に最大5件、1件1〜2文で伝える。"
    "入力のうち『対応が必要なエージェント』は既に優先順で、確認待ちが最優先。確認待ちは何の許可/質問かを画面の内容から必ず言う(削除など取り消しにくい操作は強調)。"
    "『稼働していない直近の履歴』は、最後の返答(last_reply)がユーザーへの質問・確認・選択肢で終わっているものだけ拾う。依頼文(last_request)を引用して読み上げず、『何の話で、ユーザーは何を答えればいいか』を自分の言葉で一文にまとめる。同じプロジェクト名は一つにまとめる。経過時間は『いつ』の表記のまま言う。"
    "完結しているもの、単なる雑談や『pushして』のような済んだ依頼は言わない。最後に、作業中の件数があれば『ほかに○件、作業中だ』と一言、kanbanのblockedがあれば件数と、短い題名を一つだけ添えて一言。"
    "プロジェクト名は入力の表記のまま読み上げる。パス・ID・英語の状態名(history, idle など)は読み上げない。前置きと挨拶は不要。"
)


def master_key() -> str:
    for line in open(ENV_FILE, encoding="utf-8"):
        if line.startswith("LITELLM_MASTER_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    sys.exit("LITELLM_MASTER_KEY not found")


def main() -> None:
    items, busy = collect()
    payload = {"対応が必要なエージェント(優先順)": [i for i in items if "状態" in i],
               "稼働していない直近の履歴": [i for i in items if "状態" not in i],
               "作業中で対応不要な件数": busy, "kanbanのblocked": kanban_blocked()}
    if "--json" in sys.argv:
        print(json.dumps(payload, ensure_ascii=False, indent=1))
        return
    body = json.dumps({"model": MODEL, "max_tokens": 2000, "temperature": 0.2,
                       "messages": [{"role": "system", "content": SYSTEM},
                                    {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}]}).encode()
    req = urllib.request.Request(GATEWAY, body, {"Content-Type": "application/json", "Authorization": f"Bearer {master_key()}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        print(json.load(r)["choices"][0]["message"]["content"].strip())


if __name__ == "__main__":
    main()
