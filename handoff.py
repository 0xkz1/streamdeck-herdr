#!/usr/bin/env python3
"""選択中のエージェントの続きを、別のエージェントに引き継ぐ(herdr だけで完結。Orca は不要)。

使い方: handoff.py <元のペインID> <引き継ぎ先: claude|codex|hermes|opencode|agy または 役割名(roles.json)>
流れ: ① 元のエージェント本人に引き継ぎメモを書かせる(画面の読み取りより取りこぼしが少ない)
      ② 書き終わるのを待つ ③ 同じスペース・同じ作業ディレクトリに新しいタブを作り、引き継ぎ先を起動
      ④ メモを読ませる ⑤ そのタブに切り替える
役割名で渡すと roles.json の先頭の agent を起動し、タブ名も役割名になる(2番目以降は表に書くだけで、まだ自動では試さない)。
元のタブ名が役割名なら、それが from_role になる。
メモ: ~/handoffs/<日時>_<プロジェクト>_<元>-to-<先>.md   最新: ~/handoffs/latest-<プロジェクト>.md   ログ: ~/handoffs/last.log
"""
import json
import os
import subprocess
import sys
import time
from datetime import datetime

HERDR = os.path.expanduser("~/.local/bin/herdr")
OUT = os.path.expanduser("~/handoffs")
KINDS = {"claude", "codex", "hermes", "opencode", "agy"}
STARTUP_GRACE = 60
PROMPT_TRIES = 3
ERROR_CHECK_WAIT = 8  # 届いたあと、エージェントの最初の応答がエラーでないかを見るまでの秒数
# 実際に見たエラー(Codex: モデル非対応の400 / agy: クォータ切れ)。画面にあれば、引き継ぎ先は動いていない
ERROR_MARKERS = ("is not supported when using codex", "individual quota reached", "quota reached", "invalid_request_error",
                 "hit your usage limit", "hit your limit", "limit reached")
# 起動直後に出る確認画面(Codex の hooks レビューなど)。ここに文字を送ると、切り替え操作として働いてしまう(2026-10-04 に設定が書き換わった)
MODAL_MARKERS = ("needs review before it can run", "need review before it can run", "space/enter toggle")
PROMPT_WAIT = 25  # 送信後、状態が動くのを待つ秒数
ROLES = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "roles.json")))
SCHEMA = (
    "ファイルの先頭に次の行を置き、そのあと見出しを順に書く:\n"
    "from_role: {from_role}\nto_role: {to_role}\nproject: {project}\ncwd: {cwd}\ncreated: {created}\n"
    "# 目的\n# 完了\n# 決定\n# 未完了(優先順)\n# 既知の問題\n# 次の役割と最初の一手\n"
    "触ったファイルは書かない(git status で分かる)。")


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


def pane_screen(target):
    """ペインの直近の画面(文字)。折り返しで途切れないよう、呼び出し側が空白を除いて比べる"""
    r = subprocess.run([HERDR, "agent", "read", target, "--lines", "200"], capture_output=True, text=True, timeout=10)
    return r.stdout


def wait_delivered(target, marker):
    """プロンプト送信後、画面に marker(メモのファイル名)が出たら True。PROMPT_WAIT 秒出なければ False。
    状態番号(state_change_seq)は使わない: 起動中の状態変化を「届いた」と誤認した(2026-10-04)"""
    want = "".join(marker.split())
    end = time.time() + PROMPT_WAIT
    while time.time() < end:
        if want in "".join(pane_screen(target).split()):
            return True
        time.sleep(1)
    return False


def main():
    args = [x for x in sys.argv[1:] if x != "--from-limit"]
    from_limit = len(args) != len(sys.argv) - 1  # 元が使用上限で止まっている: 本人にメモを頼めないので、会話記録から作る
    src, target = args[0], args[1]
    to_role = target if target in ROLES else None
    kind = ROLES[target][0] if to_role else target
    if kind not in KINDS:
        sys.exit(f"unknown kind or role: {target}")
    a = herdr("agent", "get", src).get("result", {}).get("agent")
    if not a:
        sys.exit(f"source agent not found: {src}")
    cwd, ws, src_kind = a.get("cwd") or os.path.expanduser("~"), a["workspace_id"], a["agent"]
    tab_label = (herdr("tab", "get", a.get("tab_id", "")).get("result", {}).get("tab") or {}).get("label", "")
    from_role = tab_label.lstrip("→") if tab_label.lstrip("→") in ROLES else src_kind
    to_name = to_role or kind
    project = os.path.basename(cwd.rstrip("/")) or "home"
    os.makedirs(OUT, exist_ok=True)
    now = datetime.now()
    memo = os.path.join(OUT, f"{now:%Y%m%d_%H%M%S}_{project}_{from_role}-to-{to_name}.md")
    log(f"handoff {from_role}({src}) -> {to_name}[{kind}]  cwd={cwd}  memo={memo}")

    if from_limit:
        from limit_watch import digest, tail_lines
        body = digest(src_kind, (a.get("agent_session") or {}).get("value"), cwd, "\n".join(tail_lines(src)))
        open(memo, "w", encoding="utf-8").write(
            f"from_role: {from_role}\nto_role: {to_name}\nproject: {project}\ncwd: {cwd}\ncreated: {now:%Y-%m-%d %H:%M}\n\n"
            "※ 元のエージェントが使用上限で止まったため、本人ではなく会話記録と画面から自動で作ったメモ。決定事項や未完了の一覧はない。"
            "下の抜粋から状況を判断し、まず git status で現状を確認してから、最後のユーザー指示の続きをやること。\n\n" + body + "\n")
    else:
        # ① 本人にメモを書かせる
        herdr("agent", "prompt", src, (
            f"次の担当({to_name})に作業を引き継ぐため、引き継ぎメモを次のファイルに書いてください: {memo}\n"
            + SCHEMA.format(from_role=from_role, to_role=to_name, project=project, cwd=cwd, created=f"{now:%Y-%m-%d %H:%M}")
            + "\n推測は書かず、事実だけにしてください。書き終えたら『引き継ぎメモ完了』とだけ答えてください。"))

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

    latest = os.path.join(OUT, f"latest-{project}.md")
    if os.path.lexists(latest):
        os.remove(latest)
    os.symlink(memo, latest)

    # ③ 新しいタブで引き継ぎ先を起動
    t = herdr("tab", "create", "--workspace", ws, "--cwd", cwd, "--label", f"→{to_name}")
    if "result" not in t:
        sys.exit(f"tab create failed: {t}")
    pane, tab = t["result"]["root_pane"]["pane_id"], t["result"]["tab"]["tab_id"]
    name = f"{kind}-handoff-{int(time.time()) % 10000}"
    extra = os.environ.get("HANDOFF_START_ARGS", "").split()  # 試験用: 例 "--model haiku"
    started = herdr("agent", "start", name, "--kind", kind, "--pane", pane, *(["--", *extra] if extra else []), timeout=330)
    herdr("tab", "focus", tab)

    def fail(why):
        herdr("tab", "rename", tab, f"✗{to_name}")
        log(f"FAILED: {to_name}[{kind}] は起動しなかった({why})。タブ {tab} を見てください。メモ: {memo}")
        sys.exit(1)

    err = started.get("error", {}).get("message", "")
    if err and "blocked during startup" not in err:  # 起動中の確認待ち(信頼確認など)は失敗ではない。下で人が答えるまで待つ
        fail(err)

    # ④ 起動を確認する。確認待ち(フォルダの信頼確認など)なら、人が答えるまで待つ。
    #    エージェントが見えない状態が STARTUP_GRACE 秒続いたら失敗(起動直後の自動アップデートで終了した場合など)
    unseen = 0
    while True:
        st = status(pane)
        if st == "blocked":
            unseen = 0
        elif st in (None, "unknown"):
            unseen += 5
            if unseen >= STARTUP_GRACE:
                fail(f"{STARTUP_GRACE}秒たってもエージェントが現れない")
        else:
            break
        time.sleep(5)
    card = os.path.join(os.path.dirname(os.path.abspath(__file__)), "roles", f"{to_role}.md") if to_role else ""
    card = card if card and os.path.exists(card) else ""
    text = (
        f"これは前の担当({from_role})からの引き継ぎで、あなたの役割は {to_name} です。"
        + (f"役割の説明: {card}\n" if card else "")
        + f"次のメモを読んで状況を把握し、理解した内容を短く確認してから、未完了の作業を続けてください: {memo}")
    # 送信後、画面にメモのファイル名が出なければ、プロンプトが届いていない(起動直後のロゴ表示に取りこぼされるなど)。最大3回まで送る
    delivered = False
    for attempt in range(1, PROMPT_TRIES + 1):
        if any(m in pane_screen(pane) for m in MODAL_MARKERS):  # 確認画面には、プロンプトを送らない(再送も含めて)
            fail("起動直後の確認画面(hooks のレビューなど)が出ている。人が答えてから、メモを渡してください")
        herdr("agent", "prompt", pane, text)
        if wait_delivered(pane, os.path.basename(memo)):
            delivered = True
            break
        log(f"プロンプトが届いた形跡がない({attempt}/{PROMPT_TRIES})" + ("。再送します" if attempt < PROMPT_TRIES else ""))
    else:
        log(f"WARNING: プロンプトが届いたか確認できなかった。タブ {tab} を見てください。メモ: {memo}")
    if delivered:  # 届いても、最初の応答がエラー(モデル非対応・クォータ切れなど)なら、動いていない
        time.sleep(ERROR_CHECK_WAIT)
        low = pane_screen(pane).lower()
        hit = next((m for m in ERROR_MARKERS if m in low), None)
        if hit:
            fail(f"プロンプトは届いたが、{to_name}[{kind}] の応答がエラーだった(「{hit}」)")
    log(f"done: new tab {tab} pane {pane}")


if __name__ == "__main__":
    main()
