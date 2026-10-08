#!/usr/bin/env python3
"""放置されたエージェントを、メッセージアプリに通知する常駐プログラム(Ubuntu 側。Mac が閉じていても動く)。

判定は「放置された時間」: 確認待ち(blocked)のまま BLOCKED_AFTER 秒、長い作業が完了(done)したまま DONE_AFTER 秒。
手元にいればすぐ対応されるので通知は飛ばず、外出中・離席中だけ飛ぶ。
宛先は `hermes send` の書式。プロジェクト別の宛先は ~/.hermes/notify-routes.json:
  {"default": "telegram", "projects": {"my-project": "telegram:<chat-id>", "other-project": "slack:#channel"}}
環境変数: NOTIFY_DRY=1 で送らず表示だけ / BLOCKED_AFTER, DONE_AFTER, LONG_WORK (秒)
"""
import json
import os
import subprocess
import time

HERDR = os.path.expanduser("~/.local/bin/herdr")
HERMES = os.path.expanduser("~/.local/bin/hermes")
NARRATE = os.path.expanduser("~/atelier/forge/streamdeck-herdr/narrate.py")
ROUTES = os.path.expanduser("~/.hermes/notify-routes.json")
BLOCKED_AFTER = int(os.environ.get("BLOCKED_AFTER", 90))
DONE_AFTER = int(os.environ.get("DONE_AFTER", 60))
LONG_WORK = int(os.environ.get("LONG_WORK", 120))  # これより長く働いた後の完了だけ通知
DRY = os.environ.get("NOTIFY_DRY") == "1"
COOLDOWN = 300  # 同じペインへの通知は5分に1回まで

state = {}  # pane -> {status, since, work_since, notified, last_sent}


def agents():
    r = subprocess.run([HERDR, "agent", "list"], capture_output=True, text=True, timeout=15)
    return json.loads(r.stdout)["result"]["agents"]


def route(project):
    try:
        r = json.load(open(ROUTES))
    except Exception:
        r = {}
    return (r.get("projects") or {}).get(project) or r.get("default") or "telegram"


def body(pane, kind, where):
    try:  # 画面の内容を LLM で短く要約(自動読み上げと同じもの)
        out = subprocess.run(["/usr/bin/python3", NARRATE, pane, kind, where], capture_output=True, text=True, timeout=90).stdout.strip()
        if out:
            return out
    except Exception:
        pass
    return f"{where}が{'確認待ち' if kind == 'blocked' else '完了'}のまま放置されています。"


def send(target, subject, text):
    print(f"[{time.strftime('%H:%M:%S')}] -> {target}  {subject}\n{text}\n", flush=True)
    if DRY:
        return
    subprocess.run([HERMES, "send", "--to", target, "--subject", subject, "-q", text], capture_output=True, text=True, timeout=60)


def tick():
    now = time.time()
    seen = set()
    for a in agents():
        p, st = a["pane_id"], a["agent_status"]
        seen.add(p)
        s = state.setdefault(p, {"status": None, "since": now, "work_since": None, "notified": False, "last_sent": 0})
        if st != s["status"]:
            if st == "working":
                s["work_since"] = now
            s.update(status=st, since=now, notified=False)
            if st != "done" and st != "blocked" and st != "working":
                s["work_since"] = None
        waited = now - s["since"]
        kind = None
        if st == "blocked" and waited >= BLOCKED_AFTER:
            kind = "blocked"
        elif st == "done" and waited >= DONE_AFTER and s["work_since"] and (s["since"] - s["work_since"]) >= LONG_WORK:
            kind = "done"
        if kind and not s["notified"] and now - s["last_sent"] >= COOLDOWN:
            project = os.path.basename((a.get("cwd") or "").rstrip("/")) or "home"
            agent = a["agent"]
            where = f"{project}の{agent}"
            emoji = "🙋" if kind == "blocked" else "✅"
            send(route(project), f"{emoji} {project} / {agent}", body(p, kind, where))
            s.update(notified=True, last_sent=now)
    for p in list(state):
        if p not in seen:
            del state[p]


if __name__ == "__main__":
    print(f"notifier start (dry={DRY}, blocked>{BLOCKED_AFTER}s, done>{DONE_AFTER}s after >{LONG_WORK}s work)", flush=True)
    while True:
        try:
            tick()
        except Exception as e:
            print(f"tick error: {e}", flush=True)
        time.sleep(3)
