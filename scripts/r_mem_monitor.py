#!/usr/bin/env python3
"""
R Engine Memory Monitor
每 2 秒采样 R 引擎内存（主引擎 + worker），按 pipeline 步骤记录峰值。
数据保存到 /data/projects/.monitor/mem_stats.json
"""

import json
import os
import subprocess
import time
from datetime import datetime, timezone

MONITOR_DIR = "/data/projects/.monitor"
STATS_FILE = os.path.join(MONITOR_DIR, "mem_stats.json")
INTERVAL = 2

DB_USER = "sccloud_app"
DB_PASS = "sccloud_2024_prod"
DB_NAME = "sccloud_v2"

# 重任务步骤（走 worker 容器），其余走主引擎
HEAVY_STEPS = {
    "qc", "normalize", "reduce", "cluster", "annotate",
    "markers", "enrich", "monocle", "cellchat", "wgcna", "infercnv",
}

WORKER_CONTAINERS = [f"sccloud-v2-r-engine-worker-{i}" for i in range(3, 11)]


def get_r_pid(container):
    """获取指定容器内 R 进程的宿主机 PID"""
    try:
        out = subprocess.check_output(
            ["docker", "top", container, "-o", "pid,comm"],
            text=True, timeout=5, stderr=subprocess.DEVNULL,
        )
        for line in out.strip().split("\n")[1:]:
            parts = line.split()
            if len(parts) >= 2 and parts[-1] == "R":
                return int(parts[0])
    except Exception:
        pass
    return None


def read_rss_mb(pid):
    try:
        with open(f"/proc/{pid}/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return round(int(line.split()[1]) / 1024, 1)
    except (FileNotFoundError, ValueError, IndexError):
        pass
    return None


def query_db(sql):
    try:
        out = subprocess.check_output(
            ["docker", "exec", "sccloud-v2-db-1",
             "mariadb", f"-u{DB_USER}", f"-p{DB_PASS}", DB_NAME, "-N", "-e", sql],
            text=True, timeout=10, stderr=subprocess.DEVNULL,
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


IDLE_WORKER_MB = 500  # 空闲 worker R 进程约 200MB，超过此值视为有任务在跑

def find_active_worker_rss():
    """扫描所有 worker 容器，返回内存最高的 worker 的 RSS（仅当超过空闲阈值）"""
    max_rss = 0
    for c in WORKER_CONTAINERS:
        pid = get_r_pid(c)
        if pid:
            rss = read_rss_mb(pid)
            if rss and rss > max_rss:
                max_rss = rss
    return max_rss if max_rss > IDLE_WORKER_MB else None


def monitor():
    os.makedirs(MONITOR_DIR, exist_ok=True)
    stats = load_stats()

    active_task_id = None
    active_pipeline_id = None
    active_step = None
    peak_rss = 0
    samples = 0
    active_is_heavy = False

    # 主引擎 PID 缓存
    main_pid = None
    main_pid_ts = 0

    print(f"[Monitor] Started at {datetime.now()}", flush=True)

    while True:
        try:
            # 主引擎 PID（每 30s 刷新一次）
            now = time.time()
            if now - main_pid_ts > 30:
                main_pid = get_r_pid("sccloud-v2-r-engine-1")
                main_pid_ts = now

            # 每 10 秒检查数据库
            if samples % 5 == 0:
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
                    if active_task_id and active_pipeline_id and peak_rss > 0:
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
                    active_is_heavy = new_step in HEAVY_STEPS if new_step else False
                    peak_rss = 0
                    samples = 0

            # 采样内存
            rss = None
            if active_task_id and active_is_heavy:
                # 重任务：从 worker 容器读取
                rss = find_active_worker_rss()
            elif main_pid:
                # 轻任务或无任务：从主引擎读取
                rss = read_rss_mb(main_pid)

            if rss is not None:
                samples += 1
                if rss > peak_rss:
                    peak_rss = rss

            time.sleep(INTERVAL)

        except KeyboardInterrupt:
            print("[Monitor] Stopped", flush=True)
            break
        except Exception as e:
            print(f"[Monitor] Error: {e}", flush=True)
            time.sleep(INTERVAL)


if __name__ == "__main__":
    monitor()
