#!/usr/bin/env python3
"""
scCloud v2 per-step resource monitor.
每 INTERVAL 秒轮询数据库，追踪每个 running task 的资源占用：
- 峰值内存 GB（来自 worker 上报的 scc:wmem:<task_id>，容器 memory.current 原始 bytes）
- 峰值 CPU %、平均 CPU %（来自 worker 上报的 scc:wcpu:<task_id>，cgroup cpu.stat usage_usec）
- 运行时长 s
结果写入 /data/projects/.monitor/mem_stats.json（pipeline_id -> step -> stats）。
"""
import fcntl
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

BASE_DIR = "/data1/home/zhouy1/Projects/scRNA/sccloud-v2"
ENV_FILE = os.path.join(BASE_DIR, ".env.server")
MONITOR_DIR = "/data/projects/.monitor"
STATS_FILE = os.path.join(MONITOR_DIR, "mem_stats.json")
LOG_FILE = os.path.join(MONITOR_DIR, "monitor.log")
LOCK_FILE = os.path.join(MONITOR_DIR, "monitor.lock")
INTERVAL = 2


def load_env():
    env = {}
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if line and "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    env[k] = v
    return env


ENV = load_env()
DB_USER = ENV.get("DB_USER", "sccloud_app")
DB_PASS = ENV.get("DB_PASS", "")
DB_NAME = ENV.get("DB_NAME", "sccloud_v2")
DB_HOST = "127.0.0.1"
DB_PORT = ENV.get("DB_PORT", "3307")
REDIS_PORT = ENV.get("REDIS_PORT", "6380")


def log(msg):
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    with open(LOG_FILE, "a") as f:
        f.write(line + "\n")


def db_query(sql):
    cmd = [
        "mysql", "-h", DB_HOST, "-P", DB_PORT,
        "-u", DB_USER, f"-p{DB_PASS}", DB_NAME,
        "-N", "-e", sql,
    ]
    try:
        out = subprocess.check_output(cmd, text=True, stderr=subprocess.DEVNULL, timeout=10)
        return out.strip()
    except Exception as e:
        log(f"DB query failed: {e}")
        return ""


def redis_get(key):
    try:
        out = subprocess.check_output(
            ["redis-cli", "-p", REDIS_PORT, "GET", key],
            text=True, stderr=subprocess.DEVNULL, timeout=5,
        )
        out = out.strip()
        return out if out else None
    except Exception:
        return None


def load_stats():
    if os.path.exists(STATS_FILE):
        try:
            with open(STATS_FILE) as f:
                return json.load(f)
        except Exception as e:
            log(f"Load stats failed: {e}")
    return {}


def save_stats(stats):
    os.makedirs(MONITOR_DIR, exist_ok=True)
    tmp = STATS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(stats, f, indent=2, ensure_ascii=False)
    os.replace(tmp, STATS_FILE)


def running_tasks():
    sql = (
        "SELECT t.id, t.step, t.pipeline_id, p.project_id, t.started_at "
        "FROM tasks t JOIN pipelines p ON t.pipeline_id = p.id "
        "WHERE t.status='running'"
    )
    rows = []
    for line in db_query(sql).splitlines():
        parts = line.split("\t")
        if len(parts) >= 5:
            rows.append({
                "task_id": parts[0],
                "step": parts[1],
                "pipeline_id": parts[2],
                "project_id": parts[3],
                "started_at": parts[4],
            })
    return rows


def finalize_entry(entry, end_ts=None):
    if end_ts is None:
        end_ts = time.time()
    entry["duration_seconds"] = round(end_ts - entry["start_ts"], 1)
    entry["end_time"] = datetime.fromtimestamp(end_ts, tz=timezone.utc).isoformat()
    if entry.get("cpu_samples", 0) > 0:
        entry["avg_cpu_percent"] = round(entry["cpu_sum"] / entry["cpu_samples"], 1)
    else:
        entry["avg_cpu_percent"] = 0.0
    # 保留两位小数便于阅读
    entry["peak_memory_gb"] = round(entry["peak_memory_mb"] / 1024 / 1024 / 1024, 2)


def commit_entry(stats, entry):
    pipeline_id = entry["pipeline_id"]
    step = entry["step"]
    if pipeline_id not in stats:
        stats[pipeline_id] = {}
    # 只保留需要持久化的字段
    stats[pipeline_id][step] = {
        "task_id": entry["task_id"],
        "project_id": entry["project_id"],
        "peak_memory_mb": round(entry["peak_memory_mb"], 1),
        "peak_memory_gb": entry["peak_memory_gb"],
        "peak_cpu_percent": entry["peak_cpu_percent"],
        "avg_cpu_percent": entry["avg_cpu_percent"],
        "duration_seconds": entry["duration_seconds"],
        "start_time": entry["start_time"],
        "end_time": entry["end_time"],
        "samples": entry["samples"],
        "cpu_samples": entry["cpu_samples"],
        "recorded_at": datetime.now(timezone.utc).isoformat(),
    }
    save_stats(stats)


def main():
    with open(LOCK_FILE, "w") as lf:
        try:
            fcntl.flock(lf, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log("Another monitor is already running. Exiting.")
            sys.exit(0)

        log("Monitor started")
        stats = load_stats()
        active = {}  # task_id -> entry
        prev_cpu = {}  # task_id -> (usage_usec, ts)

        while True:
            try:
                now = time.time()
                tasks = running_tasks()
                running_ids = {t["task_id"] for t in tasks}

                # 结束已经不在 running 的任务
                for tid in list(active.keys()):
                    if tid not in running_ids:
                        entry = active.pop(tid)
                        # 尝试读最终值
                        mem = redis_get(f"scc:wmem:{tid}")
                        if mem:
                            mb = float(mem) / 1024
                            entry["peak_memory_mb"] = max(entry["peak_memory_mb"], mb)
                        cpu = redis_get(f"scc:wcpu:{tid}")
                        if cpu and tid in prev_cpu:
                            usage = float(cpu)
                            last_usage, last_ts = prev_cpu[tid]
                            if usage >= last_usage and now > last_ts:
                                pct = (usage - last_usage) / ((now - last_ts) * 1e6) * 100
                                entry["peak_cpu_percent"] = max(entry["peak_cpu_percent"], pct)
                                entry["cpu_sum"] += pct
                                entry["cpu_samples"] += 1
                        prev_cpu.pop(tid, None)
                        finalize_entry(entry, now)
                        commit_entry(stats, entry)
                        log(f"Finished {entry['step']} task={tid} peak_mem={entry['peak_memory_gb']}GB "
                            f"peak_cpu={entry['peak_cpu_percent']}% avg_cpu={entry['avg_cpu_percent']}% "
                            f"dur={entry['duration_seconds']}s")

                # 初始化新任务
                for t in tasks:
                    tid = t["task_id"]
                    if tid not in active:
                        active[tid] = {
                            "task_id": tid,
                            "step": t["step"],
                            "pipeline_id": t["pipeline_id"],
                            "project_id": t["project_id"],
                            "start_ts": now,
                            "start_time": datetime.fromtimestamp(now, tz=timezone.utc).isoformat(),
                            "peak_memory_mb": 0.0,
                            "peak_cpu_percent": 0.0,
                            "cpu_sum": 0.0,
                            "cpu_samples": 0,
                            "samples": 0,
                        }
                        prev_cpu[tid] = (0.0, now)

                # 采样当前 running 任务
                for tid, entry in active.items():
                    mem = redis_get(f"scc:wmem:{tid}")
                    if mem:
                        mb = float(mem) / 1024
                        if mb > entry["peak_memory_mb"]:
                            entry["peak_memory_mb"] = mb

                    cpu = redis_get(f"scc:wcpu:{tid}")
                    if cpu:
                        usage = float(cpu)
                        if tid in prev_cpu:
                            last_usage, last_ts = prev_cpu[tid]
                            if usage >= last_usage and now > last_ts:
                                pct = (usage - last_usage) / ((now - last_ts) * 1e6) * 100
                                if pct > entry["peak_cpu_percent"]:
                                    entry["peak_cpu_percent"] = pct
                                entry["cpu_sum"] += pct
                                entry["cpu_samples"] += 1
                        prev_cpu[tid] = (usage, now)

                    entry["samples"] += 1

                # 每轮都保存，保证数据不丢
                if active:
                    for tid, entry in active.items():
                        # 对未结束任务也保存当前峰值（不覆盖 duration/end_time）
                        stats.setdefault(entry["pipeline_id"], {})[entry["step"]] = {
                            "task_id": entry["task_id"],
                            "project_id": entry["project_id"],
                            "peak_memory_mb": round(entry["peak_memory_mb"], 1),
                            "peak_memory_gb": round(entry["peak_memory_mb"] / 1024 / 1024 / 1024, 2),
                            "peak_cpu_percent": round(entry["peak_cpu_percent"], 1),
                            "avg_cpu_percent": round(entry["cpu_sum"] / entry["cpu_samples"], 1) if entry["cpu_samples"] else 0.0,
                            "duration_seconds": round(now - entry["start_ts"], 1),
                            "start_time": entry["start_time"],
                            "end_time": None,
                            "samples": entry["samples"],
                            "cpu_samples": entry["cpu_samples"],
                            "recorded_at": datetime.now(timezone.utc).isoformat(),
                        }
                    save_stats(stats)

            except Exception as e:
                log(f"Monitor loop error: {e}")

            time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
