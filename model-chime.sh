#!/bin/bash
# Ubuntu 側: エージェントのフックから呼ぶ。モデル名 → 段階(high/mid/low)→ Mac で開始音。鳴らすのは会話の最初のメッセージを送った時。
# 使い方: model-chime.sh <agent> [arm|fire|<model>]
#   arm     セッション開始フック用(Claude/Codex)。モデルを控えるだけで鳴らさない
#   fire    メッセージ送信フック用(Claude/Codex)。控えがある最初の 1 回だけ鳴らす(再開したセッションは控えが無いので鳴らさない)
#   省略    フック入力 JSON から鳴らす(Hermes の on_session_start / Antigravity の PreInvocation は、もともと最初のメッセージで発火する)
#   <model> モデル名を直接指定(試験用)
agent=$1 mode=$2 model=
D=~/.cache/model-chime
mkdir -p $D/armed
case $mode in arm | fire) ;; *) model=$mode mode= ;; esac
# Hermes は --cli --quiet でも HERMES_INTERACTIVE=1 を立てる。
# フック自身の stdio は常に pipe なので、呼び出し元 Hermes の実端末を確認する(モデル直指定の試験は除く)。
if [ "$agent" = hermes ] && [ -z "$model" ]; then
	[ "${HERMES_INTERACTIVE:-}" = 1 ] || exit 0
	if ! [ -t 0 ] 2>/dev/null <"/proc/$PPID/fd/1"; then
		echo "$(date +%FT%T) hermes noninteractive output, skipped" >>"$D/log"
		exit 0
	fi
fi
if [ -n "$mode" ] || { [ -z "$model" ] && [ ! -t 0 ]; }; then
	in=$(cat)
	sid=$(jq -r '.session_id // empty' <<<"$in" 2>/dev/null)
	model=$(jq -r '.model // .modelName // .extra.model // empty' <<<"$in" 2>/dev/null) # Claude/Codex は .model、Antigravity は .modelName、Hermes は .extra.model
	case $mode in
	arm)
		printf '%s\n' "$in" >$D/last-"$agent".json
		[ -n "$sid" ] && printf '%s\n' "$model" >$D/armed/"$sid"
		find $D/armed $D/model -type f -mtime +2 -delete 2>/dev/null # 一度も送信されなかったセッションの控えを掃除
		exit 0
		;;
	fire) # 毎メッセージ呼ばれるので、控えが無ければすぐ戻る
		[ -n "$sid" ] && [ -e $D/armed/"$sid" ] || exit 0
		printf '%s\n' "$in" >$D/last-"$agent"-fire.json
		[ -z "$model" ] && model=$(<$D/armed/"$sid")
		[ -z "$model" ] && [ -e $D/model/"$sid" ] && model=$(<$D/model/"$sid") # Claude: ステータスラインが書いたモデル名(claude-statusline.py)
		rm -f $D/armed/"$sid"
		[ -n "$model" ] || { echo "$(date +%FT%T) $agent model unresolved, skipped" >>$D/log; exit 0; } # 非対話実行(ステータスラインが無い)ではモデル名が取れない。Funk を鳴らし続けない
		;;
	*)
		printf '%s\n' "$in" >$D/last-"$agent".json
		platform=$(jq -r '.extra.platform // empty' <<<"$in" 2>/dev/null)
		[ -n "$platform" ] && [ "$platform" != cli ] && exit 0 # Hermes の cron・gateway のセッションでは鳴らさない
		cid=$(jq -r '.conversationId // empty' <<<"$in" 2>/dev/null)
		if [ -n "$cid" ]; then # Antigravity は PreInvocation が毎回発火する → 会話ごとに最初の 1 回だけ
			mkdir -p $D/seen
			[ -e $D/seen/"$cid" ] && exit 0
			touch $D/seen/"$cid"
			[ -z "$model" ] && model=$(jq -r '.model // empty' ~/.gemini/antigravity-cli/settings.json 2>/dev/null) # 入力に無ければ既定モデル
		fi
		;;
	esac
fi
m=${model,,}
case $m in
	*haiku* | *luna* | *-mini* | *-nano* | *flash*low*) tier=low ;;
	*opus* | *fable* | *astra* | *pro*) tier=high ;;
	*sonnet* | *terra* | *sol | *-sol-* | *flash* | gpt-5*) tier=mid ;;
	*) tier=unknown ;;
esac
echo "$(date +%FT%T) $agent model=${model:-?} tier=$tier" >>$D/log
setsid ssh -o BatchMode=yes -o ConnectTimeout=3 mac "~/streamdeck-herdr/chime.sh $tier" </dev/null >/dev/null 2>&1 &
exit 0
