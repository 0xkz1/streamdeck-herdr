#!/usr/bin/env python3
"""Hermes cron の最終実行状態を JSON で出す: {job_id: [last_status, last_run_at, state]}"""
import json, os
d = json.load(open(os.path.expanduser("~/.hermes/cron/jobs.json")))
jobs = d["jobs"] if isinstance(d, dict) else d
print(json.dumps({j["id"]: [j.get("last_status"), j.get("last_run_at"), j.get("state")] for j in jobs}))
