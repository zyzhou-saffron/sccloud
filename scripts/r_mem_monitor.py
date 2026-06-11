#!/usr/bin/env python3
"""
R Engine Memory Monitor
每 2 秒采样 R 引擎内存，按 pipeline 步骤记录峰值。
数据保存到 /data/projects/.monitor/mem_stats.json
"""

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone

MONITOR_DIR = "/data/projects/.monitor"
STATS_FILE = os.path.join(MONITOR_DIR, "mem_stats.json")
INTERVAL = 2  # 采样间隔（秒）

DB_USER = "sccloud_app"
DB_PASS = "sccloud_2024_prod"
DB_NAME = "sccloud_v2"


def get_r_engine_pid():
    """获取 R 引擎主进程的宿主机 PID"""
    try:
        out = subprocess.check_output(
            ["docker", "top", "sccloud-v2-r-engine-1", "-o", "pid,comm"],
            text=True, timeout=5,
        )
        for line in out.strip().split("\n")[1:]:
            parts = line.split()
            if len(parts) >= 2 and parts[-1] == "R":
                return int(parts[0])
    except Exception:
        pass
    return None


def read_rss_mb(pid):
    """读取进程 RSS (MB)"""
    try:
        with open(f"/proc/{pid}/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    kb = int(line.split()[1])
                    return round(kb / 1024, 1)
    except (FileNotFoundError, ValueError, IndexError):
        pass
    return None


def query_db(sql):
    """执行 MariaDB 查询，返回结果行"""
    try:
        out = subprocess.check_output(
            [
                "docker", "exec", "sccloud-v2-db-1",
                "mariadb", f"-u{DB_USER}", f"-p{DB_PASS}", DB_NAME,
                "-N", "-e", sql,
            ],
            text=True, timeout=10,
            stderr=subprocess.DEVNULL,
        )
        return out.strip()
    except Exception:
        return ""


def load_stats():
    if os.path.exists(STATS_FILE):
        try:
            with open(STATS_FILE) as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def save_stats(stats):
    os.makedirs(MONITOR_DIR, exist_ok=True)
    tmp = STATS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(stats, f, indent=2, ensure_ascii=False)
    os.replace(tmp, STATS_FILE)


def monitor():
    os.makedirs(MONITOR_DIR, exist_ok=True)
    stats = load_stats()

    active_task_id = None
    active_pipeline_id = None
    peak_rss = 0
    samples = 0

    print(f"[Monitor] Started at {datetime.now()}", flush=True)

    while True:
        try:
            # 检查 R 引擎是否在运行
            pid = get_r_engine_pid()
            if pid is None:
                time.sleep(INTERVAL)
                continue

            # 采样内存
            rss = read_rss_mb(pid)
            if rss is not None:
                samples += 1
                if rss > peak_rss:
                    peak_rss = rss

            # 每 10 秒检查一次数据库（减少开销）
            if samples % 5 == 1:
                row = query_db(
                    "SELECT id, step, pipeline_id FROM tasks "
                    "WHERE status='running' ORDER BY started_at DESC LIMIT 1"
                )
                new_task_id = None
                new_step = None
                new_pipeline_id = None
                if row:
                    parts = row.split("\t")
                    if len(parts) >= 3:
                        new_task_id, new_step, new_pipeline_id = parts[0], parts[1], parts[2]

                # 步骤切换：保存上一步的峰值
                if new_task_id != active_task_id:
                    if active_task_id and active_pipeline_id:
                        if active_pipeline_id not in stats:
                            stats[active_pipeline_id] = {}
                        stats[active_pipeline_id][active_step] = {
                            "peak_memory_mb": peak_rss,
                            "samples": samples,
                            "recorded_at": datetime.now(timezone.utc).isoformat(),
                        }
                        save_stats(stats)
                        print(
                            f"[Monitor] {active_step}: peak={peak_rss} MB ({samples} samples)",
                            flush=True,
                        )

                    active_task_id = new_task_id
                    active_step = new_step
                    active_pipeline_id = new_pipeline_id
                    peak_rss = rss or 0
                    samples = 0

            time.sleep(INTERVAL)

        except KeyboardInterrupt:
            print("[Monitor] Stopped", flush=True)
            break
        except Exception as e:
            print(f"[Monitor] Error: {e}", flush=True)
            time.sleep(INTERVAL)


if __name__ == "__main__":
    monitor()
