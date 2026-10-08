#!/usr/bin/env python3
"""話し言葉を Hue の操作(JSON)に変える。stdin: {"text","scenes":[名前...],"state":{...}}  stdout: JSON 1つ。
出力: {"type":"scene","name":"集中する"} | {"type":"state","on":bool,"bri":1-254,"bri_inc":-254..254,"ct":153-500,"hue":0-65535,"sat":0-254} | {"type":"none"}
"""
import os
import json
import sys
import urllib.request

GATEWAY = "http://localhost:4001/v1/chat/completions"
ENV_FILE = os.path.expanduser(os.environ.get("HERDR_ENV_FILE", "~/.config/herdr-deck/.env"))  # LITELLM_MASTER_KEY / GEMINI_API_KEY をここから読む
MODELS = ("gemini-flash", "mistral-medium")

SYSTEM = """あなたは部屋の照明コントローラ。ユーザーの一言を、Philips Hue の操作1つに変換する。JSON だけを返す(説明・コードブロックは不要)。
形式:
- シーンを選ぶ: {"type":"scene","name":"<与えられたシーン名のどれか、一字一句そのまま>"}
- 状態を直接指定: {"type":"state", "on":true/false, "bri":1-254, "bri_inc":-254〜254, "ct":153-500, "hue":0-65535, "sat":0-254}  (必要なキーだけ)
- 該当なし/聞き取れない: {"type":"none"}
ルール:
- 「集中」「勉強」「作業」→ シーン『集中する』または『Concentrate』、「くつろぐ」「リラックス」→『くつろぐ』または『Relax』、「読書」→『読書をする』または『Read』、「夜」「寝る前」→『夜間』、「元気」「朝」→『Energize』があれば優先して scene。
- 「少し暗く」は bri_inc -40、「かなり暗く」は -90、「少し明るく」は +40、「かなり明るく」は +90。「最大」は bri 254、「最小」は bri 1。
- 色温度: 暖かい/夕方/電球色 → ct 400〜450(大きいほど暖かい)、昼白色 → ct 300、寒い/青白い/昼光 → ct 200〜153。
- 「消して」→ on:false、「つけて」→ on:true。色名(赤・青・緑・紫・オレンジ・ピンク)は hue と sat(例 赤 hue 0 sat 254、緑 25500、青 46920、紫 50000、オレンジ 5000、ピンク 56000)。
- ユーザーが指示した以外のキーは入れない。"""


def master_key():
    for line in open(ENV_FILE, encoding="utf-8"):
        if line.startswith("LITELLM_MASTER_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    sys.exit("LITELLM_MASTER_KEY not found")


def main():
    req = json.load(sys.stdin)
    user = f"発話: {req['text']}\n利用できるシーン名: {', '.join(req.get('scenes', []))}\n現在の状態: {json.dumps(req.get('state', {}), ensure_ascii=False)}"
    key = master_key()
    for model in MODELS:
        body = json.dumps({"model": model, "max_tokens": 600, "temperature": 0,
                           "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]}).encode()
        r = urllib.request.Request(GATEWAY, body, {"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
        try:
            with urllib.request.urlopen(r, timeout=40) as resp:
                text = json.load(resp)["choices"][0]["message"]["content"].strip()
            text = text[text.index("{"): text.rindex("}") + 1]
            print(json.dumps(json.loads(text), ensure_ascii=False))
            return
        except Exception:
            continue
    print('{"type":"none"}')


if __name__ == "__main__":
    main()
