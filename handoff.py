#!/usr/bin/env python3
"""選択中のエージェントの続きを、別のエージェントに引き継ぐ(herdr だけで完結。Orca は不要)。

使い方: handoff.py <元のペインID> <引き継ぎ先: claude|codex|hermes|opencode>
流れ: ① 元のエージェント本人に引き継ぎメモを書かせる(画面の読み取りより取りこぼしが少ない)
      ② 書き終わるのを待つ ③ 同じスペース・同じ作業ディレクトリに新しいタブを作り、引き継ぎ先を起動
      ④ メモを読ませる ⑤ そのタブに切り替える
メモ: ~/handoffs/<日時>_<プロジェクト>_<元>-to-<先>.md   ログ: ~/handoffs/last.log
"""
import json
import os
import subprocess
import sys
import time
from datetime import datetime

HERDR = os.path.expanduser("~/.local/bin/herdr")
OUT = os.path.expanduser("~/handoffs")
KINDS = {"claude", "codex", "hermes", "opencode"}


def herdr(*args, timeout=30):
    r = subprocess.run([HERDR, *args], capture_output=True, text=True, timeout=timeout)
    try:
        return json.loads(r.stdout)
    except Exception:
        return {"error": {"message": (r.stdout + r.stderr).strip()[:300]}}


def log(msg):
    print(f"{datetime.now():%H:%M:%S} {msg}", flush=True)


def wait_state(target, states, timeout_ms):
    args = ["agent", "wait", target, "--timeout", str(timeout_ms)]
    for s in states:
        args += ["--until", s]
    return herdr(*args, timeout=timeout_ms // 1000 + 15)


def status(target):
    r = herdr("agent", "get", target)
    return (r.get("result", {}).get("agent") or {}).get("agent_status")


def main():
    src, kind = sys.argv[1], sys.argv[2]
    if kind not in KINDS:
        sys.exit(f"unknown kind: {kind}")
    a = herdr("agent", "get", src).get("result", {}).get("agent")
    if not a:
        sys.exit(f"source agent not found: {src}")
    cwd, ws, src_kind = a.get("cwd") or os.path.expanduser("~"), a["workspace_id"], a["agent"]
    project = os.path.basename(cwd.rstrip("/")) or "home"
    os.makedirs(OUT, exist_ok=True)
    memo = os.path.join(OUT, f"{datetime.now():%Y%m%d_%H%M%S}_{project}_{src_kind}-to-{kind}.md")
    log(f"handoff {src_kind}({src}) -> {kind}  cwd={cwd}  memo={memo}")

    # ① 本人にメモを書かせる
    herdr("agent", "prompt", src, (
        f"別のエージェント({kind})に作業を引き継ぐため、引き継ぎメモを次のファイルに書いてください: {memo}\n"
        "含める内容: 1)目的 2)これまでの経緯と決定事項 3)完了したこと 4)未完了・次にやること(優先順) "
        "5)触ったファイル・実行したコマンド・重要なパス 6)注意点・ハマりどころ 7)確認が必要な点。"
        "推測は書かず、事実だけにしてください。書き終えたら『引き継ぎメモ完了』とだけ答えてください。"))

    # ② 作業開始 → 完了を待つ(許可待ちで止まっても、人が承認するまで最大10分待つ)
    wait_state(src, ["working"], 30_000)
    deadline = time.time() + 600
    while time.time() < deadline:
        wait_state(src, ["done", "idle", "blocked"], 120_000)
        if status(src) != "blocked":
            break
        log("元のエージェントが確認待ち。承認を待っています")
        time.sleep(5)
    if not os.path.exists(memo):  # メモが無ければ、画面の直近をそのまま渡す(最後の手段)
        log("メモが作られなかったので、画面の内容で代用")
        screen = subprocess.run([HERDR, "agent", "read", src, "--lines", "300"], capture_output=True, text=True).stdout
        open(memo, "w", encoding="utf-8").write(f"# 引き継ぎ(画面の直近。メモは作られなかった)\n\n作業ディレクトリ: {cwd}\n\n```\n{screen}\n```\n")

    # ③ 新しいタブで引き継ぎ先を起動
    t = herdr("tab", "create", "--workspace", ws, "--cwd", cwd, "--label", f"→{kind}")
    if "result" not in t:
        sys.exit(f"tab create failed: {t}")
    pane, tab = t["result"]["root_pane"]["pane_id"], t["result"]["tab"]["tab_id"]
    name = f"{kind}-handoff-{int(time.time()) % 10000}"
    extra = os.environ.get("HANDOFF_START_ARGS", "").split()  # 試験用: 例 "--model haiku"
    herdr("agent", "start", name, "--kind", kind, "--pane", pane, *(["--", *extra] if extra else []), timeout=330)
    herdr("tab", "focus", tab)

    # ④ 起動直後に確認待ち(フォルダの信頼確認など)なら、人が答えるまで待つ
    for _ in range(60):
        if status(pane) not in ("blocked", None, "unknown"):
            break
        time.sleep(5)
    herdr("agent", "prompt", pane, (
        f"これは別のエージェント({src_kind})からの引き継ぎです。次のメモを読んで状況を把握し、"
        f"理解した内容を短く確認してから、未完了の作業を続けてください: {memo}"))
    log(f"done: new tab {tab} pane {pane}")


if __name__ == "__main__":
    main()
