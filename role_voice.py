#!/usr/bin/env python3
"""ペインのタブ名(→builder など)から役割を引き、その声を narrate.sh に渡す。

使い方: eval "$(role_voice.py <pane_id> <場所>)"   → VOICE / STYLE / WHERE を設定する
役割のタブなら声は voices.json の役割の声にし、場所からエージェント名(「〜の クロード」)を外す。
役割が分からない・失敗したときは、Claude は _claude、それ以外は _default の声(場所はそのまま)。
"""
import json
import os
import shlex
import subprocess
import sys

D = os.path.dirname(os.path.abspath(__file__))
HERDR = os.path.expanduser("~/.local/bin/herdr")
AGENT_JP = ("クロード", "コーデックス", "オープンコード", "ヘルメス")  # plugin.ts の AGENT_JP と同じ


def herdr(*args):
    return json.loads(subprocess.run([HERDR, *args], capture_output=True, text=True, timeout=10).stdout)["result"]


def main():
    pane, where = sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else ""
    path = os.path.join(D, "voices.json")  # 自分用の声の設定。無ければ voices.example.json
    if not os.path.exists(path):
        path = os.path.join(D, "voices.example.json")
    voices = json.load(open(path, encoding="utf-8"))
    v = voices["_default"]
    if where.endswith("のクロード"):
        v = voices.get("_claude", v)
    try:
        tab = herdr("agent", "get", pane)["agent"]["tab_id"]
        role = herdr("tab", "get", tab)["tab"]["label"].lstrip("→✗")
        if role in voices and role != "_default":
            v = voices[role]
            head, _, tail = where.rpartition("の")
            if head and tail in AGENT_JP:
                where = head
    except Exception:
        pass
    af = ""
    if v.get("pitch"):  # 作った音声の高さを後から下げる(テンポは保つ)。少し高域を削って自然に
        f = 2 ** (v["pitch"] / 12)
        af = f"asetrate=24000*{f},aresample=24000,atempo=1/{f},treble=g=-5:f=3500"
    print(f"VOICE={shlex.quote(v['voice'])} STYLE={shlex.quote(v['style'])} WHERE={shlex.quote(where)} AF={shlex.quote(af)}")


if __name__ == "__main__":
    main()
