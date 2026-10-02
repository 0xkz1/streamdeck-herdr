#!/bin/sh
# 基盤サービスの死活を "名前=HTTPコード" で出す
code() { curl -s -m 3 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null; }
echo "litellm=$(code http://localhost:4001/health/liveliness) ollama=$(code http://localhost:11434/api/tags) opendesign=$(code http://localhost:3003)"
