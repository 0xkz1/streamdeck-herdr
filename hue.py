#!/usr/bin/env python3
"""Hue の事前登録を実行する(Mac 上で動く。ブリッジは Mac のネットワークにある)。
使い方: hue.py preset <名前>   例: hue.py preset focus
事前登録: ~/.config/herdr-hue/presets.json  {"focus":{"label":"集中","keywords":["集中"],"scene":"集中する"}, "warm":{"action":{"on":true,"ct":420}}}
TourBox などの外部デバイスからは、常駐アプリ HerdrMic のホットキー経由で呼ばれる。
"""
import json
import os
import ssl
import sys
import time
import urllib.request

CFG = os.path.expanduser("~/.config/herdr-hue")
IP = os.environ.get("HUE_IP", "192.0.2.10")
GROUP = "81"  # コンピュータールーム
CTX = ssl._create_unverified_context()  # ブリッジは自己署名証明書


def req(method, path, body=None):
    key = json.load(open(f"{CFG}/bridge.json"))[0]["success"]["username"]
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(f"https://{IP}/api/{key}{path}", data=data, method=method)
    changing = method == "PUT" and path == f"/groups/{GROUP}/action"
    marker = f"{CFG}/ambient-user-change"
    if changing:
        with open(marker, "w") as f:
            f.write(str(int(time.time() * 1000) + 10000))
    try:
        if changing and "scene" not in (body or {}):
            # 色だけの操作も、呼吸で暗くなった瞬間ではなく普段の明るさから始める。
            saved_file = f"{CFG}/ambient-saved.json"
            if os.path.exists(saved_file):
                with open(saved_file) as f:
                    data = json.load(f)
                for lid, state in data.get("saved", data).items():
                    with open(marker, "w") as f:
                        f.write(str(int(time.time() * 1000) + 10000))
                    restore = {"on": state["on"], "transitiontime": 0}
                    if state["on"]:
                        restore["bri"] = state["bri"]
                        keys = ("ct",) if state["colormode"] == "ct" else ("xy",) if state["colormode"] == "xy" else ("hue", "sat")
                        restore.update({k: state[k] for k in keys})
                    req("PUT", f"/lights/{lid}/state", restore)
            with open(marker, "w") as f:
                f.write(str(int(time.time() * 1000) + 10000))
        return json.load(urllib.request.urlopen(r, timeout=6, context=CTX))
    finally:
        if changing:
            with open(marker, "w") as f:
                f.write(str(int(time.time() * 1000) + 1500))


def apply(p):
    if "scene" in p:
        for sid, s in req("GET", "/scenes").items():
            if str(s.get("group")) == GROUP and s["name"] == p["scene"]:
                return req("PUT", f"/groups/{GROUP}/action", {"on": True, "scene": sid})
        sys.exit(f"scene not found: {p['scene']}")
    return req("PUT", f"/groups/{GROUP}/action", p.get("action", p))


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "preset":
        presets = json.load(open(f"{CFG}/presets.json"))
        if sys.argv[2] not in presets:
            sys.exit(f"unknown preset: {sys.argv[2]}")
        print(apply(presets[sys.argv[2]]))
    else:
        sys.exit(__doc__)
