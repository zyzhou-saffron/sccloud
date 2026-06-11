#!/bin/bash
# 查询 pipeline 内存占用
# 用法: ./query_mem.sh [pipeline_id]
# 无参数: 显示所有 pipeline 数据
STATS="/data/projects/.monitor/mem_stats.json"
if [ ! -f "$STATS" ]; then
    echo "无监控数据"
    exit 1
fi
if [ -n "$1" ]; then
    python3 -c "
import json
d = json.load(open(\"$STATS\"))
p = d.get(\"$1\", {})
if not p:
    print(\"无数据\")
else:
    for step, info in p.items():
        print(f\"  {step:15s}  峰值: {info[\"peak_memory_mb\"]:>8.1f} MB  ({info[\"samples\"]} 次采样)\")
"
else
    python3 -c "
import json
d = json.load(open(\"$STATS\"))
for pid, steps in d.items():
    print(f\"Pipeline {pid[:12]}...\")
    for step, info in steps.items():
        print(f\"  {step:15s}  峰值: {info[\"peak_memory_mb\"]:>8.1f} MB  ({info[\"samples\"]} 次采样)\")
    print()
"
fi
