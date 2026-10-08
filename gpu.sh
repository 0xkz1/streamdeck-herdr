#!/bin/sh
# GPU の "温度 使用率 電力" を1行で出す (例: 28 0 17.5)
nvidia-smi --query-gpu=temperature.gpu,utilization.gpu,power.draw --format=csv,noheader,nounits | tr -d ',' 
