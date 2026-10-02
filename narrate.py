#!/usr/bin/env python3
"""herdr のペイン画面を読み、読み上げ用の日本語を stdout に出す。

使い方: narrate.py <pane_id> <done|blocked> [場所の名前]
キーは HERDR_ENV_FILE(既定 ~/.config/herdr-deck/.env) から実行時に読む(Mac には置かない)。
"""
import json
import os
import subprocess
import sys
import urllib.request

GATEWAY = "http://localhost:4001/v1/chat/completions"
ENV_FILE = os.path.expanduser(os.environ.get("HERDR_ENV_FILE", "~/.config/herdr-deck/.env"))  # LITELLM_MASTER_KEY / GEMINI_API_KEY をここから読む
MODEL = "mistral-medium"
HERDR = os.path.expanduser("~/.local/bin/herdr")

COMMON = (
    "必ず日本語だけで答える(英語は禁止)。敬語は使わず、寡黙な相棒が短く言い切るタメ口(『〜した』『〜だ』『決めてくれ』)で。"
    "入力はAIコーディングエージェントのターミナル画面そのままで、枠線・記号・入力欄が混ざっている。"
    "それらは無視して中身だけ読み取る。画面を見ていない人が声だけ聞いて次に何をすべきか分かることを最優先にする。"
    "3文以内、各文は短く、記号やコードは読み上げない。前置きや挨拶は書かない。"
)
PROMPTS = {
    "done": COMMON + "作業が完了した場面。次の順で伝える: 何をしたか、その結果どうなったか、次にユーザーがすべきこと(質問や選択肢があればその中身)。",
    "blocked": COMMON + "確認待ちで止まっている場面。次の順で伝える: 今何の作業の途中か、何の許可を求めているか/何を質問しているか"
    "(削除など取り消しにくい操作は必ず言う)、どう答えればよいか(選択肢は読むが、どれを選ぶべきかは勧めない)。",
}


def master_key() -> str:
    for line in open(ENV_FILE, encoding="utf-8"):
        if line.startswith("LITELLM_MASTER_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    sys.exit("LITELLM_MASTER_KEY not found")


def main() -> None:
    pane, kind = sys.argv[1], sys.argv[2]
    where = sys.argv[3] if len(sys.argv) > 3 else ""
    screen = subprocess.run(
        [HERDR, "agent", "read", pane, "--lines", "200"], capture_output=True, text=True, timeout=10, check=True
    ).stdout
    body = json.dumps(
        {
            "model": MODEL,
            "max_tokens": 2000,
            "temperature": 0.2,
            "messages": [{"role": "system", "content": PROMPTS[kind]}, {"role": "user", "content": screen}],
        }
    ).encode()
    req = urllib.request.Request(
        GATEWAY, body, {"Content-Type": "application/json", "Authorization": f"Bearer {master_key()}"}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        text = json.load(r)["choices"][0]["message"]["content"].strip()
    print(f"{where}。{text}" if where else text)


if __name__ == "__main__":
    main()
