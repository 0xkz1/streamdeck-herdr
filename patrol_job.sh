#!/bin/bash
set -eu
tool_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/herdr-patrol"
umask 077
mkdir -p "$state_dir"
# Each occurrence replaces the previous log; patrol.py holds the shared lock.
exec /usr/bin/python3 "$tool_dir/patrol.py" --apply --timeout 0 --state-dir "$state_dir" > "$state_dir/last-run.log" 2>&1
