#!/bin/sh
# 選択中のエージェントに「いま何をしているか整理して」を送る。herdr のキー(prefix+i / ctrl+alt+r)から呼ぶ。
# Stream Deck / TourBox は同じキーストロークを送るだけでよい。--dry なら送らず宛先と本文を表示。
H="${HERDR_BIN_PATH:-$HOME/.local/bin/herdr}"
PANE="$("$H" agent list | jq -r '.result.agents[] | select(.focused) | .pane_id' | head -n1)"
[ -n "$PANE" ] || { "$H" notification show "状況整理: 送り先なし" --body "選択中のペインがエージェントではない"; exit 1; }

PROMPT='【状況整理】新しい作業は始めず、次の形式で短く答えて。
1. 目的: このセッションで最終的に達成したいこと(1行)
2. 今: 直前にやったことと、いま実行中/待っていること(1〜2行)
3. 済み: 確定した事実・変更したファイル(最大5項目)
4. 要判断: 私に求めている判断・確認があれば(なければ「なし」)
5. 次の一手: 私が何もしなければ次にやること
6. 注意: 未コミットの変更、動いたままの処理、壊れかけのもの(なければ「なし」)
推測は「推測」と明記。確認が要るときは読み取りだけ(git status 等)。ファイルは変更しない。'

[ "$1" = "--dry" ] && { printf '%s\n%s\n' "$PANE" "$PROMPT"; exit 0; }
exec "$H" agent prompt "$PANE" "$PROMPT"
