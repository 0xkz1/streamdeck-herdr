#!/usr/bin/env python3
"""会議の録音を高精度に取り直し、要約つきの議事録(final.md)を作る。

使い方: meeting_refine.py <dir>
  <dir>/mic.m4a      自分のマイク
  <dir>/system.m4a   相手の音声(無ければ省略可)
  <dir>/meta.json    {"name","micLang","sysLang","micStart","sysStart"}  (lang は "ja" | "en")
処理: Whisper(large-v3, GPU) で取り直し → 幻覚を除去 → 時刻順に「自分/相手」で結合 → 英語は日本語訳 → 要約。
"""
import json
import os
import re
import subprocess
import sys
import urllib.request
from datetime import datetime

WHISPER = "http://localhost:18866/v1/audio/transcriptions"
GATEWAY = "http://localhost:4001/v1/chat/completions"
ENV_FILE = os.path.expanduser(os.environ.get("HERDR_ENV_FILE", "~/.config/herdr-deck/.env"))  # LITELLM_MASTER_KEY / GEMINI_API_KEY をここから読む
MODELS = ("gemini-flash", "mistral-medium")  # 長文に強いものを先に。空返事なら次へ

# 無音や雑音で Whisper が出す定型の幻覚
HALLUCINATIONS = {
    "ご視聴ありがとうございました", "ご視聴ありがとうございました。", "ありがとうございました", "チャンネル登録お願いします",
    "Thank you for watching.", "Thank you for watching", "Thanks for watching.", "Thank you.", "Bye.", "you",
}


def transcribe(path: str, lang: str):
    out = subprocess.run(
        ["curl", "-s", "-m", "3600", "-F", f"file=@{path}", "-F", "model=Systran/faster-whisper-large-v3", "-F", f"language={lang}",
         "-F", "response_format=verbose_json", "-F", "timestamp_granularities[]=segment", WHISPER],
        capture_output=True, text=True,
    ).stdout
    segs = []
    last = ""
    for s in json.loads(out).get("segments", []):
        text = s["text"].strip()
        if not text or text in HALLUCINATIONS or text == last:
            continue
        if s.get("no_speech_prob", 0) > 0.6 and s.get("avg_logprob", 0) < -1.0:
            continue
        last = text
        segs.append({"start": s["start"], "text": text})
    return segs


def master_key() -> str:
    for line in open(ENV_FILE, encoding="utf-8"):
        if line.startswith("LITELLM_MASTER_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    sys.exit("LITELLM_MASTER_KEY not found")


def llm(system: str, user: str, max_tokens: int = 6000) -> str:
    key = master_key()
    for model in MODELS:
        body = json.dumps({"model": model, "max_tokens": max_tokens, "temperature": 0.2,
                           "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}).encode()
        req = urllib.request.Request(GATEWAY, body, {"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                text = json.load(r)["choices"][0]["message"]["content"].strip()
            if text:
                return text
        except Exception:
            continue
    return ""


def translate(lines: list[str]) -> list[str]:
    """英語の行を日本語に。番号つきで渡し、番号つきで受ける(順序ずれを防ぐ)。失敗した行は空文字。"""
    out = [""] * len(lines)
    for i in range(0, len(lines), 40):
        chunk = lines[i : i + 40]
        numbered = "\n".join(f"{n}: {t}" for n, t in enumerate(chunk))
        reply = llm("次の英語の発言を自然な日本語に訳す。各行は『番号: 訳』の形式だけで返す。説明や前置きは書かない。", numbered, 4000)
        for m in re.finditer(r"^\s*(\d+)\s*[:：]\s*(.+)$", reply, re.M):
            n = int(m.group(1))
            if n < len(chunk):
                out[i + n] = m.group(2).strip()
    return out


def mmss(sec: float) -> str:
    sec = int(max(sec, 0))
    return f"{sec // 3600:02d}:{sec % 3600 // 60:02d}:{sec % 60:02d}"


def main() -> None:
    d = sys.argv[1]
    meta = json.load(open(os.path.join(d, "meta.json")))
    events = []  # (start, label, lang, text)

    mic = os.path.join(d, "mic.m4a")
    if os.path.exists(mic):
        for s in transcribe(mic, meta.get("micLang", "ja")):
            events.append((s["start"], "自分", meta.get("micLang", "ja"), s["text"]))
    sysf = os.path.join(d, "system.m4a")
    if os.path.exists(sysf) and meta.get("sysLang") in ("ja", "en"):
        off = 0.0
        if meta.get("micStart") and meta.get("sysStart"):  # 相手側の録音は少し遅れて始まるので、開始のずれを補正
            off = (datetime.fromisoformat(meta["sysStart"]) - datetime.fromisoformat(meta["micStart"])).total_seconds()
        for s in transcribe(sysf, meta["sysLang"]):
            events.append((s["start"] + off, "相手", meta["sysLang"], s["text"]))
    events.sort(key=lambda e: e[0])

    en_idx = [i for i, e in enumerate(events) if e[2] == "en"]
    ja_of = dict(zip(en_idx, translate([events[i][3] for i in en_idx]))) if en_idx else {}

    # 要約(訳があれば日本語訳を使う)
    plain = "\n".join(f"[{mmss(e[0])}] {e[1]}: {ja_of.get(i) or e[3]}" for i, e in enumerate(events))
    summary = llm(
        "あなたは議事録の書記。次の会議の書き起こしから、Markdown で次の4つの見出しを作る。書き起こしに無いことは書かない(推測しない)。"
        "『## 要約』(3〜5行)、『## 決定事項』、『## やること』(『- [ ] 内容(担当/期限が分かれば)』)、『## 未解決・確認事項』。該当が無い見出しは『なし』と書く。",
        plain or "(発言なし)",
    ) if plain else "(発言が検出されませんでした)"

    lines = [f"# 議事録 {meta.get('name', '')}", "", f"- 自分のマイク: {meta.get('micLang', 'ja')} / 相手の音声: {meta.get('sysLang', 'なし')}",
             f"- 取り直し: Whisper large-v3(GPU)", "", summary, "", "## 全文", ""]
    for i, (t, who, _lang, text) in enumerate(events):
        lines.append(f"[{mmss(t)}] **{who}**: {text}")
        if ja_of.get(i):
            lines.append(f"> 訳: {ja_of[i]}")
        lines.append("")
    open(os.path.join(d, "final.md"), "w", encoding="utf-8").write("\n".join(lines))
    print(f"ok: {len(events)} segments")


if __name__ == "__main__":
    main()
