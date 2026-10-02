#!/bin/sh
# 会議の録音を Ubuntu に送り、高精度に取り直した議事録(_final.md)を持ち帰る。
# 使い方: refine.sh <保存パス(拡張子なし)>   例: ~/Documents/HerdrScribe/2026-10-02_0012
# 失敗(Ubuntu に繋がらない等)したら非0で終わる。呼び出し側が .pending を残して、後で再実行する。
set -e
BASE="$1"
NAME="$(basename "$BASE")"
HOST="${HERDR_SSH_HOST:-ubuntu-host}"
RDIR="atelier/forge/streamdeck-herdr/meetings/$NAME"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=8"
$SSH $HOST "mkdir -p ~/$RDIR"
[ -f "$BASE.m4a" ] && scp -q -o BatchMode=yes "$BASE.m4a" "$HOST:$RDIR/mic.m4a"
[ -f "${BASE}_system.m4a" ] && scp -q -o BatchMode=yes "${BASE}_system.m4a" "$HOST:$RDIR/system.m4a"
scp -q -o BatchMode=yes "$BASE.meta.json" "$HOST:$RDIR/meta.json"
$SSH $HOST "/usr/bin/python3 ~/atelier/forge/streamdeck-herdr/meeting_refine.py ~/$RDIR" >/dev/null
scp -q -o BatchMode=yes "$HOST:$RDIR/final.md" "${BASE}_final.md"
