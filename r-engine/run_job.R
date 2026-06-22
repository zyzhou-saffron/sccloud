#!/usr/bin/env Rscript
# ======================================================================
# 独立 job 执行器 (#42 Phase2-M2)
# 被 worker spawn，每个重任务 = 一个独立 Rscript 进程 → 干净可 kill、算完即退、内存全回收。
#   用法: Rscript run_job.R <spec.json>
#   spec: { step, project_path, params, result_out }
#
# 真实 step 复用现有 plumber 端点：plumber::plumb() 解析出 router，再用 pr$call(req)
# 在**进程内**路由一个合成的 POST 请求 → 直接跑该端点的计算（不起 HTTP server、不复刻
# 逻辑、不改 plumber.R）。结果(端点返回的 JSON)写入 result_out。
# ======================================================================

suppressMessages(library(jsonlite))
`%||%` <- function(a, b) if (is.null(a) || length(a) == 0) b else a

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 1) stop("用法: Rscript run_job.R <spec.json>")
spec       <- jsonlite::read_json(args[1], simplifyVector = TRUE)
step       <- spec$step
result_out <- spec$result_out

# ── _selftest：纯睡眠，用于验证 worker 能跑 + 能被中途 kill（不依赖 plumber/数据）──
if (identical(step, "_selftest")) {
  source("/app/R/utils.R")
  report <- create_progress_reporter(spec$params$task_id %||% "job")
  n <- as.integer(spec$params$seconds %||% 30)
  for (i in seq_len(n)) { report(round(i / n * 100), paste0("自测 ", i, "/", n)); Sys.sleep(1) }
  jsonlite::write_json(list(status = "success", message = "selftest done"), result_out, auto_unbox = TRUE)
  quit(save = "no")
}

# ── 真实 step：原地路由进现有 plumber 端点 ──
setwd("/app")
suppressMessages({ pr <- plumber::plumb("/app/plumber.R") })

body_json <- as.character(jsonlite::toJSON(
  list(project_path = spec$project_path, params = spec$params), auto_unbox = TRUE, null = "null"))

req <- new.env()
req$REQUEST_METHOD <- "POST"
req$PATH_INFO      <- paste0("/", step)
req$QUERY_STRING   <- ""
req$CONTENT_TYPE   <- "application/json"
req$postBody       <- body_json
req$rook.input     <- list(
  read_lines = function(...) body_json,
  read       = function(...) charToRaw(body_json),
  rewind     = function() NULL
)

res <- tryCatch(
  pr$call(req),
  error = function(e) list(
    status = 500L,
    body = jsonlite::toJSON(list(error = conditionMessage(e)), auto_unbox = TRUE)
  )
)

# 端点返回的 body 已是最终结果 JSON（成功含 status:success；失败 500 含 error）。原样写回。
b <- if (is.character(res$body)) res$body else rawToChar(res$body)
writeLines(b, result_out)
message("[run_job] step=", step, " http_status=", res$status %||% "?")
