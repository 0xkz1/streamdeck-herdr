#!/usr/bin/env python3
"""Queue the same Herdr Automations patrol used by the periodic schedule."""
import argparse
import json
import os
from pathlib import Path
import socket
import sys
import uuid

AUTOMATION_ID = "herdr-patrol"


def control(path, method):
    request = {"id": str(uuid.uuid4()), "method": method, "params": {"id": AUTOMATION_ID}}
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stream:
        stream.settimeout(5)
        stream.connect(str(path))
        stream.sendall((json.dumps(request) + "\n").encode())
        with stream.makefile("rb") as reader:
            response = json.loads(reader.readline(1024 * 1024))
    if response.get("id") != request["id"] or response.get("ok") is not True:
        raise RuntimeError(response.get("error") or "Automations の受付を確認できません")
    return response


def summary(state_dir):
    progress_path = state_dir / "progress.json"
    if progress_path.exists():
        result = json.loads(progress_path.read_text())
        if result.get("state") == "running":
            try:
                cmdline = Path(f"/proc/{int(result['pid'])}/cmdline").read_bytes()
                alive = b"patrol.py" in cmdline
            except (OSError, ValueError, KeyError):
                alive = False
            if not alive:
                result["state"] = "interrupted"
        # Export counts only, never conversation content.
        return {key: result.get(key) for key in ("state", "processed", "total", "counts", "updated_at")}
    report_path = state_dir / "last-report.json"
    if not report_path.exists():
        return {"state": "idle", "counts": {}, "processed": 0, "total": 0}
    rows = json.loads(report_path.read_text()).get("results", [])
    counts = {name: sum(row.get("action") == name for row in rows)
              for name in ("sent", "hold", "complete", "skip", "uncertain")}
    counts["failed"] = sum(bool(row.get("error_type")) or row.get("reason", "").startswith("読み取りまたは判定に失敗") for row in rows)
    return {"state": "done", "counts": counts, "processed": len(rows), "total": len(rows),
            "updated_at": report_path.stat().st_mtime}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("method", choices=["run-now", "status", "reload", "enable", "disable", "summary"], nargs="?", default="run-now")
    args = parser.parse_args()
    home = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local/state")
    path = home / "herdr/plugins/ram4.herdr-automations/control.sock"
    try:
        response = summary(home / "herdr-patrol") if args.method == "summary" else control(path, args.method)
    except (OSError, ValueError, RuntimeError) as error:
        print(f"巡回の受付失敗: {error}。Herdr と Automations の起動を確認してください。自動再送はしません。", file=sys.stderr)
        return 1
    print(json.dumps(response, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
