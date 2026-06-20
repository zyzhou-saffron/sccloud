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

redis_url <- Sys.getenv("REDIS_URL", "redis://127.0.0.1:6380/0")
QUEUE  <- "scc:heavyqueue"
worker_id <- Sys.getenv("WORKER_ID", as.character(Sys.getpid()))

connect <- function() redux::hiredis(url = redis_url)
r <- connect()
message("[worker ", worker_id, "] started; BRPOP ", QUEUE, " @ ", redis_url)

pid_alive <- function(p) !is.na(p) && system(paste("kill -0", p), ignore.stderr = TRUE) == 0L

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
    got <- tryCatch(r$SET(lock_key, worker_id, "EX", "120", "NX"), error = function(e) NULL)
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

  # 监督
  cancelled <- FALSE
  while (pid_alive(pid)) {
    flag <- tryCatch(r$GET(paste0("scc:cancel:", task_id)), error = function(e) NULL)
    if (!is.null(flag)) {
      message("[worker ", worker_id, "] CANCEL task=", task_id, " → kill -9 ", pid)
      system(paste("kill -9", pid), ignore.stderr = TRUE)
      cancelled <- TRUE; break
    }
    if (!is.null(lock_key)) tryCatch(r$EXPIRE(lock_key, 120), error = function(e) NULL)  # 续锁
    Sys.sleep(1)
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
  if (!is.null(lock_key)) tryCatch(r$DEL(lock_key), error = function(e) NULL)  # 释放目录锁
  message("[worker ", worker_id, "] task=", task_id, " 完成(cancelled=", cancelled, ")")
  unlink(c(spec_file, result_out, pid_file))
}
