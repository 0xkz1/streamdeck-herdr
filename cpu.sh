#!/bin/sh
# CPU の "温度(Tctl) 使用率" を1行で出す (例: 48 3)。使用率は 0.5 秒間の /proc/stat 差分
for h in /sys/class/hwmon/hwmon*; do [ "$(cat $h/name)" = k10temp ] && t=$(( $(cat $h/temp1_input) / 1000 )) && break; done
a=$(head -1 /proc/stat); sleep 0.5; b=$(head -1 /proc/stat)
echo "$t $(echo "$a $b" | awk '{ i1=$5+$6; t1=0; for(k=2;k<=11;k++) t1+=$k; i2=$16+$17; t2=0; for(k=13;k<=22;k++) t2+=$k; printf "%d", (1-(i2-i1)/(t2-t1))*100 }')"
