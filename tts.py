#!/usr/bin/env python3
"""stdin の日本語を Gemini TTS で読み上げ音声(WAV)にして stdout へ出す。

使い方: echo 文 | tts.py [声の名前] > out.wav   (既定: Algenib / 話し方 a)
話し方は STYLE で指示する。キーは HERDR_ENV_FILE(既定 ~/.config/herdr-deck/.env) の GEMINI_API_KEY を実行時に読む。
"""
import base64
import io
import json
import os
import sys
import urllib.error
import urllib.request
import wave

ENV_FILE = os.path.expanduser(os.environ.get("HERDR_ENV_FILE", "~/.config/herdr-deck/.env"))  # LITELLM_MASTER_KEY / GEMINI_API_KEY をここから読む
MODELS = [os.environ["TTS_MODEL"]] if "TTS_MODEL" in os.environ else ["gemini-2.5-flash-preview-tts", "gemini-3.8-flash-tts"]
# 話し方のプリセット。TTS_STYLE_NAME=b で切替、TTS_STYLE で自由指定
STYLES = {
	"a": "低めで渋い男の声。演技はせず、仕事仲間が普通のテンポでさらっと報告する素の口調で。間は詰め気味に、テンポよく: ",
	"b": "低めの男の声。早口にならない程度に、きびきびと、歯切れよく。芝居がからず、淡々と自然に: ",
}
STYLE = os.environ.get("TTS_STYLE") or STYLES[os.environ.get("TTS_STYLE_NAME", "a")]
DEFAULT_VOICE = "Algenib"  # ざらついた低い男声


def keys() -> list[str]:
    out = []
    for line in open(ENV_FILE, encoding="utf-8"):
        if line.startswith("GEMINI_API_KEY") and "=" in line:
            v = line.split("=", 1)[1].strip().strip("'\"")
            if v:
                out.append(v)
    return out


def synth(text: str, voice: str) -> bytes:
    last = None
    for model in MODELS:  # preview は廃止されうるので次のモデルへ退避
        try:
            return synth_with(model, text, voice)
        except (urllib.error.URLError, KeyError, IndexError) as e:
            last = e
    raise SystemExit(f"tts failed: {last}")


def synth_with(model: str, text: str, voice: str) -> bytes:
    body = json.dumps({
        "contents": [{"parts": [{"text": STYLE + text}]}],
        "generationConfig": {"responseModalities": ["AUDIO"],
                             "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}}},
    }).encode()
    last = None
    for k in keys():  # 無料枠の上限に当たったら次のキーへ
        req = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                                     body, {"Content-Type": "application/json", "x-goog-api-key": k})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                pcm = base64.b64decode(json.load(r)["candidates"][0]["content"]["parts"][0]["inlineData"]["data"])
            buf = io.BytesIO()
            with wave.open(buf, "wb") as w:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000); w.writeframes(pcm)
            return buf.getvalue()
        except urllib.error.HTTPError as e:
            last = e
            if e.code not in (429, 403, 500, 503):
                raise
    raise SystemExit(f"all keys failed: {last}")


if __name__ == "__main__":
    sys.stdout.buffer.write(synth(sys.stdin.read(), sys.argv[1] if len(sys.argv) > 1 else DEFAULT_VOICE))
