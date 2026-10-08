#!/bin/sh
# 1つのタブの画面を読んで文章にし、last-narrate.txt に残して、同じ文章を音声(WAV)にして stdout へ出す
# 使い方: narrate.sh <pane_id> <done|blocked> <場所の名前>
# 役割のタブ(→builder など)なら、役割の声で読み、場所からエージェント名を外す(role_voice.py / voices.json)
D="$(dirname "$0")"
eval "$(/usr/bin/python3 "$D/role_voice.py" "$1" "$3" 2>/dev/null)"
[ -n "$VOICE" ] || { VOICE=Algenib; STYLE=; WHERE="$3"; AF=; }  # role_voice.py が失敗したら従来どおり
if [ -z "$AF" ]; then
  /usr/bin/python3 "$D/narrate.py" "$1" "$2" "$WHERE" | tee "$D/last-narrate.txt" | TTS_STYLE="$STYLE" /usr/bin/python3 "$D/tts.py" "$VOICE"
else  # 声の高さを下げる指定があるとき(voices.json の pitch)。失敗したら下げる前の音声をそのまま出す
  T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
  /usr/bin/python3 "$D/narrate.py" "$1" "$2" "$WHERE" | tee "$D/last-narrate.txt" | TTS_STYLE="$STYLE" /usr/bin/python3 "$D/tts.py" "$VOICE" > "$T/raw.wav" || exit 1  # 空・失敗なら音を出さない
  /usr/bin/ffmpeg -loglevel error -y -i "$T/raw.wav" -af "$AF" "$T/out.wav" && cat "$T/out.wav" || cat "$T/raw.wav"
fi
