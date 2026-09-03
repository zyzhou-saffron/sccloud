#!/usr/bin/env Rscript
# ======================================================================
# 重任务 worker (#42 Phase2 M1)
# 循环：BRPOP 队列 → spawn run_job.R(独立进程) → 监督存活 + 轮询取消标志 → 可 kill。
# Redis 约定:
#   队列        scc:heavyqueue           backend LPUSH job JSON, worker BRPOP
#   取消        scc:cancel:<task_id>      backend SET(带 TTL), worker GET 轮询
#   结果        scc:result:<task_id>      worker LPUSH 结果 JSON, backend BRPOP(阻塞等)
# 每个重任务一个独立 Rscript 进程 → kill -9 即可干净中止当前步。
# ======================================================================

suppressMessages({ library(redux); library(jsonlite) })
`%||%` <- function(a, b) if (is.null(a) || length(a) == 0) b else a

# 加载 C 小助手：正确 reap 子进程，避免 R 的 system(wait=FALSE) 留下僵尸
# reap.so 在 Dockerfile 里用 R CMD SHLIB 编译
tryCatch(dyn.load("/app/reap.so"), error = function(e) {
  message("[worker] 无法加载 reap.so: ", conditionMessage(e))
})
pid_status <- function(p) {
  if (is.na(p)) return(-2L)
  res <- .C("reap_pid", pid = as.integer(p), status = integer(1), PACKAGE = "reap")
  res$status
}
# system(wait=FALSE) 在部分环境下 spawn 的进程不是 R 的 waitable 子进程
# → waitpid 恒 ECHILD(-2)，若只信 reap 会立刻误判结束并 unlink spec，run_job 读不到文件。
# kill -0 探测存活；进程仍在则视为 running(-1)。
pid_alive <- function(p) {
  if (is.na(p) || p <= 1L) return(FALSE)
  system(sprintf("kill -0 %d", as.integer(p)), ignore.stderr = TRUE) == 0
}
pid_finished <- function(p) {
  st <- pid_status(p)
  if (st == -1L) return(list(done = FALSE, status = st))
  if (st == -2L && pid_alive(p)) return(list(done = FALSE, status = -1L))
  list(done = TRUE, status = st)
}

redis_url <- Sys.getenv("REDIS_URL", "redis://127.0.0.1:6380/0")
QUEUE  <- "scc:heavyqueue"
worker_id <- Sys.getenv("WORKER_ID", as.character(Sys.getpid()))

connect <- function() redux::hiredis(url = redis_url)
r <- connect()
message("[worker ", worker_id, "] started; BRPOP ", QUEUE, " @ ", redis_url)

repeat {
  job <- tryCatch(r$BRPOP(QUEUE, 5), error = function(e) {
    message("[worker ", worker_id, "] redis err: ", conditionMessage(e)); Sys.sleep(2)
    r <<- tryCatch(connect(), error = function(e2) r); NULL
  })
  if (is.null(job)) next  # BRPOP 超时, 继续

  spec <- tryCatch(jsonlite::fromJSON(job[[2]]), error = function(e) NULL)
  if (is.null(spec)) { message("[worker ", worker_id, "] 坏 job, 跳过"); next }
  task_id <- spec$params$task_id %||% spec$task_id %||% "unknown"
  message("[worker ", worker_id, "] got task=", task_id, " step=", spec$step)

  # ── 同项目并发写文件锁 (#42)：同一分析目录串行, 不同目录照常并行 ──
  # 防多个 worker 同时往一个项目目录写 .rds/.json → 写花文件/读到半成品。
  # SET NX 原子抢锁; 抢不到说明该目录有任务在跑 → 把 job 放回队首让 BRPOP 先处理别的项目, 稍后再试。
  # 锁 TTL 120s, 监督循环里每秒续期 → 长任务不掉锁; worker 意外死亡则锁 ≤120s 自动过期, 不会锁死。
  proj_path <- spec$project_path %||% spec$params$project_path %||% ""
  lock_key  <- if (nzchar(proj_path)) paste0("scc:lock:", proj_path) else NULL
  if (!is.null(lock_key)) {
    # 用底层 command() 发带 EX/NX 选项的 SET(redux 便捷 r$SET 不支持选项参数)。成功回 "OK", NX 失败回 NULL。
    got <- tryCatch(r$command(list("SET", lock_key, worker_id, "EX", "120", "NX")), error = function(e) NULL)
    if (is.null(got)) {
      tryCatch(r$LPUSH(QUEUE, job[[2]]), error = function(e) NULL)
      Sys.sleep(0.5)
      next
    }
  }

  spec_file  <- tempfile(fileext = ".json")
  result_out <- tempfile(fileext = ".result.json")
  pid_file   <- tempfile(fileext = ".pid")
  spec$result_out <- result_out
  jsonlite::write_json(spec, spec_file, auto_unbox = TRUE, null = "null")

  # bash 包装: echo $$ 记录 PID, 然后 exec 进 Rscript(同一 PID) → 便于精确 kill
  cmd <- sprintf("bash -c 'echo $$ > %s; exec Rscript /app/run_job.R %s'",
                 pid_file, spec_file)
  system(cmd, wait = FALSE)

  # 取 PID
  pid <- NA_integer_
  for (i in 1:20) { Sys.sleep(0.2); if (file.exists(pid_file)) {
    pid <- suppressWarnings(as.integer(readLines(pid_file, warn = FALSE)[1])); if (!is.na(pid)) break } }
  message("[worker ", worker_id, "] spawned pid=", pid)
  r$SET(paste0("scc:pid:", task_id), as.character(pid))

  # 持久化资源监控峰值（项目目录 + Redis 双写）
  metrics_file <- file.path(proj_path, ".scc_step_metrics.json")
  peak_mem_bytes <- NA_real_
  peak_cpu_usec <- NA_real_

  # 监督
  cancelled <- FALSE
  finished_status <- -1L
  while (TRUE) {
    # Redis 断连时重连, 否则整段任务期间读不到 cancel、续不了目录锁(bot #64)。BRPOP 主循环也是这套。
    flag <- tryCatch(r$GET(paste0("scc:cancel:", task_id)),
                     error = function(e) { r <<- tryCatch(connect(), error = function(e2) r); NULL })
    if (!is.null(flag)) {
      message("[worker ", worker_id, "] CANCEL task=", task_id, " → kill -9 ", pid)
      system(paste("kill -9", pid), ignore.stderr = TRUE)
      # 等进程真正消失再收结果，避免仍在跑时 unlink spec
      for (j in 1:20) { if (!pid_alive(pid)) break; Sys.sleep(0.1) }
      cancelled <- TRUE
      finished_status <- -9L
      break
    }
    if (!is.null(lock_key)) tryCatch(r$EXPIRE(lock_key, 120), error = function(e) NULL)  # 续锁
    # 上报本容器实时内存(memory.current, 含 run_job 子进程) → 后端动态预算汇总 scc:wmem:*
    mem <- tryCatch(suppressWarnings(readLines("/sys/fs/cgroup/memory.current", warn = FALSE)[1]),
                    error = function(e) NA)
    if (!is.na(mem) && nzchar(mem)) {
      mem_bytes <- suppressWarnings(as.numeric(mem))
      if (!is.na(mem_bytes)) {
        if (is.na(peak_mem_bytes) || mem_bytes > peak_mem_bytes) peak_mem_bytes <- mem_bytes
        tryCatch(r$command(list("SET", paste0("scc:wmem:", task_id), mem, "EX", "30")),
                 error = function(e) NULL)
      }
    }

    # 上报本容器累计 CPU 时间（微秒），供资源监控脚本计算 CPU%
    cpu_usage <- NA
    cpu_stat <- tryCatch(suppressWarnings(readLines("/sys/fs/cgroup/cpu.stat", warn = FALSE)),
                         error = function(e) character(0))
    usage_line <- grep("^usage_usec\\s+", cpu_stat, value = TRUE)
    if (length(usage_line) > 0) {
      cpu_usage <- suppressWarnings(as.numeric(strsplit(usage_line[1], "\\s+")[[1]][2]))
      if (!is.na(cpu_usage)) {
        if (is.na(peak_cpu_usec) || cpu_usage > peak_cpu_usec) peak_cpu_usec <- cpu_usage
        tryCatch(r$command(list("SET", paste0("scc:wcpu:", task_id), as.character(cpu_usage), "EX", "30")),
                 error = function(e) NULL)
      }
    }

    fin <- pid_finished(pid)
    if (fin$done) {
      finished_status <- fin$status
      # 进程刚退出时结果文件可能尚未 fsync 完，短等一下
      if (!cancelled && !file.exists(result_out)) {
        for (j in 1:10) { if (file.exists(result_out)) break; Sys.sleep(0.1) }
      }
      break
    }
    Sys.sleep(1)
  }

  # 任务结束时把峰值资源写入项目目录持久文件
  if (nzchar(proj_path) && !is.null(spec$step)) {
    tryCatch({
      entry <- list(
        task_id = task_id,
        step = spec$step,
        worker = worker_id,
        started_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
        peak_mem_bytes = if (is.na(peak_mem_bytes)) NULL else peak_mem_bytes,
        peak_mem_gb = if (is.na(peak_mem_bytes)) NULL else round(peak_mem_bytes / 1024 / 1024 / 1024, 3),
        peak_cpu_usec = if (is.na(peak_cpu_usec)) NULL else peak_cpu_usec,
        status = if (cancelled) "cancelled" else "finished"
      )
      existing <- if (file.exists(metrics_file)) jsonlite::read_json(metrics_file) else list()
      if (!is.list(existing) || length(existing) == 0 || is.null(names(existing))) existing <- list()
      existing[[length(existing) + 1]] <- entry
      jsonlite::write_json(existing, metrics_file, auto_unbox = TRUE, pretty = TRUE)
    }, error = function(e) message("[worker] metrics persistence failed: ", conditionMessage(e)))
  }

  # 投递结果
  if (cancelled) {
    out <- jsonlite::toJSON(list(status = "cancelled", task_id = task_id), auto_unbox = TRUE)
  } else if (file.exists(result_out)) {
    out <- paste(readLines(result_out, warn = FALSE), collapse = "")
  } else {
    out <- jsonlite::toJSON(list(status = "error",
             error = "run_job 进程退出但无结果(可能崩溃/OOM)"), auto_unbox = TRUE)
  }
  tryCatch(r$LPUSH(paste0("scc:result:", task_id), out), error = function(e) NULL)
  r$DEL(paste0("scc:pid:", task_id))
  # scc:wmem / scc:wcpu 保留 30s TTL 自动过期，便于监控脚本读取最终峰值
  if (!is.null(lock_key)) tryCatch(r$DEL(lock_key), error = function(e) NULL)  # 释放目录锁
  message("[worker ", worker_id, "] task=", task_id, " 完成(cancelled=", cancelled, ")")
  unlink(c(spec_file, result_out, pid_file))
}
