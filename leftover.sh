#!/bin/sh
# 選択中のエージェントに「このセッションでやり残したことあるか？」を送る。タブを閉じる前の確認用。
# herdr のキー(ctrl+alt+l / prefix+shift+i)と Stream Deck の「やり残し確認」から呼ぶ。--dry なら送らず宛先と本文を表示。
H="${HERDR_BIN_PATH:-$HOME/.local/bin/herdr}"
PANE="$("$H" agent list | jq -r '.result.agents[] | select(.focused) | .pane_id' | head -n1)"
[ -n "$PANE" ] || { "$H" notification show "やり残し確認: 送り先なし" --body "選択中のペインがエージェントではない"; exit 1; }

PROMPT='このセッションでやり残したことあるか？新しい作業は始めず、読み取りだけで答えて。未コミットの変更、動いたままの処理、保留にした判断も含めて。なければ「なし」と答えて。'

[ "$1" = "--dry" ] && { printf '%s\n%s\n' "$PANE" "$PROMPT"; exit 0; }
exec "$H" agent prompt "$PANE" "$PROMPT"
