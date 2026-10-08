#!/usr/bin/env python3
"""メモリ/VRAM/ディスク/NVMe温度/GPU電力制限/発火中アラートを JSON で1回で出す(Stream Deck 用)。
alerts は Prometheus に届かなければ null(=監視停止をキーで気づけるように)。"""
import glob, json, subprocess, urllib.request

def mem():
    m = {k: int(v.split()[0]) for k, v in (l.split(":") for l in open("/proc/meminfo"))}
    return {"pct": round((1 - m["MemAvailable"] / m["MemTotal"]) * 100), "usedG": round((m["MemTotal"] - m["MemAvailable"]) / 1048576), "totalG": round(m["MemTotal"] / 1048576)}

def gpu():
    used, total, pl = subprocess.run(["nvidia-smi", "--query-gpu=memory.used,memory.total,power.limit", "--format=csv,noheader,nounits"],
                                     capture_output=True, text=True, timeout=10).stdout.split(",")
    return {"usedMiB": int(used), "totalMiB": int(total)}, round(float(pl))

def disk():
    s = subprocess.run(["df", "-BG", "--output=avail,pcent", "/"], capture_output=True, text=True).stdout.splitlines()[1].split()
    return {"availG": int(s[0].rstrip("G")), "pct": int(s[1].rstrip("%"))}

def nvme():
    return max(int(open(h + "/temp1_input").read()) // 1000 for h in glob.glob("/sys/class/hwmon/hwmon*") if open(h + "/name").read().strip() == "nvme")

def alerts():
    try:
        d = json.load(urllib.request.urlopen("http://localhost:9091/api/v1/alerts", timeout=3))["data"]["alerts"]
    except Exception:
        return None
    return [{"name": a["labels"]["alertname"], "summary": a["annotations"].get("summary", "")} for a in d
            if a["state"] == "firing" and a["labels"]["alertname"] not in ("Watchdog", "TestNotification")]

vram, plimit = gpu()
print(json.dumps({"mem": mem(), "vram": vram, "plimit": plimit, "disk": disk(), "nvme": nvme(), "alerts": alerts()}, ensure_ascii=False))
