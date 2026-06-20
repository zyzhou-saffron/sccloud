#!/usr/bin/env Rscript
# ======================================================================
# 独立 job 执行器 (#42 Phase2 M1)
# 由 worker.R spawn，每个重任务 = 一个独立 Rscript 进程 → 干净可 kill。
#   用法: Rscript run_job.R <spec.json>
#   spec.json: { step, project_path, params, result_out }
# 结果写入 spec$result_out (JSON)；进度复用 utils.R::create_progress_reporter (走 Redis)。
# ======================================================================

suppressMessages({ library(jsonlite) })
`%||%` <- function(a, b) if (is.null(a) || length(a) == 0) b else a

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 1) stop("用法: Rscript run_job.R <spec.json>")
spec <- jsonlite::read_json(args[1], simplifyVector = TRUE)
step         <- spec$step
project_path <- spec$project_path
params       <- spec$params
result_out   <- spec$result_out

# 进度上报（与 plumber 端点同一套 Redis 通道）
source("/app/R/utils.R")
report <- create_progress_reporter(params$task_id %||% "job")

# ── step 分派 ──
# M1: 先只接 _selftest（验证 worker 能跑+能被 kill）；cluster/infercnv 在基础设施验证后接入。
run_step <- function(step, project_path, params) {
  if (identical(step, "_selftest")) {
    n <- as.integer(params$seconds %||% 30)
    report(1, paste0("自测开始，预计 ", n, "s"))
    for (i in seq_len(n)) {
      report(round(i / n * 100), paste0("自测进行中 ", i, "/", n))
      Sys.sleep(1)
    }
    return(list(status = "success", message = "selftest done", seconds = n))
  }
  stop(paste0("step 尚未接入 job 模式: ", step))
}

res <- tryCatch(
  run_step(step, project_path, params),
  error = function(e) list(status = "error", error = conditionMessage(e))
)

jsonlite::write_json(res, result_out, auto_unbox = TRUE, null = "null")
message("[run_job] step=", step, " → ", res$status %||% "?", " written to ", result_out)
