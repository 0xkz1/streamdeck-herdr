#!/bin/sh
# GPU 電力制限を 360W(既定)⇔ 250W(最小)で切り替える。要: /etc/sudoers.d/nvidia-plimit(forge/monitoring/sudoers-nvidia-plimit 参照)
cur=$(nvidia-smi --query-gpu=power.limit --format=csv,noheader,nounits | cut -d. -f1)
if [ "$cur" -ge 360 ]; then sudo -n /usr/bin/nvidia-smi -pl 250; else sudo -n /usr/bin/nvidia-smi -pl 360; fi
