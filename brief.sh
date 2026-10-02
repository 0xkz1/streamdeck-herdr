#!/bin/sh
# 優先度の文章を作り、last-brief.txt に残してから、同じ文章を音声(WAV)にして stdout へ出す
D="$(dirname "$0")"
/usr/bin/python3 "$D/priorities.py" | tee "$D/last-brief.txt" | /usr/bin/python3 "$D/tts.py"
