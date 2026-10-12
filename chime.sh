#!/bin/bash
# Mac 側: モデル段階(high|mid|low|その他)の開始音を鳴らす。Ubuntu の model-chime.sh が ssh mac 経由で呼ぶ。
# 消音中・会議の録音中は鳴らさない(plugin.ts と同じ条件)。音を変えるなら下の case だけ直す。
# 音は make_chimes.py の合成(sounds/chime-*.wav)。ファイルは音量を揃えてあり、段階ごとの大小は下の v で付ける。
[ -e ~/.config/herdr-sleeping ] && exit 0
grep -q '"muted": true' ~/.config/herdr-sound.json 2>/dev/null && exit 0
[ "$(curl -s -m 1 http://127.0.0.1:18868/status)" = running ] && exit 0
S=~/streamdeck-herdr/sounds
case $1 in
	high) f=$S/chime-high.wav v=0.5 d=3.2 ;;                 # ロケット点火 ズゥゥン(2.9秒)
	mid) f=$S/chime-mid.wav v=0.4 d=1.8 ;;                   # ジェット旅客機の巡航(1.4秒)
	low) f=$S/chime-low.wav v=0.2 d=1.0 ;;                   # ドローン(0.75秒。頭から減衰するのでピークが高く、音量は低め)
	*) f=/System/Library/Sounds/Funk.aiff v=0.5 d=1.5 ;;     # 段階が判定できなかった(振り分け表の漏れに気づくため)
esac
[ -e ~/.config/herdr-sleeping ] && exit 0
curl -s -m 0.5 "http://127.0.0.1:18869/duck?duration=$d" >/dev/null 2>&1 &
exec /usr/bin/afplay -v "$v" "$f"
