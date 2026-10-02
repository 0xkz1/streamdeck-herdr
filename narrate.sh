#!/bin/sh
# 1つのタブの画面を読んで文章にし、last-narrate.txt に残して、同じ文章を音声(WAV)にして stdout へ出す
# 使い方: narrate.sh <pane_id> <done|blocked> <場所の名前>
D="$(dirname "$0")"
/usr/bin/python3 "$D/narrate.py" "$1" "$2" "$3" | tee "$D/last-narrate.txt" | /usr/bin/python3 "$D/tts.py"
