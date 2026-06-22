# =====================================================================
# scCloud v2 — Plumber API 入口
#
# 设计原则:
#   1. 所有计算逻辑来自旧系统原始脚本 (data_processing.R / data_summary.R / data_plot.R)
#   2. 本文件只做 REST 包装: 接收参数 → 调用原始函数 → 返回 JSON/图片
#   3. 进度报告通过 Redis PUBLISH 推送到 FastAPI → WebSocket → 前端
#   4. 任何计算逻辑的修改必须在原始脚本中完成
#
# 来源映射:
#   /qc         → data_processing.R::get_mito(), totalMT_result()
#   /normalize  → data_summary.R::RunSCT()
#   /reduce     → data_plot.R::my_distPlot3()
#   /cluster    → data_summary.R::runHarmony(), RenameIdents2()
#   /markers    → data_summary.R::my_diffTable(), my_diffTable2()
#   /enrich     → data_plot.R::my_distPlot10()
#   /plot       → data_plot.R::my_distPlot1() ~ my_distPlot11()
#   /annotate   → data_summary.R::RunAnno()
#   /convert    → SeuratDisk (新增功能)
# =====================================================================

library(plumber)
library(jsonlite)
library(reticulate)
library(hdWGCNA)

# 全局 JSON 序列化：auto_unbox = TRUE 避免单值被包装为数组
# R jsonlite 默认将单个字符串/数字包装为 ["value"]，前端需要的是 "value"
options(plumber.json.serializer = function(...) {
  jsonlite::toJSON(..., auto_unbox = TRUE, null = "null")
})

# 加载进度报告工具 (唯一的新增基础设施代码)
source("R/utils.R")

# 加载旧系统原始计算脚本 — 零修改
source("R/data_processing.R")
source("R/data_summary.R")
source("R/data_plot.R")

# 全局 Nature 主题（覆盖 Seurat DimPlot/VlnPlot 默认主题）
tryCatch(theme_set(nature_theme()), error = function(e) message("theme_set skipped"))
source("R/gene_id_convert.R")

# 自定义错误处理器: 将 stop() 的原始消息透传给调用方
#* @plumber
function(pr) {
  pr$setErrorHandler(function(req, res, err) {
    res$status <- 500L
    msg <- conditionMessage(err)
    list(error = msg)
  })
}


# =====================================================================
# 文件命名辅助函数
# 双命名策略：归档名（含项目名+时间戳+步骤）+ 管道链名（固定名）
# =====================================================================

#' 生成带项目名+时间戳+步骤的归档文件名
#' @param project_path 项目目录路径（basename 用作项目名）
#' @param step_num     步骤编号（保留参数兼容性，但不再写入文件名）
#' @param step_name    步骤名 (如 "qc", "normalize", ...)
#' @param suffix       后缀描述 (如 "filtered", "SCT", ...)
#' @param ext          文件扩展名 (如 "rds", "png", ...)
#' @return 文件名字符串，如 "MyProject_20260422113900.qc_filtered.rds"
make_output_name <- function(project_path, step_num, step_name, suffix, ext) {
  proj <- basename(project_path)
  ts <- format(Sys.time(), "%Y%m%d%H%M%S", tz = "Asia/Shanghai")
  paste0(proj, "_", step_name, "_", ts, "_", suffix, ".", ext)
}

#' 保存文件并同时创建管道链名副本
#' @param archive_path 归档路径（带时间戳的完整路径）
#' @param canonical_path 管道链路径（固定名称，供下一步读取）
#' @param object 要保存的 R 对象（NULL 表示文件已存在，只需复制）
save_with_canonical <- function(archive_path, canonical_path, object = NULL) {
  if (!is.null(object)) {
    saveRDS(object, archive_path)
  }
  # 原子更新规范名(供下一步读取的固定名 .rds): 先复制到同目录临时文件, 再 file.rename 覆盖。
  # 同一文件系统 rename 是原子操作 → 即便任务被 kill -9 砍在中途, canonical 要么是旧的完整版、
  # 要么是新的完整版, 绝不会留下半截损坏文件让下一步读崩 (#42 半成品清理)。
  tmp <- paste0(canonical_path, ".tmp.", Sys.getpid())
  if (!file.copy(archive_path, tmp, overwrite = TRUE)) {
    stop("save_with_canonical: 复制到临时文件失败: ", archive_path)
  }
  if (!file.rename(tmp, canonical_path)) {
    # rename 失败(极少见, 如跨设备) → 退回直接覆盖并清理临时文件
    file.copy(tmp, canonical_path, overwrite = TRUE)
    unlink(tmp)
  }
}

#' 从 annotate_result.json 同步合并后的 CellType 到 Seurat 对象
#'
#' 前端合并细胞类型后只更新 JSON，不更新 RDS。
#' 此函数检查 JSON 中是否有更新的 CellType 标签，若有则覆盖 pro$CellType。
#' @param pro Seurat 对象（已加载 seurat_annotated.rds）
#' @param project_path 项目目录路径
#' @return 更新后的 Seurat 对象
sync_celltype_from_json <- function(pro, project_path) {
  json_path <- file.path(project_path, "annotate_result.json")
  if (!file.exists(json_path)) return(pro)

  anno <- tryCatch(jsonlite::fromJSON(json_path), error = function(e) NULL)
  if (is.null(anno)) return(pro)

  merged_ct <- anno$scatter_data$celltype
  if (is.null(merged_ct) || length(merged_ct) != ncol(pro)) return(pro)

  pro$CellType <- merged_ct
  pro
}


#* @apiTitle scCloud v2 R 计算引擎
#* @apiDescription 无状态 REST API，封装 Seurat/Bioconductor 分析流程

# ======================================================================
# 健康检查
# ======================================================================

#* 健康检查
#* @get /health
function() {
  list(
    status = "ok",
    r_version = R.version.string,
    seurat = as.character(packageVersion("Seurat"))
  )
}


# ======================================================================
# 文件解析（上传后 inspect）
# ======================================================================

#* 解析上传的 RDS/H5AD 文件，返回维度、基因名和元数据列
#* @post /inspect
function(req) {
  body <- jsonlite::fromJSON(req$postBody)
  file_path <- body$file_path
  filename <- body$filename %||% basename(file_path)

  if (!file.exists(file_path)) stop(paste("文件不存在:", file_path))

  ext <- tolower(tools::file_ext(file_path))

  if (ext %in% c("rds", "h5seurat", "rdata")) {
    # 读取 Seurat 对象
    if (ext == "rds" || ext == "h5seurat") {
      obj <- readRDS(file_path)
    } else {
      # rdata: load 取第一个 Seurat 对象
      env <- new.env(parent = emptyenv())
      load(file_path, envir = env)
      obj_names <- ls(env)
      seurat_names <- Filter(function(n) inherits(env[[n]], "Seurat"), obj_names)
      if (length(seurat_names) == 0) {
        stop("RDATA 文件中未找到 Seurat 对象，请确保文件包含 Seurat 对象或转换为 RDS 格式后重新上传")
      }
      if (length(seurat_names) > 1) {
        stop(sprintf("RDATA 文件包含多个 Seurat 对象（%s），请转换为 RDS 格式后重新上传",
                      paste(seurat_names, collapse = ", ")))
      }
      obj <- env[[seurat_names[1]]]
    }

    # Seurat 对象通用处理 (基因 × 细胞: 行=基因, 列=细胞)
    n_cells <- ncol(obj)
    n_genes <- nrow(obj)
    genes <- rownames(obj)

    gene_ids <- tryCatch({
      if ("ENSEMBL" %in% colnames(obj@meta.data)) {
        as.character(obj@meta.data$ENSEMBL)
      } else if ("ensembl_gene_id" %in% colnames(obj@meta.data)) {
        as.character(obj@meta.data$ensembl_gene_id)
      } else {
        ensembl_pattern <- "^ENS[A-Z]*[0-9]{11}$"
        if (any(grepl(ensembl_pattern, genes))) {
          genes
        } else {
          rep("N/A", length(genes))
        }
      }
    }, error = function(e) {
      rep("N/A", length(genes))
    })

    meta_cols <- colnames(obj@meta.data)

    samples <- list()
    if ("Sample" %in% meta_cols) {
      sample_vals <- as.character(obj@meta.data$Sample)
      for (s in sort(unique(sample_vals))) {
        samples[[length(samples) + 1]] <- list(
          name = jsonlite::unbox(s),
          cell_count = jsonlite::unbox(as.integer(sum(sample_vals == s)))
        )
      }
    }

  } else if (ext == "loom") {
    if (!requireNamespace("reticulate", quietly = TRUE)) {
      stop("缺少 reticulate 包，无法读取 Loom 文件")
    }
    anndata <- reticulate::import("anndata")
    adata <- anndata$read_loom(file_path)

    n_cells <- as.integer(adata$n_obs)
    n_genes <- as.integer(adata$n_vars)
    genes <- as.character(reticulate::py_to_r(adata$var_names$to_list()))

    gene_ids <- tryCatch({
      var_df <- reticulate::py_to_r(adata$var)
      if ("gene_ids" %in% colnames(var_df)) {
        as.character(var_df$gene_ids)
      } else if ("ensembl_id" %in% colnames(var_df)) {
        as.character(var_df$ensembl_id)
      } else {
        rep("N/A", length(genes))
      }
    }, error = function(e) {
      rep("N/A", length(genes))
    })

    # 用 Python 端提取 obs 数据，避免 reticulate 转换 DataFrame view 失败
    py$adata <- adata
    reticulate::py_run_string("
obs_cols = list(adata.obs.columns)
sample_counts = {}
if 'Sample' in adata.obs.columns:
    for s in adata.obs['Sample'].unique():
        sample_counts[s] = int((adata.obs['Sample'] == s).sum())
")
    meta_cols <- as.character(py$obs_cols)

    # 检测样本列表
    samples <- list()
    if (length(py$sample_counts) > 0) {
      for (s in names(py$sample_counts)) {
        samples[[length(samples) + 1]] <- list(
          name = jsonlite::unbox(s),
          cell_count = jsonlite::unbox(as.integer(py$sample_counts[[s]]))
        )
      }
    }

    # 基因 ID 类型推断
    id_type_info <- detect_gene_id_type(genes)
    gene_id_type <- id_type_info$id_type
    ensembl_version <- switch(gene_id_type,
      ensembl = {
        if (id_type_info$species == "mouse") "Ensembl Gene ID (Mouse)"
        else "Ensembl Gene ID (Human)"
      },
      entrez  = "Entrez Gene ID",
      refseq  = "RefSeq ID",
      uniprot = "UniProt ID",
      "symbol"
    )

    conversion_preview <- NULL
    tryCatch({
      id_type_info <- detect_gene_id_type(genes)
      if (id_type_info$id_type != "symbol") {
        sample_ids <- head(genes, 50)
        keytype <- switch(id_type_info$id_type,
          ensembl = "ENSEMBL", entrez = "ENTREZID",
          refseq = "REFSEQ", uniprot = "UNIPROT"
        )
        org_db <- if (id_type_info$species == "mouse") org.Mm.eg.db::org.Mm.eg.db else org.Hs.eg.db::org.Hs.eg.db
        mapped <- AnnotationDbi::select(
          org_db, keys = sub("\\.[0-9]+$", "", sample_ids),
          columns = "SYMBOL", keytype = keytype
        )
        n_mapped <- sum(!is.na(mapped$SYMBOL))
        conversion_preview <- list(
          id_type = jsonlite::unbox(id_type_info$id_type),
          total_sampled = jsonlite::unbox(length(sample_ids)),
          mapped = jsonlite::unbox(n_mapped),
          ratio = jsonlite::unbox(round(n_mapped / length(sample_ids), 2))
        )
      }
    }, error = function(e) {})

    return(list(
      filename = jsonlite::unbox(filename),
      n_cells = jsonlite::unbox(as.integer(n_cells)),
      n_genes = jsonlite::unbox(as.integer(n_genes)),
      # 兼容旧字段: 统一为 n_rows=细胞数, n_cols=基因数 (注意与 Seurat 内部 nrow=基因/ncol=细胞
      # 相反, 此处对齐的是前端"行=细胞/列=基因"显示约定; 新代码请直接用 n_cells/n_genes)
      n_rows = jsonlite::unbox(as.integer(n_cells)),
      n_cols = jsonlite::unbox(as.integer(n_genes)),
      genes = head(genes, 100),
      gene_ids = head(gene_ids, 100),
      file_size_mb = jsonlite::unbox(round(file.size(file_path) / 1024 / 1024, 2)),
      metadata_columns = meta_cols,
      samples = samples,
      ensembl_version = jsonlite::unbox(ensembl_version),
      gene_id_type = jsonlite::unbox(gene_id_type),
      conversion_preview = conversion_preview
    ))

  } else if (ext == "h5ad") {
    if (!requireNamespace("reticulate", quietly = TRUE)) {
      stop("缺少 reticulate 包，无法读取 H5AD 文件")
    }
    anndata <- reticulate::import("anndata")
    adata <- anndata$read_h5ad(file_path)

    n_cells <- as.integer(adata$n_obs)
    n_genes <- as.integer(adata$n_vars)
    genes <- as.character(reticulate::py_to_r(adata$var_names$to_list()))

    gene_ids <- tryCatch({
      var_df <- reticulate::py_to_r(adata$var)
      if ("gene_ids" %in% colnames(var_df)) {
        as.character(var_df$gene_ids)
      } else if ("ensembl_id" %in% colnames(var_df)) {
        as.character(var_df$ensembl_id)
      } else {
        rep("N/A", length(genes))
      }
    }, error = function(e) {
      rep("N/A", length(genes))
    })

    # 用 Python 端提取 obs 数据，避免 reticulate 转换 DataFrame view 失败
    py$adata <- adata
    reticulate::py_run_string("
obs_cols = list(adata.obs.columns)
sample_counts = {}
if 'Sample' in adata.obs.columns:
    for s in adata.obs['Sample'].unique():
        sample_counts[s] = int((adata.obs['Sample'] == s).sum())
")
    meta_cols <- as.character(py$obs_cols)

    # 检测样本列表
    samples <- list()
    if (length(py$sample_counts) > 0) {
      for (s in names(py$sample_counts)) {
        samples[[length(samples) + 1]] <- list(
          name = jsonlite::unbox(s),
          cell_count = jsonlite::unbox(as.integer(py$sample_counts[[s]]))
        )
      }
    }

  } else {
    stop(paste("不支持的文件格式:", ext))
  }

  # 基因 ID 类型推断
  id_type_info <- detect_gene_id_type(genes)
  gene_id_type <- id_type_info$id_type
  ensembl_version <- switch(gene_id_type,
    ensembl = {
      if (id_type_info$species == "mouse") "Ensembl Gene ID (Mouse)"
      else "Ensembl Gene ID (Human)"
    },
    entrez  = "Entrez Gene ID",
    refseq  = "RefSeq ID",
    uniprot = "UniProt ID",
    "symbol"
  )

  # 转换预览：采样测试可映射比例
  conversion_preview <- NULL
  tryCatch({
    id_type_info <- detect_gene_id_type(genes)
    if (id_type_info$id_type != "symbol") {
      sample_ids <- head(genes, 50)
      keytype <- switch(id_type_info$id_type,
        ensembl = "ENSEMBL", entrez = "ENTREZID",
        refseq = "REFSEQ", uniprot = "UNIPROT"
      )
      org_db <- if (id_type_info$species == "mouse") org.Mm.eg.db::org.Mm.eg.db else org.Hs.eg.db::org.Hs.eg.db
      mapped <- AnnotationDbi::select(
        org_db, keys = sub("\\.[0-9]+$", "", sample_ids),
        columns = "SYMBOL", keytype = keytype
      )
      n_mapped <- sum(!is.na(mapped$SYMBOL))
      conversion_preview <- list(
        id_type = jsonlite::unbox(id_type_info$id_type),
        total_sampled = jsonlite::unbox(length(sample_ids)),
        mapped = jsonlite::unbox(n_mapped),
        ratio = jsonlite::unbox(round(n_mapped / length(sample_ids), 2))
      )
    }
  }, error = function(e) {})

  list(
    filename = jsonlite::unbox(filename),
    n_cells = jsonlite::unbox(as.integer(n_cells)),
    n_genes = jsonlite::unbox(as.integer(n_genes)),
    # 兼容旧字段: 统一为 n_rows=细胞数, n_cols=基因数 (注意与 Seurat 内部 nrow=基因/ncol=细胞
    # 相反, 此处对齐的是前端"行=细胞/列=基因"显示约定; 新代码请直接用 n_cells/n_genes)
    n_rows = jsonlite::unbox(as.integer(n_cells)),
    n_cols = jsonlite::unbox(as.integer(n_genes)),
    genes = head(genes, 100),
    gene_ids = head(gene_ids, 100),
    file_size_mb = jsonlite::unbox(round(file.size(file_path) / 1024 / 1024, 2)),
    metadata_columns = meta_cols,
    samples = samples,
    ensembl_version = jsonlite::unbox(ensembl_version),
    gene_id_type = jsonlite::unbox(gene_id_type),
    conversion_preview = conversion_preview
  )
}


# ======================================================================
# 基因列表查询（轻量端点，供前端自动补全）
# ======================================================================

#* 获取 Seurat 对象中所有可用基因名称
#* @post /genes
function(req) {
  body <- jsonlite::fromJSON(req$postBody)
  project_path <- body$project_path

  input_path <- file.path(project_path, "seurat_clustered.rds")
  if (!file.exists(input_path)) {
    stop("请先运行聚类步骤")
  }

  pro <- readRDS(input_path)
  genes <- sort(rownames(GetAssayData(pro, assay = "SCT", layer = "data")))

  # 包含 Ensembl 映射表（如可用），供前端双名搜索
  ensembl_map <- pro@misc$ensembl_symbol_map
  reverse_map <- NULL
  if (!is.null(ensembl_map)) {
    reverse_map <- names(ensembl_map)
    names(reverse_map) <- ensembl_map
  }

  list(
    status = "success",
    genes = genes,
    ensembl_map = if (!is.null(reverse_map)) as.list(reverse_map) else NULL
  )
}


# ======================================================================
# 1. 质控 (QC)
#    调用: data_processing.R::get_mito(), totalMT_result(), get_umi_gene() 等
# ======================================================================

#* 运行质控分析
#* @post /qc
function(req) {
  body <- jsonlite::fromJSON(req$postBody)
  project_path <- body$project_path
  # 前端参数嵌套在 body$params 内部 (由 FastAPI 路由封装)
  params <- body$params
  plot_format <- params$plot_format %||% "png"
  task_id <- params$task_id
  report <- create_progress_reporter(task_id)

  report(5, "加载数据...")

  # 多文件合并模式：前端传入 rds_file_paths 数组
  rds_file_paths <- params$rds_file_paths
  multi_file_merged <- FALSE
  if (!is.null(rds_file_paths) && length(rds_file_paths) > 1) {
    report(8, paste0("合并 ", length(rds_file_paths), " 个文件..."))
    seurat_list <- list()
    sample_names <- character(0)
    for (i in seq_along(rds_file_paths)) {
      fp <- rds_file_paths[[i]]
      if (!file.exists(fp)) stop(paste0("文件不存在: ", fp))
      ext_i <- tolower(tools::file_ext(fp))
      obj <- if (ext_i == "rds") readRDS(fp) else convert_to_rds(fp, ext_i)
      sname <- sub("\\.(rds|h5ad|h5|h5seurat|rdata)$", "", basename(fp), ignore.case = TRUE)
      # 如果文件内没有 Sample 列或只有一个样本，用文件名作 Sample
      if (!"Sample" %in% colnames(obj@meta.data) || length(unique(obj$Sample)) <= 1) {
        obj$Sample <- sname
      }
      seurat_list[[sname]] <- obj
      sample_names <- c(sample_names, sname)
    }
    exp <- merge(seurat_list[[1]], y = seurat_list[-1],
                 add.cell.ids = names(seurat_list),
                 project = "Merged_MultiSample")
    rds_file_path <- rds_file_paths[[1]]  # 用于后续 _groups.json 路径回退
    load_file <- rds_file_paths[[1]]
    multi_file_merged <- TRUE
  }

  # 单文件模式：原有逻辑
  if (!multi_file_merged) {
    # 优先使用前端传入的 rds_file_path（上传后直接指定的路径）
    rds_file_path <- params$rds_file_path
    if (!is.null(rds_file_path) && nchar(rds_file_path) > 0 && file.exists(rds_file_path)) {
      load_file <- rds_file_path
    } else {
      # 退而求其次: 扫描项目目录中的数据文件
      data_files <- list.files(project_path, pattern = "\\.(rds|h5ad|h5|h5seurat|rdata|loom|csv|tsv)$", full.names = TRUE, ignore.case = TRUE)
      if (length(data_files) == 0) stop("项目目录中未找到数据文件，请先上传数据文件")
      load_file <- data_files[1]
    }

    # 自动检测文件格式，非 RDS 文件先转换为 RDS
    ext <- tolower(tools::file_ext(load_file))
    if (ext != "rds") {
      report(8, paste0("检测到 ", ext, " 格式，正在转换为 RDS..."))
      rds_out <- file.path(project_path, paste0("_converted_", basename(load_file), ".rds"))
      if (!file.exists(rds_out)) {
        exp <- convert_to_rds(load_file, ext, rds_out)
        save_with_canonical(rds_out, rds_out, exp)
      }
      exp <- readRDS(rds_out)
    } else {
      exp <- readRDS(load_file)
    }
  }

  # --- 样本分组信息处理 ---
  # 1. 优先从 Pipeline params 中读取分组信息
  sample_groups <- params$sample_groups
  # 2. 其次从上传时保存的 _groups.json 读取
  if (is.null(sample_groups) || length(sample_groups) == 0) {
    groups_json_path <- file.path(dirname(rds_file_path), paste0(basename(rds_file_path), "_groups.json"))
    if (file.exists(groups_json_path)) {
      tryCatch({
        sample_groups <- jsonlite::fromJSON(groups_json_path)
        # 验证：如果所有分组值都和样本名一样，说明没有真正设置分组
        if (!is.null(sample_groups) && length(sample_groups) > 0) {
          sample_names_in_obj <- as.character(exp@meta.data$Sample)
          group_vals <- unname(unlist(sample_groups))
          # 如果所有 group 值都在 sample 名称中，视为未设置分组
          if (all(group_vals %in% sample_names_in_obj) && length(unique(group_vals)) == length(unique(sample_names_in_obj))) {
            sample_groups <- NULL
          }
        }
      }, error = function(e) {
        sample_groups <- NULL
      })
    }
  }
  # 如果 Seurat 对象没有 Sample 列，用细胞名作为默认 Sample
  if (!"Sample" %in% colnames(exp@meta.data)) {
    exp$Sample <- colnames(exp)
  }

  # 3. 如果存在分组信息，写入 Seurat 对象的 meta.data$Group 列
  if (!is.null(sample_groups) && length(sample_groups) > 0 && "Sample" %in% colnames(exp@meta.data)) {
    report(12, "写入样本分组信息...")
    exp$Group <- unname(sapply(as.character(exp@meta.data$Sample), function(s) {
      grp <- sample_groups[[s]]
      if (is.null(grp) || nchar(grp) == 0) "Unknown" else grp
    }))
  }

  # 如果用户没有设置分组，但原始数据自带 Group 列，移除它
  if (is.null(sample_groups) || length(sample_groups) == 0) {
    if ("Group" %in% colnames(exp@meta.data)) {
      exp$Group <- NULL
    }
  }

  # --- 非 Symbol 基因 ID → Gene Symbol 回退转换 ---
  id_info <- detect_gene_id_type(rownames(exp))
  if (id_info$id_type != "symbol") {
    report(15, sprintf("检测到 %s ID，正在转换为基因符号...", toupper(id_info$id_type)))
    exp <- convert_ids_to_symbol(exp, id_type = id_info$id_type, species = id_info$species)
  }

  report(20, "计算线粒体比例...")

  # 添加线粒体百分比
  if (!"percent.mt" %in% colnames(exp@meta.data)) {
    exp[["percent.mt"]] <- PercentageFeatureSet(exp, pattern = "^MT-|^mt-")
  }

  report(35, "生成 QC 统计...")

  # 调用原始函数
  totalMT <- totalMT_result(exp)
  umiGene <- umiGene_result(exp)

  # ---- 生成样本相关性散点图 (my_distPlot1) ----
  report(40, "生成样本相关性图...")
  corr_archive <- make_output_name(project_path, "1", "qc", "correlation", plot_format)
  corr_plot_path <- file.path(project_path, corr_archive)
open_plot_device(corr_plot_path, 1400, 600, plot_format, units = "px")
  print(my_distPlot1(exp))
  dev.off()

  # ---- 提取散点原始数据供前端 WebGL 渲染 ----
  # 注意：Seurat 的 [[ 运算符被重载为访问 assay/slot，
  #       必须通过 @meta.data 访问元数据列。
  md <- exp@meta.data
  corr_scatter_data <- list(
    nCount_RNA  = as.numeric(md$nCount_RNA),
    nFeature_RNA = as.numeric(md$nFeature_RNA),
    percent_mt  = as.numeric(md[["percent.mt"]]),
    sample      = as.character(md$Sample),
    cor_mt      = round(cor(md$nCount_RNA, md[["percent.mt"]]), 2),
    cor_feature = round(cor(md$nCount_RNA, md$nFeature_RNA), 2)
  )

  report(60, "过滤细胞...")

  # 过滤参数 (来自前端，已在上方从 body$params 解包)
  min_features <- params$min_features %||% 200
  max_features <- params$max_features %||% 5000
  max_mt_ratio <- params$max_mt_ratio %||% 20
  umi_min_pct  <- params$umi_min_pct %||% 0
  umi_max_pct  <- params$umi_max_pct %||% 1

  # 计算 nUMI(nCount_RNA) 的分位数截断点
  umi_lower_bound <- quantile(exp$nCount_RNA, probs = umi_min_pct, na.rm = TRUE)
  umi_upper_bound <- quantile(exp$nCount_RNA, probs = umi_max_pct, na.rm = TRUE)

  pro <- subset(
    exp,
    subset = nFeature_RNA >= min_features &
             nFeature_RNA <= max_features &
             percent.mt <= max_mt_ratio &
             nCount_RNA >= umi_lower_bound &
             nCount_RNA <= umi_upper_bound
  )

  # 过滤后统计
  totalMT1 <- totalMT1_result(pro)
  umiGene1 <- umiGene1_result(pro)

  # ---- 生成过滤前后 VlnPlot 对比 (my_distPlot2) ----
  report(70, "生成质控小提琴图...")
  vln_archive <- make_output_name(project_path, "1", "qc", "violin", plot_format)
  vln_plot_path <- file.path(project_path, vln_archive)
open_plot_device(vln_plot_path, 1400, 1000, plot_format, units = "px")
  print(my_distPlot2(exp, pro))
  dev.off()

  report(85, "保存结果...")

  # 确保 data.frame 列名完整（修复 write.csv 列名缺失问题）
  if (ncol(totalMT) > 0) {
    mt_cols <- c("mt<=5%","mt<=10%","mt<=15%","mt<=20%","mt<=30%","mt<=50%","mt<=80%","mt<=100%")
    colnames(totalMT) <- c("Sample", mt_cols[seq_len(min(length(mt_cols), ncol(totalMT)-1))])
  }
  if (ncol(totalMT1) > 0) {
    mt_cols <- c("mt<=5%","mt<=10%","mt<=15%","mt<=20%","mt<=30%","mt<=50%","mt<=80%","mt<=100%")
    colnames(totalMT1) <- c("Sample", mt_cols[seq_len(min(length(mt_cols), ncol(totalMT1)-1))])
  }
  if (ncol(umiGene) > 0) {
    ug_cols <- c("umisMax","umisMed","umisMin","genesMax","genesMed","genesMin")
    colnames(umiGene) <- c("Sample", ug_cols[seq_len(min(length(ug_cols), ncol(umiGene)-1))])
  }
  if (ncol(umiGene1) > 0) {
    ug_cols <- c("umisMax","umisMed","umisMin","genesMax","genesMed","genesMin")
    colnames(umiGene1) <- c("Sample", ug_cols[seq_len(min(length(ug_cols), ncol(umiGene1)-1))])
  }

  # 双命名：归档名 + 管道链名
  rds_archive <- make_output_name(project_path, "1", "qc", "filtered", "rds")
  archive_path <- file.path(project_path, rds_archive)
  canonical_path <- file.path(project_path, "seurat_qc.rds")
  save_with_canonical(archive_path, canonical_path, pro)

  # 保存 QC 统计 CSV（归档名）
  mito_csv_archive <- make_output_name(project_path, "1", "qc", "mito_stats", "csv")
  mito_csv_path <- file.path(project_path, mito_csv_archive)
  write.csv(rbind(
    data.frame(stage = "before", totalMT, check.names = FALSE),
    data.frame(stage = "after", totalMT1, check.names = FALSE)
  ), mito_csv_path, row.names = FALSE)

  umi_csv_archive <- make_output_name(project_path, "1", "qc", "umi_gene_stats", "csv")
  umi_csv_path <- file.path(project_path, umi_csv_archive)
  write.csv(rbind(
    data.frame(stage = "before", umiGene, check.names = FALSE),
    data.frame(stage = "after", umiGene1, check.names = FALSE)
  ), umi_csv_path, row.names = FALSE)

  report(100, "质控完成")

  list(
    status = "success",
    result_path = archive_path,
    stats = list(
      total_cells_before = ncol(exp),
      total_cells_after = ncol(pro),
      total_genes = nrow(pro),
      samples = length(unique(pro@meta.data$Sample))
    ),
    mito_table_before = totalMT,
    mito_table_after = totalMT1,
    umi_gene_before = umiGene,
    umi_gene_after = umiGene1,
    corr_plot_path = corr_plot_path,
    corr_scatter_data = corr_scatter_data,
    violin_plot_path = vln_plot_path,
    mito_csv_path = mito_csv_path,
    umi_csv_path = umi_csv_path
  )
}


# ======================================================================
# 2. 标准化
#    调用: data_summary.R::RunSCT()
# ======================================================================

#* SCTransform 标准化
#* @post /normalize
function(req) {
  body <- jsonlite::fromJSON(req$postBody)
  project_path <- body$project_path
  params <- body$params
  plot_format <- params$plot_format %||% "png"
  task_id <- params$task_id
  report <- create_progress_reporter(task_id)

  report(5, "加载 QC 后数据...")

  input_path <- file.path(project_path, "seurat_qc.rds")
  if (!file.exists(input_path)) stop("请先运行质控步骤")
  pro <- readRDS(input_path)

  report(20, "运行 SCTransform 标准化...")

  # 调用原始函数 — data_summary.R::RunSCT()
  pro <- RunSCT(pro)

  report(80, "保存标准化结果...")

  # 双命名：归档名 + 管道链名
  rds_archive <- make_output_name(project_path, "2", "normalize", "SCT", "rds")
  archive_path <- file.path(project_path, rds_archive)
  canonical_path <- file.path(project_path, "seurat_normalized.rds")
  save_with_canonical(archive_path, canonical_path, pro)

  report(90, "提取 meta.data 样本...")

  # 提取前 100 行 meta.data 供前端表格展示
  meta_sample <- head(pro@meta.data, 100)
  meta_sample$barcode <- rownames(meta_sample)
  # 将 barcode 移到第一列
  meta_sample <- meta_sample[, c("barcode", setdiff(colnames(meta_sample), "barcode"))]

  report(100, "标准化完成")

  list(
    status = "success",
    result_path = archive_path,
    input_file = "seurat_qc.rds",
    stats = list(
      cells = ncol(pro),
      genes = nrow(pro),
      assays = names(pro@assays)
    ),
    meta_data_sample = meta_sample,
    meta_data_total_rows = nrow(pro@meta.data)
  )
}


# ======================================================================
# 3. 降维
#    调用: data_plot.R::my_distPlot3()
# ======================================================================

#* PCA/UMAP/tSNE 降维
#* @post /reduce
function(req) {
  body <- jsonlite::fromJSON(req$postBody)
  project_path <- body$project_path
  params <- body$params
  plot_format <- params$plot_format %||% "png"
  task_id <- params$task_id
  report <- create_progress_reporter(task_id)

  report(5, "加载标准化数据...")

  input_path <- file.path(project_path, "seurat_normalized.rds")
  if (!file.exists(input_path)) stop("请先运行标准化步骤")
  pro <- readRDS(input_path)

  method <- params$method %||% "umap"
  n_dims <- params$n_dims %||% 30
  group_by <- params$group_by %||% "Sample"

  report(30, paste0("运行降维 (", method, ")..."))

  # 执行降维 — 逻辑与 data_plot.R::my_distPlot3() 一致
  pro <- RunPCA(object = pro, verbose = FALSE)

  if (method == "umap") {
    pro <- RunUMAP(object = pro, reduction = "pca", dims = 1:n_dims, verbose = FALSE)
  } else if (method == "tsne") {
    pro <- RunTSNE(object = pro, reduction = "pca", dims = 1:n_dims, perplexity = 30, verbose = FALSE)
  }

  report(70, "生成降维图...")

  # 双命名：归档名 + 管道链名
  plot_archive <- make_output_name(project_path, "3", "reduce", method, plot_format)
  plot_path <- file.path(project_path, plot_archive)
open_plot_device(plot_path, 1200, 800, plot_format, units = "px")
  my_distPlot3(pro, method, group_by, n_dims)
  dev.off()

  report(85, "保存数据...")

  rds_archive <- make_output_name(project_path, "3", "reduce", method, "rds")
  archive_path <- file.path(project_path, rds_archive)
  canonical_path <- file.path(project_path, "seurat_reduced.rds")
  save_with_canonical(archive_path, canonical_path, pro)

  report(100, "降维完成")

  # 提取降维坐标供前端渲染
  reduction_key <- if (method == "umap") "umap" else "tsne"
  embeddings <- Embeddings(pro, reduction = reduction_key)
  md <- pro@meta.data
  scatter_data <- list(
    x       = as.numeric(embeddings[, 1]),
    y       = as.numeric(embeddings[, 2]),
    cluster  = as.character(md[[group_by]]),
    celltype = if ("CellType" %in% colnames(md)) as.character(md$CellType) else NULL,
    sample   = as.character(md$Sample %||% "unknown"),
    group    = if ("Group" %in% colnames(md)) as.character(md$Group) else NULL
  )

  list(
    status = "success",
    result_path = archive_path,
    plot_path = plot_path,
    stats = list(
      cells = ncol(pro),
      method = method,
      n_dims = n_dims,
      reductions = names(pro@reductions)
    ),
    scatter_data = scatter_data
  )
}


# ======================================================================
# 4. 批次聚类
#    调用: data_summary.R::runHarmony(), RenameIdents2()
# ======================================================================

#* Harmony 批次校正 + 聚类
#* @post /cluster
function(req) {
  body <- jsonlite::fromJSON(req$postBody)
  project_path <- body$project_path
  params <- body$params
  plot_format <- params$plot_format %||% "png"
  task_id <- params$task_id
  report <- create_progress_reporter(task_id)

  report(5, "加载标准化数据...")

  input_path <- file.path(project_path, "seurat_normalized.rds")
  if (!file.exists(input_path)) stop("请先运行标准化步骤")
  pro <- readRDS(input_path)

  n_dims <- params$n_dims %||% 30
  resolution <- params$resolution %||% 0.5
  group_by <- params$group_by %||% "Sample"

  # 如果分组变量不存在或只有 1 个水平，Harmony 会失败，回退到 Sample
  if (!(group_by %in% colnames(pro@meta.data))) {
    report(18, paste0(group_by, " 列不存在于 metadata 中，回退为 Sample"))
    group_by <- "Sample"
  } else {
    n_levels <- length(unique(pro@meta.data[[group_by]]))
    if (n_levels < 2) {
      report(18, paste0(group_by, " 只有 ", n_levels, " 个分组，回退为 Sample"))
      group_by <- "Sample"
    }
  }

  report(20, "运行 Harmony 批次校正 + 聚类...")

  # 调用原始函数 — data_summary.R::runHarmony()
  pro <- runHarmony(pro, "harmony", group_by, n_dims, resolution)

  report(70, "生成聚类图...")

  # 双命名：归档名（3张图）
  umap_archive <- make_output_name(project_path, "4", "cluster", "umap", plot_format)
  plot_path <- file.path(project_path, umap_archive)
open_plot_device(plot_path, 1200, 800, plot_format, units = "px")
  print(my_distPlot5(pro))
  dev.off()

  sankey_archive <- make_output_name(project_path, "4", "cluster", "sankey", plot_format)
  plot_path2 <- file.path(project_path, sankey_archive)
open_plot_device(plot_path2, 1200, 1000, plot_format, units = "px")
  print(my_distPlot4(pro@meta.data))
  dev.off()

  group_archive <- make_output_name(project_path, "4", "cluster", "group_umap", plot_format)
  plot_path3 <- file.path(project_path, group_archive)
open_plot_device(plot_path3, 1400, 1200, plot_format, units = "px")
  print(my_distPlot6(pro, group_by))
  dev.off()

  report(85, "保存数据...")

  # 双命名：RDS
  rds_archive <- make_output_name(project_path, "4", "cluster", "harmony", "rds")
  archive_path <- file.path(project_path, rds_archive)
  canonical_path <- file.path(project_path, "seurat_clustered.rds")
  save_with_canonical(archive_path, canonical_path, pro)

  # 调用原始函数生成统计
  cluster_num <- my_cluster_num1(pro@meta.data)
  freq_table  <- my_freqTable(pro@meta.data)

  # 保存聚类统计和频率表为 CSV 文件（供打包下载）
  cluster_csv <- file.path(project_path, make_output_name(project_path, "2", "cluster", "cluster_num", "csv"))
  freq_csv    <- file.path(project_path, make_output_name(project_path, "2", "cluster", "freq_table", "csv"))
  write.csv(cluster_num, cluster_csv, row.names = FALSE)
  write.csv(freq_table,  freq_csv,    row.names = FALSE)

  # 提取前 100 行 meta.data 供前端表格展示
  meta_sample <- head(pro@meta.data, 100)
  meta_sample$barcode <- rownames(meta_sample)
  meta_sample <- meta_sample[, c("barcode", setdiff(colnames(meta_sample), "barcode"))]

  report(100, "聚类完成")

  # 提取 UMAP 坐标供前端渲染 (聚类标签着色)
  embeddings <- tryCatch(
    Embeddings(pro, reduction = "harmony.umap"),
    error = function(e) tryCatch(
      Embeddings(pro, reduction = "umap"),
      error = function(e2) NULL
    )
  )
  scatter_data <- if (!is.null(embeddings)) {
    md <- pro@meta.data
    list(
      x         = as.numeric(embeddings[, 1]),
      y         = as.numeric(embeddings[, 2]),
      cluster   = as.character(Idents(pro)),
      celltype  = as.character(Idents(pro)),
      sample    = as.character(md$Sample %||% "unknown"),
      group     = if ("Group" %in% colnames(md)) as.character(md$Group) else NULL
    )
  } else NULL

  list(
    status = "success",
    result_path = archive_path,
    plot_path = plot_path,
    plot_path2 = plot_path2,
    plot_path3 = plot_path3,
    stats = list(
      cells = ncol(pro),
      clusters = length(levels(Idents(pro))),
      cluster_levels = levels(Idents(pro))
    ),
    cluster_num  = cluster_num,
    freq_table   = freq_table,
    scatter_data = scatter_data,
    meta_data_sample = meta_sample,
    meta_data_total_rows = nrow(pro@meta.data)
  )
}


#* 导出聚类结果的 meta.data 为 CSV
#* @post /meta_csv
function(req) {
  body <- jsonlite::fromJSON(req$postBody)
  project_path <- body$project_path

  input_path <- file.path(project_path, "seurat_clustered.rds")
  if (!file.exists(input_path)) stop("请先运行聚类步骤")
  csv_path <- file.path(project_path, "meta_data.csv")

  # 复用缓存: 已生成且不比 seurat_clustered.rds 旧, 就不重复 readRDS 整个对象。
  # (大数据集 rds 上 G, 仅为取 meta.data 而整读非常慢, 是下载超时的根因; 缓存后重复下载秒回。)
  cached <- file.exists(csv_path) &&
    file.info(csv_path)$mtime >= file.info(input_path)$mtime
  if (!cached) {
    pro <- readRDS(input_path)
    # 原子写: 临时文件 + rename, 防并发/双击下半成品 csv(与 save_with_canonical 一致)
    tmp_path <- paste0(csv_path, ".tmp.", Sys.getpid())
    write.csv(pro@meta.data, tmp_path, row.names = TRUE)
    file.rename(tmp_path, csv_path)
  }
  list(
    status = "success",
    csv_path = csv_path
  )
}


# ======================================================================
# 5. 差异基因
#    调用: data_summary.R::my_diffTable(), my_diffTable2()
# ======================================================================

#* FindMarkers 差异基因分析
#* @post /markers
function(req) {
  body <- jsonlite::fromJSON(req$postBody)
  project_path <- body$project_path
  params <- body$params
  plot_format <- params$plot_format %||% "png"
  task_id <- params$task_id
  report <- create_progress_reporter(task_id)

  report(5, "加载聚类数据...")

  group_by <- params$group_by %||% "Cluster"

  if (group_by == "CellType") {
    input_path <- file.path(project_path, "seurat_annotated.rds")
    if (!file.exists(input_path)) stop("请先运行细胞注释步骤")
    pro <- readRDS(input_path)
    pro <- sync_celltype_from_json(pro, project_path)
    Idents(pro) <- pro$CellType
  } else if (group_by == "Group") {
    input_path <- file.path(project_path, "seurat_clustered.rds")
    if (!file.exists(input_path)) stop("请先运行聚类步骤")
    pro <- readRDS(input_path)
    if (!"Group" %in% colnames(pro@meta.data)) {
      stop("Seurat 对象缺少 Group 列，请先在上传时设置样本分组")
    }
    Idents(pro) <- pro$Group
  } else {
    input_path <- file.path(project_path, "seurat_clustered.rds")
    if (!file.exists(input_path)) stop("请先运行聚类步骤")
    pro <- readRDS(input_path)
  }

  cluster_raw <- params$cluster %||% "All"
  # 前端多选时传逗号分隔字符串（如 "0,1,3"），需拆分为向量
  if (is.character(cluster_raw) && length(cluster_raw) == 1 && grepl(",", cluster_raw)) {
    cluster <- trimws(unlist(strsplit(cluster_raw, ",")))
  } else {
    cluster <- cluster_raw
  }
  min_pct <- params$min_pct %||% 0.25
  logfc <- params$logfc_threshold %||% 0.25
  test_use <- params$test_use %||% "wilcox"
  only_pos <- params$only_pos %||% TRUE
  p_adj_cutoff <- params$p_val_adj %||% 0.05

  cluster_label <- if (length(cluster) == 1 && cluster == "All") "All" else paste(cluster, collapse = ", ")
  report(30, paste0("运行差异分析 (", cluster_label, ")..."))

  # PrepSCTFindMarkers 修复多模型 library size 不一致
  pro <- PrepSCTFindMarkers(pro)

  # 调用原始函数 — data_summary.R::my_diffTable()
  diffTable <- my_diffTable(pro, cluster, min_pct, logfc, test_use, only_pos)

  # 当 group_by == "CellType" 时，Cluster 列实际是细胞类型名
  # 将其拆分为 Cluster（原始聚类编号，逗号分隔）+ CellType（合并后的细胞类型）
  if (group_by == "CellType") {
    md <- pro@meta.data
    # 一个 cell type 可能对应多个 cluster（合并后），用逗号拼接
    ct2cl <- list()
    for (cl in unique(as.character(md$Cluster))) {
      ct <- as.character(md[md$Cluster == cl, "CellType"][1])
      ct2cl[[ct]] <- c(ct2cl[[ct]], cl)
    }
    diffTable$CellType <- diffTable$Cluster
    diffTable$Cluster <- sapply(diffTable$CellType, function(ct) {
      cls <- ct2cl[[ct]]
      if (is.null(cls)) ct else paste(sort(cls), collapse = ",")
    })
  }

  # 按 p_val_adj 阈值过滤
  diffTable <- diffTable[diffTable$p_val_adj < p_adj_cutoff, ]

  report(70, "生成 DotPlot...")

  # 双命名：DotPlot
  ntop <- params$ntop %||% 5
  dotplot_archive <- make_output_name(project_path, "5", "markers", "dotplot", plot_format)
  plot_path <- file.path(project_path, dotplot_archive)
open_plot_device(plot_path, 1600, 800, plot_format, units = "px")
  print(my_distPlot7(pro, min_pct, logfc, test_use, only_pos, ntop, cluster))
  dev.off()

  report(80, "生成 Heatmap...")

  # 双命名：Heatmap
  heatmap_archive <- make_output_name(project_path, "5", "markers", "heatmap", plot_format)
  heatmap_path <- file.path(project_path, heatmap_archive)
  tryCatch({
    heatmap_plot <- my_distPlot8(pro, min_pct, logfc, test_use, only_pos, ntop, cluster)
    n_clusters <- length(levels(pro))
    heatmap_h <- max(800, 120 * n_clusters)
  open_plot_device(heatmap_path, 1600, heatmap_h, plot_format, units = "px")
    print(heatmap_plot)
    dev.off()
  }, error = function(e) {
    message("Heatmap generation failed: ", e$message)
  })

  report(85, "保存结果...")

  # 双命名：CSV
  csv_archive <- make_output_name(project_path, "5", "markers", "diff_genes", "csv")
  output_csv <- file.path(project_path, csv_archive)
  write.csv(diffTable, output_csv, row.names = FALSE)
  # 管道链名（enrich 步骤需要读取此固定名）
  file.copy(output_csv, file.path(project_path, "diff_genes.csv"), overwrite = TRUE)

  report(100, "差异分析完成")

  gc(verbose = FALSE)
  list(
    status = "success",
    result_path = output_csv,
    plot_path = plot_path,
    heatmap_path = heatmap_path,
    stats = list(
      total_deg = nrow(diffTable),
      clusters_analyzed = ifelse(cluster_label == "All", "所有聚类", cluster_label),
      group_by = group_by
    ),
    cluster_labels = paste(levels(Idents(pro)), collapse = ","),
    top_genes = head(diffTable, 20)
  )
}


# ======================================================================
# 6. 通路富集
#    调用: data_plot.R::my_distPlot10()
# ======================================================================

#* GO/KEGG/GSEA 富集分析
#* @post /enrich
function(req) {
  body <- jsonlite::fromJSON(req$postBody)
  project_path <- body$project_path
  params <- body$params
  plot_format <- params$plot_format %||% "png"
  task_id <- params$task_id
  report <- create_progress_reporter(task_id)

  report(5, "加载差异基因...")

  # 读取差异基因表
  deg_path <- file.path(project_path, "diff_genes.csv")
  if (!file.exists(deg_path)) stop("请先运行差异基因分析")
  sigDegs <- read.csv(deg_path)

  pathway <- params$pathway %||% "GO"
  direction <- params$direction %||% "Up"
  p_adjust <- params$p_adjust_method %||% "BH"
  pvalue <- params$pvalue_cutoff %||% 0.05
  qvalue <- params$qvalue_cutoff %||% 0.2
  n_term <- params$n_term %||% 10

  report(30, paste0("运行 ", pathway, " 富集分析 (", direction, ")..."))

  # 调用原始函数 — data_plot.R::my_distPlot10()
  result <- my_distPlot10(sigDegs, pathway, direction, p_adjust, pvalue, qvalue, n_term)

  report(80, "保存结果...")

  # 保存图 — 高度根据 term 数量和分析类型动态计算
  if (pathway == "GO") {
    n_rows <- n_term * 3  # BP/CC/MF 三组
    calc_h <- max(1200, n_rows * 55 + 200)
    calc_w <- 2000
  } else if (pathway == "GSEA") {
    # GSEA 是多面板 gseaplot2 网格，每行 2 图，每图约 500px 高
    n_panels <- min(n_term, nrow(result$data))
    n_grid_rows <- ceiling(n_panels / 2)
    calc_h <- max(1200, n_grid_rows * 500 + 100)
    calc_w <- 1800
  } else {
    n_rows <- n_term
    calc_h <- max(1200, n_rows * 55 + 200)
    calc_w <- 2000
  }
  # GSEA 不分上/下调，文件名不带方向；GO/KEGG 才带 Up/Down
  name_tag <- if (identical(pathway, "GSEA")) pathway else paste0(pathway, "_", direction)
  plot_archive <- make_output_name(project_path, "6", "enrich", name_tag, plot_format)
  plot_path <- file.path(project_path, plot_archive)

  # 防止 R 在不可写目录尝试创建 Rplots.pdf（gseaplot2/cowplot 内部触发）
  old_wd <- getwd()
  on.exit(setwd(old_wd), add = TRUE)
  setwd(tempdir())

  open_plot_device(plot_path, calc_w, calc_h, plot_format, units = "px")
  # GSEA 的 create_gsea_plots 返回 grob (gridExtra::grid.arrange)
  # GO/KEGG 返回 ggplot — 需要不同的输出方式
  tryCatch({
    if (inherits(result$plot, "grob") || inherits(result$plot, "gtable")) {
      grid::grid.draw(result$plot)
    } else {
      print(result$plot)
    }
  }, error = function(e) {
    message(paste("Plot draw error:", e$message))
  })
  dev.off()

  # 双命名：CSV —— 从图名派生(共用同一时间戳)，避免渲染耗时使两次 make_output_name 时间戳不一致，
  # 导致前端按图名推导 CSV 名(.png→.csv)时 404
  csv_archive <- sub(paste0("\\.", plot_format, "$"), ".csv", plot_archive)
  table_path <- file.path(project_path, csv_archive)
  if (nrow(result$data) > 0) {
    write.csv(result$data, table_path, row.names = FALSE)
  }

  report(100, "富集分析完成")

  # 整理富集数据供前端渲染（GSEA 使用 NES，GO/KEGG 使用 GeneRatio）
  enrich_data <- if (nrow(result$data) > 0) {
    df <- head(result$data, n_term)
    if (pathway == "GSEA") {
      list(
        terms    = as.character(df$Description),
        NES      = as.numeric(df$NES),
        p_adjust = as.numeric(df$p.adjust),
        size     = as.integer(df$setSize)
      )
    } else {
      list(
        terms      = as.character(df$Description),
        gene_ratio = as.numeric(sub(".*/", "", df$GeneRatio)) /
                     as.numeric(sub(".+/",  "", df$GeneRatio)),
        p_adjust   = as.numeric(df$p.adjust),
        count      = as.integer(df$Count)
      )
    }
  } else NULL

  gc(verbose = FALSE)
  list(
    status = "success",
    plot_path = plot_path,
    result_path = table_path,
    stats = Filter(Negate(is.null), list(
      pathway = pathway,
      direction = if (pathway == "GSEA") NULL else direction,
      significant_terms = nrow(result$data)
    )),
    enrich_data = enrich_data
  )
}


# ======================================================================
# 7. Marker 表达可视化
#    调用: data_plot.R::my_distPlot9(), my_distPlot11()
# ======================================================================

#* Marker 基因 FeaturePlot + VlnPlot（分别保存两张图）
#* @post /plot_markers
function(req) {
  body <- jsonlite::fromJSON(req$postBody)
  project_path <- body$project_path
  params <- body$params
  plot_format <- params$plot_format %||% "png"
  task_id <- params$task_id
  report <- create_progress_reporter(task_id)

  report(5, "加载聚类数据...")

  group_by <- params$group_by %||% "Cluster"

  if (group_by == "CellType") {
    input_path <- file.path(project_path, "seurat_annotated.rds")
    if (!file.exists(input_path)) stop("请先运行细胞注释步骤")
    pro <- readRDS(input_path)
    Idents(pro) <- pro$CellType
  } else {
    input_path <- file.path(project_path, "seurat_clustered.rds")
    if (!file.exists(input_path)) stop("请先运行聚类步骤")
    pro <- readRDS(input_path)
  }

  cluster_raw <- params$cluster %||% "C1"
  # 前端多选时传逗号分隔字符串（如 "C1,C3"），需拆分为向量
  if (is.character(cluster_raw) && length(cluster_raw) == 1 && grepl(",", cluster_raw)) {
    clusters <- trimws(unlist(strsplit(cluster_raw, ",")))
  } else {
    clusters <- cluster_raw
  }
  min_pct <- params$min_pct %||% 0.25
  logfc <- params$logfc_threshold %||% 0.25
  test_use <- params$test_use %||% "wilcox"
  only_pos <- params$only_pos %||% TRUE
  ntop <- params$ntop %||% 8

  # 解析用户自定义关注基因（逗号分隔字符串）
  custom_genes_raw <- params$custom_genes %||% NULL
  custom_genes <- NULL
  if (!is.null(custom_genes_raw) && nchar(custom_genes_raw) > 0) {
    custom_genes <- trimws(unlist(strsplit(custom_genes_raw, ",")))
    custom_genes <- custom_genes[nchar(custom_genes) > 0]
  }

  # 计算图片高度（基于基因数量，含自定义基因）
  n_custom <- if (!is.null(custom_genes)) length(custom_genes) else 0
  n_genes <- min(ntop, 8) + n_custom
  calc_height <- max(800, ceiling(n_genes / 2) * 400)

  plot_paths <- list()
  total <- length(clusters)

  for (idx in seq_along(clusters)) {
    cl <- clusters[idx]
    pct <- 10 + floor(80 * (idx - 1) / total)
    report(pct, paste0("生成 ", cl, " 的 Marker 表达图 (", idx, "/", total, ")..."))

    result <- my_distPlot9(pro, cl, min_pct, logfc, test_use, only_pos, ntop, custom_genes)

    # FeaturePlot
    feature_archive <- make_output_name(project_path, "7", "plot_markers", paste0("feature_", cl), plot_format)
    plot_path_feature <- file.path(project_path, feature_archive)
  open_plot_device(plot_path_feature, 1600, calc_height, plot_format, units = "px")
    print(result$feature)
    dev.off()
    # 创建固定名称副本，供前端用 canonical name 访问
    file.copy(plot_path_feature, file.path(project_path, paste0("plot_markers_feature_", cl, ".", plot_format)), overwrite = TRUE)

    # VlnPlot
    vln_archive <- make_output_name(project_path, "7", "plot_markers", paste0("vln_", cl), plot_format)
    plot_path_vln <- file.path(project_path, vln_archive)
  open_plot_device(plot_path_vln, 1600, calc_height, plot_format, units = "px")
    print(result$vln)
    dev.off()
    file.copy(plot_path_vln, file.path(project_path, paste0("plot_markers_vln_", cl, ".", plot_format)), overwrite = TRUE)

    plot_paths[[cl]] <- list(feature = plot_path_feature, vln = plot_path_vln)
  }

  report(100, "Marker 表达图生成完成")

  list(
    status = "success",
    clusters = clusters,
    plot_paths = plot_paths,
    stats = list(clusters = paste(clusters, collapse = ", "), ntop = ntop)
  )
}


# ======================================================================
# 7b. 基因表达 UMAP 散点数据（供前端 WebGl 渲染）
# ======================================================================

#* 获取单个基因的 per-cell 表达值 + UMAP 坐标
#* @param project_path 项目目录完整路径
#* @param gene 基因符号
#* @get /gene_expression
function(project_path, gene, celltype = NULL) {
  rds_path <- file.path(project_path, "seurat_annotated.rds")
  if (!file.exists(rds_path)) {
    rds_path <- file.path(project_path, "seurat_clustered.rds")
  }
  if (!file.exists(rds_path)) return(list(error = "RDS not found"))

  pro <- readRDS(rds_path)

  # 选择 assay
  assay <- if ("SCT" %in% Seurat::Assays(pro)) "SCT" else "RNA"

  # 检查基因是否存在（支持 Ensembl ID ↔ Symbol 双向查找）
  assay_data <- Seurat::GetAssayData(pro, assay = assay, layer = "data")
  resolved_gene <- lookup_gene_symbol(gene, pro)
  if (is.null(resolved_gene)) {
    return(list(error = paste0("基因 ", gene, " 在表达矩阵中未检出")))
  }
  gene <- resolved_gene

  # 获取表达值
  expr <- as.numeric(Seurat::FetchData(pro, vars = gene, assay = assay)[[1]])

  # 获取 UMAP 坐标
  umap <- tryCatch(
    Seurat::Embeddings(pro, reduction = "harmony.umap"),
    error = function(e) tryCatch(
      Seurat::Embeddings(pro, reduction = "umap"),
      error = function(e2) NULL
    )
  )
  if (is.null(umap)) return(list(error = "No UMAP embedding found"))

  # 按 CellType 计算表达比例
  md <- pro@meta.data
  ct_col <- if ("CellType" %in% colnames(md)) "CellType" else "seurat_clusters"
  celltypes <- as.character(md[[ct_col]])
  unique_cts <- sort(unique(celltypes))

  # 各细胞类型中表达 > 0 的比例
  ct_stats <- list()
  for (ct in unique_cts) {
    idx <- which(celltypes == ct)
    ct_expr <- expr[idx]
    n_total <- length(idx)
    n_expressed <- sum(ct_expr > 0)
    ct_stats[[ct]] <- list(
      n_cells = jsonlite::unbox(n_total),
      n_expressed = jsonlite::unbox(n_expressed),
      pct_expressed = jsonlite::unbox(round(n_expressed / n_total * 100, 1)),
      mean_expr = jsonlite::unbox(round(mean(ct_expr), 3))
    )
  }

  list(
    x = as.numeric(umap[, 1]),
    y = as.numeric(umap[, 2]),
    expression = expr,
    gene = jsonlite::unbox(gene),
    min_expr = jsonlite::unbox(min(expr)),
    max_expr = jsonlite::unbox(max(expr)),
    celltype_stats = ct_stats,
    current_celltype = jsonlite::unbox(celltype)
  )
}


# ======================================================================
# 7c. Marker 基因表达可视化 (v1 Step 7 完整移植)
#     用户上传 marker.txt → 解析 CellType 列表 → 选择后调用 my_distPlot11()
#     调用: data_plot.R::my_distPlot11()
# ======================================================================

#* Marker 基因表达 — 解析 marker 文件 + 生成 FeaturePlot/VlnPlot
#* @post /marker_expr
function(req) {
  body <- jsonlite::fromJSON(req$postBody)
  project_path <- body$project_path
  params <- body$params
  plot_format <- params$plot_format %||% "png"
  task_id <- params$task_id
  report <- create_progress_reporter(task_id)

  report(5, "加载聚类数据...")

  # ── 加载聚类后 RDS ──
  input_path <- file.path(project_path, "seurat_clustered.rds")
  if (!file.exists(input_path)) stop("请先运行聚类步骤")
  pro <- readRDS(input_path)

  report(15, "读取 Marker 基因文件...")

  # ── 读取 marker 文件 ──
  marker_file <- params$marker_file_path %||% NULL
  if (is.null(marker_file) || !file.exists(marker_file)) {
    stop("未找到 Marker 基因文件，请先上传 marker.txt")
  }

  mkfs <- read.delim(marker_file, header = TRUE, sep = "\t",
                     check.names = FALSE, stringsAsFactors = FALSE,
                     row.names = 1)

  # 提取所有 cell types
  cell_types <- sort(unique(rownames(mkfs)))

  # 构建 marker 表格数据（前端表格展示用）
  marker_table <- data.frame(
    CellType = rownames(mkfs),
    Markers = as.character(mkfs[, 1]),
    stringsAsFactors = FALSE
  )

  report(25, paste0("解析完成，共 ", length(cell_types), " 种细胞类型"))

  # ── 判断是否需要生成图（Phase B）──
  cell_type <- params$cell_type %||% NULL

  if (is.null(cell_type) || nchar(trimws(cell_type)) == 0) {
    # Phase A：只解析文件，返回 cell_types 列表
    report(100, "Marker 文件解析完成")

    result_data <- list(
      status = "success",
      phase = "parse",
      cell_types = cell_types,
      marker_table = marker_table,
      stats = list(
        n_cell_types = length(cell_types),
        n_total_markers = sum(sapply(mkfs[, 1], function(x) {
          length(strsplit(x, "[\\t, ]+")[[1]])
        }))
      )
    )

    result_path <- file.path(project_path, "marker_expr_result.json")
    jsonlite::write_json(result_data, result_path, auto_unbox = TRUE)

    return(result_data)
  }

  # Phase B：生成指定 cell_type 的表达图
  if (!(cell_type %in% cell_types)) {
    stop(paste0("选择的细胞类型 '", cell_type, "' 不在 marker 文件中"))
  }

  report(35, paste0("生成 ", cell_type, " 的 Marker 表达图..."))

  tryCatch({
    out_dir <- file.path(project_path, "7.marker")
    if (!dir.exists(out_dir)) dir.create(out_dir, recursive = TRUE)

    # 计算有效 marker 基因数以确定图片高度
    marker_genes_raw <- strsplit(mkfs[cell_type, 1], "[\\t, ]+")[[1]]
    marker_genes_raw <- marker_genes_raw[marker_genes_raw != ""]
    allgenes <- rownames(GetAssayData(pro, assay = "SCT", layer = "data"))
    if (all(sapply(allgenes, is_upper_strict))) {
      n_markers <- length(intersect(marker_genes_raw, allgenes))
    } else {
      n_markers <- length(allgenes[toupper(allgenes) %in% toupper(marker_genes_raw)])
    }
    n_col <- max(1, min(n_markers, 4))
    n_rows <- ceiling(n_markers / n_col)       # 每种图的行数
    calc_width  <- n_col * 400 + 100           # 每列 400px + 图例空间
    calc_height <- if (n_markers == 0) 300 else max(800, n_rows * 2 * 400)  # FeaturePlot + VlnPlot 各占 400px/行

    report(50, paste0("找到 ", n_markers, " 个有效 marker 基因，绘图中..."))

    # 生成组合图 (FeaturePlot / VlnPlot patchwork)
    plot_name <- paste0("plot_marker_expr_",
                        gsub("[^a-zA-Z0-9_]", "_", cell_type), ".", plot_format)
    plot_path <- file.path(project_path, plot_name)

  open_plot_device(plot_path, calc_width, calc_height, plot_format, units = "px")
    print(my_distPlot11(pro, mkfs, cell_type))
    dev.off()

    report(90, "图片生成完成")

    # 归档副本
    archive_name <- make_output_name(project_path, "7", "marker_expr",
                                     cell_type, plot_format)
    archive_path <- file.path(project_path, archive_name)
    file.copy(plot_path, archive_path, overwrite = TRUE)

    result_data <- list(
      status = "success",
      phase = "plot",
      cell_type = cell_type,
      cell_types = cell_types,
      marker_table = marker_table,
      plot_path = plot_name,
      archive_name = archive_name,
      n_markers = n_markers,
      stats = list(
        cell_type = cell_type,
        n_markers = n_markers,
        n_cell_types = length(cell_types)
      )
    )

    result_path <- file.path(project_path, "marker_expr_result.json")
    jsonlite::write_json(result_data, result_path, auto_unbox = TRUE)

    report(100, paste0(cell_type, " Marker 表达图生成完成"))

    return(result_data)
  }, error = function(e) {
    stop(paste0("Marker 表达图生成失败: ", e$message))
  })
}



#     调用: data_summary.R::my_diffTable2()
# ======================================================================

#* 分组差异分析 (Group1 vs Group2，每组支持多个聚类)
#* @post /markers_pairwise
function(req) {
  body <- jsonlite::fromJSON(req$postBody)
  project_path <- body$project_path
  params <- body$params
  plot_format <- params$plot_format %||% "png"
  task_id <- params$task_id
  report <- create_progress_reporter(task_id)

  report(5, "加载聚类数据...")

  group_by <- params$group_by %||% "Cluster"

  if (group_by == "CellType") {
    input_path <- file.path(project_path, "seurat_annotated.rds")
    if (!file.exists(input_path)) stop("请先运行细胞注释步骤")
    pro <- readRDS(input_path)
    pro <- sync_celltype_from_json(pro, project_path)
    Idents(pro) <- pro$CellType
  } else if (group_by == "Group") {
    input_path <- file.path(project_path, "seurat_clustered.rds")
    if (!file.exists(input_path)) stop("请先运行聚类步骤")
    pro <- readRDS(input_path)
    if (!"Group" %in% colnames(pro@meta.data)) {
      stop("Seurat 对象缺少 Group 列，请先在上传时设置样本分组")
    }
    Idents(pro) <- pro$Group
  } else {
    input_path <- file.path(project_path, "seurat_clustered.rds")
    if (!file.exists(input_path)) stop("请先运行聚类步骤")
    pro <- readRDS(input_path)
  }

  # 前端传逗号分隔字符串，需拆分为向量
  parse_clusters <- function(raw, default) {
    val <- raw %||% default
    if (is.character(val) && length(val) == 1 && grepl(",", val)) {
      return(trimws(unlist(strsplit(val, ","))))
    }
    return(val)
  }

  group1 <- parse_clusters(params$cluster_1, "C1")
  group2 <- parse_clusters(params$cluster_2, "C2")
  min_pct  <- params$min_pct %||% 0.25
  logfc    <- params$logfc_threshold %||% 0.25
  test_use <- params$test_use %||% "wilcox"
  only_pos <- params$only_pos %||% FALSE
  p_adj_cutoff <- params$p_val_adj %||% 0.05

  g1_label <- paste(group1, collapse = "+")
  g2_label <- paste(group2, collapse = "+")
  report(30, paste0("运行分组差异分析: ", g1_label, " vs ", g2_label, "..."))

  # PrepSCTFindMarkers 修复多模型 library size 不一致
  pro <- PrepSCTFindMarkers(pro)

  # 调用更新后的 my_diffTable2()，传入两组聚类向量
  diffTable <- my_diffTable2(pro, min_pct, logfc, test_use, only_pos, group1, group2)

  if (is.character(diffTable)) stop(diffTable)

  # 火山图数据：用宽松阈值重新调用 FindMarkers 获取全量基因
  # （包含低 FC 和不显著基因，确保火山图有灰色/蓝色区域）
  report(50, "生成火山图全量数据...")
  volcano_full <- tryCatch({
    cell_names <- colnames(pro)
    if (any(duplicated(cell_names))) {
      pro <- RenameCells(pro, new.names = make.unique(cell_names, sep = "_dup"))
    }
    fm <- FindMarkers(
      object = pro,
      ident.1 = group1,
      ident.2 = group2,
      min.pct = 0,
      logfc.threshold = 0,
      return.thresh = 1,  # 强制返回所有 p 值的基因
      test.use = test_use,
      only.pos = FALSE
    )
    data.frame(
      gene_id    = rownames(fm),
      avg_log2FC = as.numeric(fm$avg_log2FC),
      p_val_adj  = as.numeric(fm$p_val_adj),
      stringsAsFactors = FALSE
    )
  }, error = function(e) {
    # 如果全量调用失败，退化到已有的 diffTable
    data.frame(
      gene_id    = diffTable$gene_id,
      avg_log2FC = as.numeric(diffTable$avg_log2FC),
      p_val_adj  = as.numeric(diffTable$p_val_adj),
      stringsAsFactors = FALSE
    )
  })
  # 过滤掉 Inf / NaN 行
  volcano_full <- volcano_full[
    is.finite(volcano_full$avg_log2FC) & is.finite(volcano_full$p_val_adj),
  ]

  # 按 p_val_adj 阈值过滤（仅用于 CSV 导出和 top_genes 表格）
  diffFiltered <- diffTable[diffTable$p_val_adj < p_adj_cutoff, ]

  report(80, "保存结果...")

  # 双命名：CSV（过滤后的显著基因）
  csv_archive <- make_output_name(
    project_path, "5b", "markers_pairwise",
    paste0(g1_label, "_vs_", g2_label), "csv"
  )
  output_csv <- file.path(project_path, csv_archive)
  write.csv(diffFiltered, output_csv, row.names = FALSE)

  report(100, "分组差异分析完成")

  list(
    status = "success",
    result_path = output_csv,
    stats = list(
      group1 = g1_label,
      group2 = g2_label,
      total_deg = nrow(diffFiltered)
    ),
    top_genes = head(diffFiltered, 20),
    volcano_data = volcano_full
  )
}


# ======================================================================
# 8. 细胞注释
#    调用: data_summary.R::RunAnno()
# ======================================================================

#* SingleR 自动注释 / 手动注释
#* @post /annotate
function(req) {
  body <- jsonlite::fromJSON(req$postBody)
  project_path <- body$project_path
  params <- body$params
  plot_format <- params$plot_format %||% "png"
  task_id <- params$task_id
  report <- create_progress_reporter(task_id)

  report(5, "加载聚类数据...")

  input_path <- file.path(project_path, "seurat_clustered.rds")
  if (!file.exists(input_path)) stop("请先运行聚类步骤")
  pro <- readRDS(input_path)

  anno_type <- params$anno_type %||% "自动注释"
  group_by <- params$group_by %||% "CellType"
  species <- params$species %||% "Human"
  tissue <- params$tissue %||% "Blood"
  mkfs <- params$markers_table  # 手动注释用

  report(30, paste0("运行细胞注释 (", anno_type, " / ", species, " / ", tissue, ")..."))

  # 调用原始函数 — data_summary.R::RunAnno()
  if (anno_type == "手动注释" && !is.null(mkfs)) {
    mkfs_df <- as.data.frame(mkfs)
    result <- RunAnno(pro, mkfs_df, anno_type, group_by, species, tissue)
  } else {
    result <- RunAnno(pro, NULL, "自动注释", group_by, species, tissue)
  }

  pro <- result$data1
  freq_table <- result$data2

  report(70, "生成注释图...")

  # 双命名：UMAP 注释图
  umap_archive <- make_output_name(project_path, "8", "annotate", "umap", plot_format)
  plot_path <- file.path(project_path, umap_archive)
open_plot_device(plot_path, 1400, 800, plot_format, units = "px")
  print(DimPlot(pro, reduction = 'umap', group.by = 'CellType',
                label = T, cols = clusterCols, repel = T))
  dev.off()

  report(85, "保存数据...")

  # 双命名：RDS
  rds_archive <- make_output_name(project_path, "8", "annotate", "result", "rds")
  archive_path <- file.path(project_path, rds_archive)
  canonical_path <- file.path(project_path, "seurat_annotated.rds")
  save_with_canonical(archive_path, canonical_path, pro)

  report(100, "细胞注释完成")

  # 提取 UMAP 坐标供前端渲染（多分组着色）
  embeddings <- tryCatch(
    Embeddings(pro, reduction = "harmony.umap"),
    error = function(e) tryCatch(
      Embeddings(pro, reduction = "umap"),
      error = function(e2) NULL
    )
  )
  scatter_data <- if (!is.null(embeddings)) {
    md <- pro@meta.data
    list(
      x         = as.numeric(embeddings[, 1]),
      y         = as.numeric(embeddings[, 2]),
      cluster   = as.character(md$Cluster %||% Idents(pro)),
      celltype  = as.character(md$CellType %||% md$Cluster %||% Idents(pro)),
      sample    = as.character(md$Sample %||% "unknown"),
      group     = if ("Group" %in% colnames(md)) as.character(md$Group) else NULL
    )
  } else NULL

  # 构建 per-cluster 原始注释标签（供前端"原始注释"列使用）
  md <- pro@meta.data
  singler_labels <- list()
  if ("singleR" %in% colnames(md)) {
    # 自动注释：每个 cluster 取众数 SingleR 标签
    for (cid in unique(as.character(md$Cluster))) {
      cluster_cells <- as.character(md[md$Cluster == cid, "singleR"])
      singler_labels[[cid]] <- names(sort(table(cluster_cells), decreasing = TRUE))[1]
    }
  } else {
    # 手动注释：使用 CellType 作为原始标签
    for (cid in unique(as.character(md$Cluster))) {
      singler_labels[[cid]] <- as.character(md[md$Cluster == cid, "CellType"][1])
    }
  }

  list(
    status = "success",
    result_path = archive_path,
    plot_path = plot_path,
    stats = list(
      cells = ncol(pro),
      cell_types = length(unique(pro$CellType)),
      anno_type = anno_type,
      species = species,
      tissue = tissue
    ),
    freq_table = freq_table,
    scatter_data = scatter_data,
    singler_labels = singler_labels
  )
}


# ======================================================================
# 4b. 细胞群亚类提取
#     对应 v1: subset(hm_data(), Cluster == subC)
# ======================================================================

#* 提取选定 Cluster 亚类的 Seurat 子集
#* @post /subset_cluster
function(req) {
  body <- jsonlite::fromJSON(req$postBody)
  project_path <- body$project_path
  params <- body$params
  plot_format <- params$plot_format %||% "png"
  task_id <- params$task_id
  report <- create_progress_reporter(task_id)

  report(5, "加载聚类数据...")

  input_path <- file.path(project_path, "seurat_clustered.rds")
  if (!file.exists(input_path)) stop("请先运行聚类步骤")
  pro <- readRDS(input_path)

  selected_clusters <- params$clusters
  if (is.null(selected_clusters) || length(selected_clusters) == 0) {
    stop("请至少选择一个细胞群")
  }

  report(30, paste0("提取亚类: ", paste(selected_clusters, collapse = ", "), "..."))

  # 使用 Seurat 的 idents 参数根据 active identity 提取子集
  sub_data <- subset(pro, idents = selected_clusters)

  report(70, "保存亚类数据...")

  # 双命名：RDS
  cluster_label <- paste(selected_clusters, collapse = "-")
  rds_archive <- make_output_name(project_path, "4b", "subset", cluster_label, "rds")
  archive_path <- file.path(project_path, rds_archive)
  saveRDS(sub_data, archive_path)

  # 提取 meta.data 样本供前端展示
  meta_sample <- head(sub_data@meta.data, 100)
  meta_sample$barcode <- rownames(meta_sample)
  meta_sample <- meta_sample[, c("barcode", setdiff(colnames(meta_sample), "barcode"))]

  report(100, "亚类提取完成")

  list(
    status = "success",
    result_path = archive_path,
    stats = list(
      cells = ncol(sub_data),
      genes = nrow(sub_data),
      clusters_selected = selected_clusters
    ),
    meta_data_sample = meta_sample,
    meta_data_total_rows = nrow(sub_data@meta.data)
  )
}


# ======================================================================
# 9. 格式转换 (双向: 导入 + 导出)
#    导入: H5AD / H5 / CSV / TSV → Seurat RDS
#    导出: RDS → H5Seurat / H5AD
#    来源: app-new.R convert_single_file() 逻辑移植
# ======================================================================

#* 将外部格式转换为 Seurat RDS (导入方向)
#* @param input_path 输入文件路径
#* @param input_format 输入格式 (h5ad / h5 / csv / tsv / rds / rdata / loom)
#* @param output_path 输出 RDS 路径
#* @return 转换结果统计
convert_to_rds <- function(input_path, input_format, output_path) {
  if (!file.exists(input_path)) stop(paste("文件不存在:", input_path))

  obj <- switch(input_format,
    # ---- H5AD (AnnData / Scanpy) ----
    h5ad = {
      if (!requireNamespace("reticulate", quietly = TRUE)) {
        stop("缺少 reticulate 包")
      }
      anndata <- reticulate::import("anndata")
      adata <- anndata$read_h5ad(input_path)

      # 在 Python 端导出为 10X MTX 格式到临时目录，然后用 Read10X 读取
      # 这完全避免了 reticulate 转换 scipy sparse / pandas view 的问题
      mtx_dir <- file.path(dirname(output_path), paste0("_mtx_tmp_", basename(output_path)))
      dir.create(mtx_dir, showWarnings = FALSE, recursive = TRUE)

      py$adata <- adata
      py$mtx_dir <- mtx_dir
      py_run_string("
import scipy.sparse as sp
import scipy.io
import numpy as np
import os

# 获取表达矩阵 (cells x genes)
X = adata.X if hasattr(adata, 'X') and adata.X is not None else adata.raw.X
# 转置: anndata (cells x genes) -> MTX (genes x cells)
X = X.T
if sp.issparse(X):
    X = X.tocsc()
else:
    X = sp.csc_matrix(X if isinstance(X, np.ndarray) else np.array(X))

# 写入 MTX
scipy.io.mmwrite(os.path.join(mtx_dir, 'matrix.mtx'), X)

# 写入 barcodes (cells)
with open(os.path.join(mtx_dir, 'barcodes.tsv'), 'w') as f:
    for n in adata.obs_names:
        f.write(str(n) + '\\n')

# 写入 features (genes)
with open(os.path.join(mtx_dir, 'features.tsv'), 'w') as f:
    for n in adata.var_names:
        f.write(str(n) + '\\t' + str(n) + '\\tGene Expression\\n')

# 导出 .obs 元数据
obs_df = adata.obs.copy()
# 只保留字符串/数值列，跳过复杂类型
safe_cols = []
for col in obs_df.columns:
    if obs_df[col].dtype in ('object', 'category', 'int64', 'float64', 'int32', 'float32', 'bool'):
        safe_cols.append(col)
obs_df = obs_df[safe_cols]
obs_df.to_csv(os.path.join(mtx_dir, 'metadata.csv'))
has_metadata = len(safe_cols) > 0

mtx_ok = True
")

      if (!isTRUE(py$mtx_ok)) stop("MTX 导出失败")

      # 先读取 obs 元数据（gzip 之前）
      meta_csv <- file.path(mtx_dir, "metadata.csv")
      obs_meta <- NULL
      if (file.exists(meta_csv)) {
        obs_meta <- read.csv(meta_csv, row.names = 1)
      }

      # 压缩 MTX 文件 (Seurat::Read10X 需要 .gz 文件)
      for (fn in c("matrix.mtx", "barcodes.tsv", "features.tsv")) {
        src <- file.path(mtx_dir, fn)
        if (file.exists(src)) {
          R.utils::gzip(src, destname = paste0(src, ".gz"), overwrite = TRUE)
          file.remove(src)
        }
      }

      # 使用 Read10X 读取（最可靠的方式）
      matrix_data <- Seurat::Read10X(data.dir = mtx_dir)

      # 去重基因名
      if (requireNamespace("Matrix", quietly = TRUE)) {
        matrix_data <- Matrix::Matrix(as.matrix(matrix_data), sparse = TRUE)
      }
      colnames(matrix_data) <- make.unique(colnames(matrix_data))

      obj <- Seurat::CreateSeuratObject(counts = matrix_data)

      # 逐列添加 .obs 元数据（已在 gzip 前读取）
      if (!is.null(obs_meta)) {
        for (col_name in colnames(obs_meta)) {
          vals <- obs_meta[[col_name]]
          names(vals) <- rownames(obs_meta)
          common <- intersect(colnames(obj), names(vals))
          if (length(common) > 0) {
            obj[[col_name]] <- vals[common]
          }
        }
      }

      # 清理临时目录
      unlink(mtx_dir, recursive = TRUE)

      obj
    },

    # ---- 10X CellRanger H5 ----
    h5 = {
      mat <- Seurat::Read10X_h5(input_path)
      Seurat::CreateSeuratObject(counts = mat)
    },

    # ---- H5Seurat (Seurat v5 原生 HDF5) ----
    h5seurat = {
      if (!requireNamespace("reticulate", quietly = TRUE)) {
        stop("缺少 reticulate 包")
      }
      anndata <- reticulate::import("anndata")
      tryCatch({
        adata <- anndata$read_h5ad(input_path)

        mtx_dir <- file.path(dirname(output_path), paste0("_mtx_tmp_", basename(output_path)))
        dir.create(mtx_dir, showWarnings = FALSE, recursive = TRUE)

        py$adata <- adata
        py$mtx_dir <- mtx_dir
        py_run_string("
import scipy.sparse as sp
import scipy.io
import numpy as np
import os

X = adata.X if hasattr(adata, 'X') and adata.X is not None else (adata.raw.X if hasattr(adata, 'raw') and adata.raw is not None else None)
if X is None:
    raise RuntimeError('无法读取表达矩阵')

# 转置: anndata (cells x genes) -> MTX (genes x cells)
X = X.T
if sp.issparse(X):
    X = X.tocsc()
else:
    X = sp.csc_matrix(X if isinstance(X, np.ndarray) else np.array(X))

scipy.io.mmwrite(os.path.join(mtx_dir, 'matrix.mtx'), X)

with open(os.path.join(mtx_dir, 'barcodes.tsv'), 'w') as f:
    for n in adata.obs_names:
        f.write(str(n) + '\\n')

with open(os.path.join(mtx_dir, 'features.tsv'), 'w') as f:
    for n in adata.var_names:
        f.write(str(n) + '\\t' + str(n) + '\\tGene Expression\\n')

obs_df = adata.obs.copy()
safe_cols = []
for col in obs_df.columns:
    if obs_df[col].dtype in ('object', 'category', 'int64', 'float64', 'int32', 'float32', 'bool'):
        safe_cols.append(col)
obs_df = obs_df[safe_cols]
obs_df.to_csv(os.path.join(mtx_dir, 'metadata.csv'))
has_metadata = len(safe_cols) > 0

mtx_ok = True
")

        if (!isTRUE(py$mtx_ok)) stop("MTX 导出失败")

        # 先读取 obs 元数据（gzip 之前）
        meta_csv <- file.path(mtx_dir, "metadata.csv")
        obs_meta <- NULL
        if (file.exists(meta_csv)) {
          obs_meta <- read.csv(meta_csv, row.names = 1)
        }

        # 压缩 MTX 文件
        for (fn in c("matrix.mtx", "barcodes.tsv", "features.tsv")) {
          src <- file.path(mtx_dir, fn)
          if (file.exists(src)) {
            R.utils::gzip(src, destname = paste0(src, ".gz"), overwrite = TRUE)
            file.remove(src)
          }
        }

        matrix_data <- Seurat::Read10X(data.dir = mtx_dir)

        if (requireNamespace("Matrix", quietly = TRUE)) {
          matrix_data <- Matrix::Matrix(as.matrix(matrix_data), sparse = TRUE)
        }
        colnames(matrix_data) <- make.unique(colnames(matrix_data))

        obj <- Seurat::CreateSeuratObject(counts = matrix_data)

        if (!is.null(obs_meta)) {
          for (col_name in colnames(obs_meta)) {
            vals <- obs_meta[[col_name]]
            names(vals) <- rownames(obs_meta)
            common <- intersect(colnames(obj), names(vals))
            if (length(common) > 0) {
              obj[[col_name]] <- vals[common]
            }
          }
        }

        unlink(mtx_dir, recursive = TRUE)

        obj
      }, error = function(e) {
        stop("H5Seurat 文件读取失败: ", e$message, ". 请先将文件转换为 RDS 格式后重新上传。")
      })
    },

    # ---- CSV 表达矩阵 (基因×细胞) ----
    csv = {
      mat <- read.csv(input_path, row.names = 1)
      Seurat::CreateSeuratObject(counts = as.matrix(mat))
    },

    # ---- TSV/TXT 表达矩阵 ----
    tsv = {
      mat <- read.table(input_path, sep = "\t", row.names = 1,
                        header = TRUE)
      Seurat::CreateSeuratObject(counts = as.matrix(mat))
    },

    # ---- RDS (直接读取，无需转换) ----
    rds = {
      readRDS(input_path)
    },

    # ---- RDATA (R 工作空间) ----
    rdata = {
      env <- new.env(parent = emptyenv())
      load(input_path, envir = env)
      obj_names <- ls(env)
      seurat_names <- Filter(function(n) inherits(env[[n]], "Seurat"), obj_names)
      if (length(seurat_names) == 0) {
        stop("RDATA 文件中未找到 Seurat 对象，请确保文件包含 Seurat 对象或转换为 RDS 格式后重新上传")
      }
      if (length(seurat_names) > 1) {
        stop(sprintf("RDATA 文件包含多个 Seurat 对象（%s），请转换为 RDS 格式后重新上传",
                      paste(seurat_names, collapse = ", ")))
      }
      env[[seurat_names[1]]]
    },

    # ---- Loom ----
    loom = {
      if (!requireNamespace("reticulate", quietly = TRUE)) {
        stop("缺少 reticulate 包，无法读取 Loom 文件")
      }
      anndata <- reticulate::import("anndata")
      adata <- anndata$read_loom(input_path)

      counts <- reticulate::py_to_r(adata$X)
      if (inherits(counts, "dgCMatrix")) counts <- as.matrix(counts)

      tryCatch({
        rownames(counts) <- as.character(reticulate::py_to_r(adata$var_names))
      }, error = function(e) {})
      tryCatch({
        colnames(counts) <- as.character(reticulate::py_to_r(adata$obs_names))
      }, error = function(e) {})

      if (requireNamespace("Matrix", quietly = TRUE)) {
        counts <- Matrix::Matrix(counts, sparse = TRUE)
      }

      obj <- Seurat::CreateSeuratObject(counts = counts)

      # 从 obs 中提取 metadata
      tryCatch({
        obs_df <- reticulate::py_to_r(adata$obs)
        for (col_name in colnames(obs_df)) {
          if (!col_name %in% colnames(obj@meta.data)) {
            obj@meta.data[[col_name]] <- obs_df[[col_name]]
          }
        }
      }, error = function(e) {})

      obj
    },

    stop(paste("不支持的输入格式:", input_format))
  )

  # --- 非 Symbol 基因 ID → Gene Symbol 自动转换 ---
  id_info <- detect_gene_id_type(rownames(obj))
  if (id_info$id_type != "symbol") {
    message(sprintf("检测到 %s ID (%.1f%% 匹配)，正在转换为基因符号...",
                    toupper(id_info$id_type), id_info$match_ratio * 100))
    obj <- convert_ids_to_symbol(obj, id_type = id_info$id_type, species = id_info$species)
  }

  # 保存为 RDS
  saveRDS(obj, output_path)

  list(
    status = "success",
    cells = ncol(obj),
    genes = nrow(obj),
    file_size_mb = round(file.size(output_path) / 1024 / 1024, 2),
    id_converted = !is.null(obj@misc$gene_id_map)
  )
}

#* 将 Seurat RDS 导出为外部格式 (导出方向)
#* @param input_path 输入 RDS 路径
#* @param output_format 输出格式 (h5seurat / h5ad / rds)
#* @param output_path 输出文件路径
#* @return 转换结果
convert_from_rds <- function(input_path, output_format, output_path) {
  if (!file.exists(input_path)) stop(paste("文件不存在:", input_path))
  obj <- readRDS(input_path)

  if (output_format == "h5seurat") {
    SeuratDisk::SaveH5Seurat(obj, filename = output_path, overwrite = TRUE)
  } else if (output_format == "h5ad") {
    h5seurat_path <- paste0(output_path, ".h5seurat")
    SeuratDisk::SaveH5Seurat(obj, filename = h5seurat_path, overwrite = TRUE)
    SeuratDisk::Convert(h5seurat_path, dest = "h5ad", overwrite = TRUE)
    file.remove(h5seurat_path)
  } else if (output_format == "rds") {
    saveRDS(obj, output_path)
  } else {
    stop(paste("不支持的输出格式:", output_format))
  }

  list(
    status = "success",
    cells = ncol(obj),
    genes = nrow(obj)
  )
}

#* 格式转换统一入口 (双向)
#* @post /convert
function(req) {
  params <- jsonlite::fromJSON(req$postBody)
  direction <- params$direction  # "import" | "export"

  if (direction == "import") {
    convert_to_rds(params$input_path, params$input_format, params$output_path)
  } else {
    convert_from_rds(params$input_path, params$output_format, params$output_path)
  }
}


# ======================================================================
# 10. 多样本 10X MTX 整合
#     来源: app-new.R convert_multi_mtx() 逻辑移植
# ======================================================================

#* 多样本 10X MTX 整合为单个 Seurat RDS
#* @post /convert_mtx_merge
function(req) {
  params <- jsonlite::fromJSON(req$postBody)
  sample_dirs <- params$sample_dirs    # 各样本目录路径列表
  sample_names <- params$sample_names  # 各样本名称列表
  output_path <- params$output_path    # 输出 RDS 路径
  task_id <- params$task_id            # 任务 ID (用于进度推送)

  if (length(sample_dirs) < 1) stop("请至少提供 1 个样本目录")
  if (length(sample_dirs) != length(sample_names)) {
    stop("sample_dirs 和 sample_names 长度不一致")
  }

  seurat_objects <- list()

  for (i in seq_along(sample_dirs)) {
    sdir <- sample_dirs[i]
    sname <- sample_names[i]

    if (!dir.exists(sdir)) stop(paste("样本目录不存在:", sdir))

    # 报告进度
    if (!is.null(task_id)) {
      pct <- round((i - 1) / length(sample_dirs) * 80)
      report_progress(task_id, pct, paste0("读取样本 ", sname, "..."))
    }

    # 读取 10X 数据
    matrix_data <- Seurat::Read10X(data.dir = sdir)
    obj <- Seurat::CreateSeuratObject(
      counts = matrix_data,
      project = sname
    )
    obj$Sample <- sname
    seurat_objects[[sname]] <- obj
  }

  # 合并所有样本
  if (!is.null(task_id)) {
    report_progress(task_id, 85, paste0("合并 ", length(seurat_objects), " 个样本..."))
  }

  if (length(seurat_objects) == 1) {
    merged_obj <- seurat_objects[[1]]
  } else {
    merged_obj <- merge(
      seurat_objects[[1]],
      y = seurat_objects[-1],
      add.cell.ids = names(seurat_objects),
      project = "Merged_MultiSample"
    )
  }

  # 保存
  if (!is.null(task_id)) {
    report_progress(task_id, 95, "保存 RDS...")
  }
  saveRDS(merged_obj, output_path)

  if (!is.null(task_id)) {
    report_progress(task_id, 100, "✅ 整合完成")
  }

  list(
    status = "success",
    n_samples = length(seurat_objects),
    cells = ncol(merged_obj),
    genes = nrow(merged_obj),
    file_size_mb = round(file.size(output_path) / 1024 / 1024, 2)
  )
}


#* 合并 RDS 文件（支持 H5AD 等格式经 convert_to_rds 转换后合并）
#* @post /convert_merge_rds
function(req) {
  params <- jsonlite::fromJSON(req$postBody)
  rds_paths <- params$rds_paths        # RDS 文件路径列表
  sample_names <- params$sample_names  # 样本名称列表
  output_path <- params$output_path    # 输出 RDS 路径
  task_id <- params$task_id            # 任务 ID

  if (length(rds_paths) < 1) stop("请至少提供 1 个 RDS 文件")
  if (length(rds_paths) != length(sample_names)) {
    stop("rds_paths 和 sample_names 长度不一致")
  }

  seurat_objects <- list()

  for (i in seq_along(rds_paths)) {
    rpath <- rds_paths[i]
    sname <- sample_names[i]

    if (!file.exists(rpath)) stop(paste("RDS 文件不存在:", rpath))

    if (!is.null(task_id)) {
      pct <- round((i - 1) / length(rds_paths) * 80)
      report_progress(task_id, pct, paste0("读取样本 ", sname, "..."))
    }

    obj <- readRDS(rpath)
    obj$Sample <- sname
    seurat_objects[[sname]] <- obj
  }

  if (!is.null(task_id)) {
    report_progress(task_id, 85, paste0("合并 ", length(seurat_objects), " 个样本..."))
  }

  if (length(seurat_objects) == 1) {
    merged_obj <- seurat_objects[[1]]
  } else {
    merged_obj <- merge(
      seurat_objects[[1]],
      y = seurat_objects[-1],
      add.cell.ids = names(seurat_objects),
      project = "Merged_MultiSample"
    )
  }

  if (!is.null(task_id)) {
    report_progress(task_id, 95, "保存 RDS...")
  }
  saveRDS(merged_obj, output_path)

  if (!is.null(task_id)) {
    report_progress(task_id, 100, "合并完成")
  }

  list(
    status = "success",
    n_samples = length(seurat_objects),
    cells = ncol(merged_obj),
    genes = nrow(merged_obj),
    file_size_mb = round(file.size(output_path) / 1024 / 1024, 2)
  )
}


# ======================================================================
# 9. Monocle 拟时序分析
#     对应 v1: data_summary.R::RunMonocle()
# ======================================================================

#* Monocle 2 拟时序分析
#* @post /monocle
function(req) {
  body <- jsonlite::fromJSON(req$postBody)
  project_path <- body$project_path
  params <- body$params
  plot_format <- params$plot_format %||% "png"
  task_id <- params$task_id
  report <- create_progress_reporter(task_id)

  report(3, "加载注释数据...")

  input_path <- file.path(project_path, "seurat_annotated.rds")
  if (!file.exists(input_path)) stop("请先运行细胞注释步骤")
  pro <- readRDS(input_path)
  pro <- sync_celltype_from_json(pro, project_path)

  group_beam <- params$group_beam %||% "CellType"
  group_traj <- params$group_traj %||% "CellType"
  min_expr_threshold <- params$min_expr_threshold %||% 0.5
  min_cells_pct <- params$min_cells_pct %||% 0.01
  mean_expr <- params$mean_expr %||% 0.3
  qvalue1 <- params$qvalue1 %||% 1e-5
  reverse <- params$reverse %||% FALSE

  old_wd <- getwd()
  setwd(project_path)

  progress_cb <- function(pct, msg) report(pct, msg)

  result <- RunMonocle(pro, group_beam = group_beam, group_traj = group_traj,
                       min_expr_threshold = min_expr_threshold,
                       min_cells_pct = min_cells_pct, mean_expr = mean_expr,
                       qvalue1 = qvalue1, reverse = reverse,
                       progress_callback = progress_cb)

  report(97, "保存图表...")

  # 保存所有 plots
  plot_paths <- list()
  plot_names <- c("ordering_genes", "trajectory", "pseudotime_genes",
                   "heatmap_pseudotime", "heatmap_state", "beam_heatmap", "beam_genes")
  plot_keys <- c("plot", "plot1", "plot2", "plot3", "plot4", "plot5", "plot6")

  for (i in seq_along(plot_keys)) {
    if (!is.null(result[[plot_keys[i]]])) {
      fname <- make_output_name(project_path, "9", "monocle", plot_names[i], plot_format)
      fpath <- file.path(project_path, fname)
      tryCatch({
      open_plot_device(fpath, 1400, 800, plot_format, units = "px")
        if (inherits(result[[plot_keys[i]]], "Heatmap")) {
          draw(result[[plot_keys[i]]])
        } else {
          print(result[[plot_keys[i]]])
        }
        dev.off()
        plot_paths[[plot_names[i]]] <- fpath
      }, error = function(e) {
        dev.off()
        message(paste0("Plot save error (", plot_names[i], "): ", e$message))
      })
    }
  }

  report(85, "保存数据...")

  # 保存关键数据对象
  data_paths <- list()
  data_names <- c("cd_filtered", "ordering_genes", "cd_pseudotime",
                   "pseudotime_meta", "pseudotime_de", "states_de", "beam_res")
  data_keys <- c("data1", "data2", "data3", "data4", "data6", "data7", "data8")

  for (i in seq_along(data_keys)) {
    if (!is.null(result[[data_keys[i]]])) {
      fname <- make_output_name(project_path, "9", "monocle", data_names[i], "rds")
      fpath <- file.path(project_path, fname)
      saveRDS(result[[data_keys[i]]], fpath)
      data_paths[[data_names[i]]] <- fpath
    }
  }

  # 导出 CellDataSet 的 pData 为 CSV（用户无需 monocle 包即可打开）
  tryCatch({
    cd_obj <- result$data3  # cd_pseudotime
    if (is.null(cd_obj)) cd_obj <- result$data1  # cd_filtered
    if (!is.null(cd_obj) && methods::is(cd_obj, "CellDataSet")) {
      meta_df <- as.data.frame(Biobase::pData(cd_obj))
      csv_name <- make_output_name(project_path, "9", "monocle", "cell_metadata", "csv")
      csv_path <- file.path(project_path, csv_name)
      write.csv(meta_df, csv_path, row.names = TRUE)
      data_paths$cell_metadata_csv <- csv_path
    }
  }, error = function(e) message("pData CSV export failed: ", e$message))

  # 保存 BEAM 差异基因 CSV
  if (!is.null(result$data8)) {
    csv_name <- make_output_name(project_path, "9", "monocle", "beam_diff_genes", "csv")
    csv_path <- file.path(project_path, csv_name)
    write.csv(result$data8, csv_path, row.names = FALSE)
    data_paths$beam_diff_genes_csv <- csv_path
  }

  report(100, "Monocle 分析完成")

  gc(verbose = FALSE)
  list(
    status = "success",
    plot_paths = plot_paths,
    data_paths = data_paths,
    stats = list(
      ordering_genes = nrow(result$data2 %||% data.frame()),
      pseudotime_de_genes = nrow(result$data6 %||% data.frame()),
      beam_genes = nrow(result$data8 %||% data.frame())
    )
  )
}


# ======================================================================
# 10. CellChat 细胞通讯分析
#      对应 v1: data_summary.R::RunCellChat()
# ======================================================================

#* CellChat 细胞通讯分析
#* @post /cellchat
function(req) {
  body <- jsonlite::fromJSON(req$postBody)
  project_path <- body$project_path
  params <- body$params
  plot_format <- params$plot_format %||% "png"
  task_id <- params$task_id
  report <- create_progress_reporter(task_id)
  suppressMessages(library(ComplexHeatmap))

  report(3, "加载注释数据...")

  input_path <- file.path(project_path, "seurat_annotated.rds")
  if (!file.exists(input_path)) stop("请先运行细胞注释步骤")
  pro <- readRDS(input_path)
  pro <- sync_celltype_from_json(pro, project_path)

  species <- params$species %||% "Human"
  db_use <- params$db_use %||% "Secreted"
  thresh <- params$thresh %||% 0.05
  min_cells <- as.integer(params$min_cells %||% 10)
  prob_method <- params$prob_method %||% "triMean"
  top_pathways <- as.integer(params$top_pathways %||% 1)
  remove_isolate <- isTRUE(params$remove_isolate)

  old_wd <- getwd()
  setwd(project_path)

  progress_cb <- function(pct, msg) report(pct, msg)

  result <- RunCellChat(pro, species = species, db_use = db_use, thresh = thresh,
                        min_cells = min_cells, prob_method = prob_method,
                        top_pathways = top_pathways, remove_isolate = remove_isolate,
                        progress_callback = progress_cb)

  report(95, "保存图表...")

  # 保存 plots
  plot_paths <- list()
  plot_configs <- list(
    list(key = "plot4", name = "pathway_heatmap", w = 900, h = 800),
    list(key = "plot5", name = "pathway_contribution", w = 900, h = 600),
    list(key = "p91", name = "gene_vln", w = 1400, h = 800),
    list(key = "p92", name = "gene_dot", w = 1400, h = 800)
  )

  # 初始化 cellchat 引用（后续数据保存也需要用到）
  cellchat <- NULL

  # net_number / net_strength: 直接重新渲染，从 cellchat 对象提取带名称的 groupSize
  if (!is.null(result$cellchat)) {
    cellchat <- result$cellchat
    groupSize <- as.numeric(table(cellchat@idents))
    names(groupSize) <- levels(cellchat@idents)
    tryCatch({
      fname <- make_output_name(project_path, "10", "cellchat", "net_number", plot_format)
      fpath <- file.path(project_path, fname)
    open_plot_device(fpath, 1400, 700, plot_format, units = "px")
      netVisual_circle(cellchat@net$count, vertex.weight = groupSize, weight.scale = T,
                       label.edge = F, title.name = "Number of interactions")
      dev.off()
      plot_paths$net_number <- fpath
    }, error = function(e) { dev.off(); message(paste0("Plot save error (net_number): ", e$message)) })
    tryCatch({
      fname <- make_output_name(project_path, "10", "cellchat", "net_strength", plot_format)
      fpath <- file.path(project_path, fname)
    open_plot_device(fpath, 1400, 700, plot_format, units = "px")
      netVisual_circle(cellchat@net$weight, vertex.weight = groupSize, weight.scale = T,
                       label.edge = F, title.name = "Interaction weights/strength")
      dev.off()
      plot_paths$net_strength <- fpath
    }, error = function(e) { dev.off(); message(paste0("Plot save error (net_strength): ", e$message)) })
  }

  for (cfg in plot_configs) {
    if (!is.null(result[[cfg$key]])) {
      fname <- make_output_name(project_path, "10", "cellchat", cfg$name, plot_format)
      fpath <- file.path(project_path, fname)
      tryCatch({
      open_plot_device(fpath, cfg$w, cfg$h, plot_format, units = "px")
        if (inherits(result[[cfg$key]], "Heatmap")) {
          draw(result[[cfg$key]])
        } else {
          print(result[[cfg$key]])
        }
        dev.off()
        plot_paths[[cfg$name]] <- fpath
      }, error = function(e) {
        dev.off()
        message(paste0("Plot save error (", cfg$name, "): ", e$message))
      })
    }
  }

  # 保存多通路编号图表（pw_idx >= 2，避免与主图重复）
  for (pw_idx in 2:99) {
    found <- FALSE
    for (cfg in plot_configs) {
      numbered_key <- paste0(cfg$key, "_", pw_idx)
      if (!is.null(result[[numbered_key]])) {
        found <- TRUE
        fname <- make_output_name(project_path, "10", "cellchat", paste0(cfg$name, "_", pw_idx), plot_format)
        fpath <- file.path(project_path, fname)
        tryCatch({
          open_plot_device(fpath, cfg$w, cfg$h, plot_format, units = "px")
          if (inherits(result[[numbered_key]], "Heatmap")) { draw(result[[numbered_key]]) } else { print(result[[numbered_key]]) }
          dev.off()
          plot_paths[[paste0(cfg$name, "_", pw_idx)]] <- fpath
        }, error = function(e) { dev.off(); message(paste0("Plot save error (", numbered_key, "): ", e$message)) })
      }
    }
    if (!found) break
  }

  # 保存气泡图（ggplot 对象用 ggsave）
  if (!is.null(result$f1)) {
    fname <- make_output_name(project_path, "10", "cellchat", "bubble", plot_format)
    fpath <- file.path(project_path, fname)
    tryCatch({
      ggsave(fpath, plot = result$f1, width = 10, height = 8, dpi = 600)
      plot_paths$bubble <- fpath
    }, error = function(e) message(paste0("Bubble plot error: ", e$message)))
  }

  report(85, "保存数据...")

  # 保存数据
  data_paths <- list()
  if (!is.null(result$data1)) {
    fname <- make_output_name(project_path, "10", "cellchat", "net_LR", "csv")
    fpath <- file.path(project_path, fname)
    write.csv(result$data1, fpath, row.names = FALSE)
    data_paths$net_LR <- fpath
  }
  if (!is.null(result$data2)) {
    fname <- make_output_name(project_path, "10", "cellchat", "net_pathway", "csv")
    fpath <- file.path(project_path, fname)
    write.csv(result$data2, fpath, row.names = FALSE)
    data_paths$net_pathway <- fpath
  }
  # 通讯网络矩阵
  if (!is.null(cellchat)) {
    tryCatch({
      fname <- make_output_name(project_path, "10", "cellchat", "net_count", "csv")
      fpath <- file.path(project_path, fname)
      write.csv(cellchat@net$count, fpath)
      data_paths$net_count <- fpath
    }, error = function(e) message("Save net_count error: ", e$message))
    tryCatch({
      fname <- make_output_name(project_path, "10", "cellchat", "net_weight", "csv")
      fpath <- file.path(project_path, fname)
      write.csv(cellchat@net$weight, fpath)
      data_paths$net_weight <- fpath
    }, error = function(e) message("Save net_weight error: ", e$message))
    # 保存完整 CellChat 对象
    tryCatch({
      fname <- make_output_name(project_path, "10", "cellchat", "cellchat_obj", "rds")
      fpath <- file.path(project_path, fname)
      saveRDS(cellchat, fpath)
      data_paths$cellchat_obj <- fpath
    }, error = function(e) message("Save cellchat rds error: ", e$message))
  }

  report(100, "CellChat 分析完成")

  # 信号通路全集，按通讯总强度(netP$prob 各通路求和)降序，供前端下拉
  all_pathways <- character(0)
  if (!is.null(cellchat)) {
    pw <- cellchat@netP$pathways
    prob <- cellchat@netP$prob
    if (!is.null(prob) && length(dim(prob)) == 3 && !is.null(dimnames(prob)[[3]])) {
      strength <- apply(prob, 3, sum, na.rm = TRUE)   # 按通路名命名的总强度
      strength <- strength[names(strength) %in% pw]
      sorted <- names(sort(strength, decreasing = TRUE))
      all_pathways <- c(sorted, setdiff(pw, sorted))  # 无强度信息的兜底放末尾
    } else {
      all_pathways <- pw
    }
  }

  gc(verbose = FALSE)
  list(
    status = "success",
    plot_paths = plot_paths,
    data_paths = data_paths,
    pathways = all_pathways,
    stats = list(
      n_interactions = nrow(result$data1 %||% data.frame()),
      n_pathways = length(unique(result$data2$pathway_name %||% c())),
      group_sizes = result$data3
    )
  )
}


# ======================================================================
# 10b. CellChat 单信号通路按需出图（前端下拉切换通路）
#      复用已保存的 cellchat_obj.rds，只重出 4 张通路特异图
# ======================================================================

#* CellChat 单信号通路重新出图
#* @post /cellchat_pathway
function(req) {
  body <- jsonlite::fromJSON(req$postBody)
  project_path <- body$project_path
  params <- body$params
  plot_format <- params$plot_format %||% "png"
  task_id <- params$task_id
  report <- create_progress_reporter(task_id)
  suppressMessages(library(CellChat))
  suppressMessages(library(ComplexHeatmap))

  pathway <- params$pathway
  if (is.null(pathway) || !nzchar(pathway)) stop("请指定信号通路 (pathway)")

  report(5, "加载 CellChat 对象...")
  # 定位 cellchat_obj.rds：优先用前端传入文件名，否则取 project 内最新
  obj_name <- params$cellchat_obj %||% NULL
  obj_path <- NULL
  if (!is.null(obj_name) && nzchar(obj_name)) {
    cand <- file.path(project_path, basename(obj_name))
    if (file.exists(cand)) obj_path <- cand
  }
  if (is.null(obj_path)) {
    cands <- list.files(project_path, pattern = "cellchat_obj\\.rds$", full.names = TRUE)
    if (length(cands) == 0) stop("未找到 CellChat 对象，请先运行细胞通讯分析")
    obj_path <- cands[which.max(file.info(cands)$mtime)]
  }
  cellchat <- readRDS(obj_path)

  all_pw <- cellchat@netP$pathways
  if (!(pathway %in% all_pw)) {
    stop(paste0("信号通路 '", pathway, "' 不存在；可选: ", paste(all_pw, collapse = ", ")))
  }

  pw_tag <- gsub("[^A-Za-z0-9]+", "_", pathway)
  plot_paths <- list()

  save_one <- function(name, w, h, expr) {
    fname <- make_output_name(project_path, "10", "cellchat", paste0("pw_", pw_tag, "_", name), plot_format)
    fpath <- file.path(project_path, fname)
    tryCatch({
      open_plot_device(fpath, w, h, plot_format, units = "px")
      p <- expr()
      if (inherits(p, "Heatmap")) draw(p) else if (!is.null(p)) print(p)
      dev.off()
      plot_paths[[name]] <<- fpath
    }, error = function(e) {
      try(dev.off(), silent = TRUE)
      message(paste0("cellchat_pathway plot error (", name, "): ", e$message))
    })
  }

  report(30, paste0(pathway, " 通路热图..."))
  save_one("pathway_heatmap", 900, 800, function() netVisual_heatmap(cellchat, signaling = pathway, color.heatmap = "Reds"))
  report(50, paste0(pathway, " 通路贡献..."))
  save_one("pathway_contribution", 900, 600, function() netAnalysis_contribution(cellchat, signaling = pathway))
  report(70, paste0(pathway, " 基因表达(小提琴)..."))
  save_one("gene_vln", 1400, 800, function() plotGeneExpression(cellchat, signaling = pathway))
  report(88, paste0(pathway, " 基因表达(点图)..."))
  save_one("gene_dot", 1400, 800, function() plotGeneExpression(cellchat, signaling = pathway, type = "dot", color.use = clusterCols))

  report(100, "完成")
  gc(verbose = FALSE)
  list(
    status = "success",
    pathway = pathway,
    plot_paths = plot_paths
  )
}


# ======================================================================
# 11. inferCNV 拷贝数变异分析
#      对应 v1: data_summary.R::RunInfercnv()
# ======================================================================

#* inferCNV 拷贝数变异分析
#* @post /infercnv
function(req) {
  body <- jsonlite::fromJSON(req$postBody)
  project_path <- body$project_path
  params <- body$params
  plot_format <- params$plot_format %||% "png"
  task_id <- params$task_id
  report <- create_progress_reporter(task_id)

  report(3, "加载注释数据...")

  input_path <- file.path(project_path, "seurat_annotated.rds")
  if (!file.exists(input_path)) stop("请先运行细胞注释步骤")
  pro <- readRDS(input_path)
  pro <- sync_celltype_from_json(pro, project_path)

  # 构建 inferDf
  infer_df_data <- params$infer_df
  message("[INFERCNV DEBUG] infer_df class: ", paste(class(infer_df_data), collapse=","))
  message("[INFERCNV DEBUG] infer_df length: ", length(infer_df_data))
  if (is.list(infer_df_data)) {
    message("[INFERCNV DEBUG] infer_df names: ", paste(names(infer_df_data), collapse=","))
    message("[INFERCNV DEBUG] infer_df[[1]] class: ", paste(class(infer_df_data[[1]]), collapse=","))
  }
  message("[INFERCNV DEBUG] cutoff_gene raw: ", params$cutoff_gene, " class: ", paste(class(params$cutoff_gene), collapse=","))
  message("[INFERCNV DEBUG] num_threads raw: ", params$num_threads, " class: ", paste(class(params$num_threads), collapse=","))
  message("[INFERCNV DEBUG] species: ", params$species)
  message("[INFERCNV DEBUG] project_path: ", project_path)

  if (is.null(infer_df_data) || length(infer_df_data) == 0) {
    stop("请指定细胞类型的参考/查询分类 (infer_df)")
  }
  inferDf <- as.data.frame(infer_df_data)
  message("[INFERCNV DEBUG] inferDf cols: ", paste(colnames(inferDf), collapse=","))
  message("[INFERCNV DEBUG] inferDf rows: ", nrow(inferDf))
  message("[INFERCNV DEBUG] inferDf print:")
  print(head(inferDf))

  cutoff_gene <- as.numeric(params$cutoff_gene %||% 0.1)
  num_threads <- as.integer(params$num_threads %||% 1)
  species <- params$species %||% "Human"
  message("[INFERCNV DEBUG] cutoff_gene final: ", cutoff_gene, " class: ", class(cutoff_gene))
  message("[INFERCNV DEBUG] num_threads final: ", num_threads, " class: ", class(num_threads))

  # 创建输出目录
  outdir <- file.path(project_path, paste0("infercnv_output_", format(Sys.time(), "%Y%m%d%H%M%S")))
  dir.create(outdir, showWarnings = FALSE, recursive = TRUE)

  old_wd <- getwd()
  setwd(outdir)

  progress_cb <- function(pct, msg) report(pct, msg)

  message("[INFERCNV DEBUG] About to call RunInfercnv...")
  message("[INFERCNV DEBUG] pro class: ", paste(class(pro), collapse=","))
  message("[INFERCNV DEBUG] pro assay: ", DefaultAssay(pro))
  message("[INFERCNV DEBUG] pro ncol: ", ncol(pro), " nrow: ", nrow(pro))

  result <- tryCatch(
    RunInfercnv(pro, inferDf = inferDf, cutoff_gene = cutoff_gene,
                           outdir = outdir, numThreads = num_threads,
                           species = species, progress_callback = progress_cb),
    error = function(e) {
      message("[INFERCNV ERROR] ", e$message)
      message("[INFERCNV ERROR] call: ", paste(deparse(e$call), collapse=""))
      stop(e)
    }
  )

  report(95, "收集结果...")

  # infercnv 图文件中文标签映射
  infercnv_label_map <- list(
    "infercnv.png"                        = "最终热图 (去噪后)",
    "infercnv.preliminary.png"            = "初步热图 (去噪前)",
    "infercnv_subclusters.png"            = "亚群聚类热图"
  )
  get_infercnv_label <- function(fname) {
    if (!is.null(infercnv_label_map[[fname]])) return(infercnv_label_map[[fname]])
    # 动态匹配带编号的文件
    if (grepl("HMM_pred.*Bayes_Net", fname)) return("贝叶斯网络 CNV 预测热图")
    if (grepl("repr_intensities", fname))    return("表达强度热图 (HMM CNV)")
    if (grepl("HMM_predHMMi6", fname))       return("HMM 预测 CNV 热图")
    # 兜底: 去掉前缀和扩展名
    sub("^infercnv\\.", "", sub("\\.png$", "", fname))
  }

  # PDF 转换函数: 使用 R 原生 pdf() + png 包 (无需 magick)
  convert_png_to_pdf <- function(png_path, pdf_path) {
    tryCatch({
      img <- png::readPNG(png_path)
      h <- dim(img)[1]
      w <- dim(img)[2]
      pdf(pdf_path, width = w / 72, height = h / 72)
      grid::grid.raster(img)
      dev.off()
      TRUE
    }, error = function(e) {
      message("[INFERCNV] PDF 转换失败: ", e$message)
      FALSE
    })
  }

  # 收集输出文件，使用中文标签，按需转换 PDF
  output_files <- list.files(outdir, full.names = TRUE)
  plot_paths <- list()
  data_paths <- list()

  want_pdf <- identical(plot_format, "pdf")

  for (f in output_files) {
    fname <- basename(f)
    if (grepl("\\.png$", fname)) {
      label <- get_infercnv_label(fname)
      if (want_pdf) {
        pdf_path <- sub("\\.png$", ".pdf", f)
        if (convert_png_to_pdf(f, pdf_path)) {
          plot_paths[[label]] <- pdf_path
        } else {
          plot_paths[[label]] <- f
        }
      } else {
        plot_paths[[label]] <- f
      }
    } else if (grepl("\\.pdf$", fname)) {
      label <- get_infercnv_label(sub("\\.pdf$", ".png", fname))
      plot_paths[[label]] <- f
    } else if (grepl("\\.(txt|csv)$", fname)) {
      data_paths[[fname]] <- f
    }
  }

  # 使用 make_output_name 重命名图表文件
  renamed_plots <- list()
  for (label in names(plot_paths)) {
    fpath <- plot_paths[[label]]
    fbase <- basename(fpath)
    ext <- tools::file_ext(fbase)
        suffix <- sub("^infercnv\\.", "", sub("\\.[^.]+$", "", fbase))
    if (suffix == "" || suffix == "infercnv") suffix <- "heatmap"
    new_name <- make_output_name(project_path, "11", "infercnv", suffix, ext)
    new_path <- file.path(project_path, new_name)
    file.copy(fpath, new_path, overwrite = TRUE)
    renamed_plots[[label]] <- new_path
  }
  plot_paths <- renamed_plots

  # 使用 make_output_name 重命名数据文件
  renamed_data <- list()
  for (label in names(data_paths)) {
    fpath <- data_paths[[label]]
    if (label == "infercnv_obj") {
      renamed_data[[label]] <- fpath
      next
    }
    fbase <- basename(fpath)
    ext <- tools::file_ext(fbase)
    suffix <- sub("\\.[^.]+$", "", fbase)
    suffix <- sub("^infercnv[._]", "", suffix)
    if (suffix == "" || suffix == "infercnv") suffix <- "data"
    new_name <- make_output_name(project_path, "11", "infercnv", suffix, ext)
    new_path <- file.path(project_path, new_name)
    file.copy(fpath, new_path, overwrite = TRUE)
    renamed_data[[label]] <- new_path
  }
  data_paths <- renamed_data

  # 保存 infercnv 对象
  obj_name <- make_output_name(project_path, "11", "infercnv", "object", "rds")
  obj_path <- file.path(project_path, obj_name)
  saveRDS(result$infercnv_obj, obj_path)
  data_paths$infercnv_obj <- obj_path

  report(100, "inferCNV 分析完成")

  gc(verbose = FALSE)
  list(
    status = "success",
    outdir = outdir,
    plot_paths = plot_paths,
    data_paths = data_paths,
    stats = list(
      n_ref_types = sum(inferDf$refType == "reference"),
      n_query_types = sum(inferDf$refType != "reference"),
      cutoff = cutoff_gene
    )
  )
}


#* WGCNA 加权基因共表达网络分析
#* @post /wgcna
function(req) {
  body <- jsonlite::fromJSON(req$postBody)
  project_path <- body$project_path
  params <- body$params
  plot_format <- params$plot_format %||% "png"
  task_id <- params$task_id
  report <- create_progress_reporter(task_id)

  report(3, "加载数据...")

  input_path <- file.path(project_path, "seurat_annotated.rds")
  if (!file.exists(input_path)) stop("请先运行细胞注释步骤")
  pro <- readRDS(input_path)
  pro <- sync_celltype_from_json(pro, project_path)

  # 支持单个或批量细胞类型（前端多选传 interest_types 数组）
  interestTypes <- params$interest_types
  if (is.null(interestTypes) || length(interestTypes) == 0) {
    # 兼容旧版单个 interest_type
    interestType <- params$interest_type %||% NULL
    if (is.null(interestType) || nchar(trimws(interestType)) == 0) {
      stop("请指定目标细胞类型")
    }
    interestTypes <- list(interestType)
  }
  interestType <- interestTypes[[1]]  # 取第一个执行（后续可扩展循环批量）

  minFraction <- params$min_fraction %||% 0.05
  sft_threshold <- params$sft_threshold %||% 0.8
  ModuleScore <- params$module_score %||% "Seurat"
  k <- params$k %||% 25
  max_shared <- params$max_shared %||% 10
  min_cells <- params$min_cells %||% 100
  n_hubs <- params$n_hubs %||% 10
  n_genes_score <- params$n_genes_score %||% 25

  base_outdir <- file.path(project_path, paste0("wgcna_output_", format(Sys.time(), "%Y%m%d%H%M%S")))
  dir.create(base_outdir, showWarnings = FALSE, recursive = TRUE)

  all_plot_paths <- list()
  all_data_paths <- list()
  all_stats <- list()
  n_types <- length(interestTypes)

  old_wd <- getwd()
  progress_cb <- function(pct, msg) report(pct, msg)

  for (idx in seq_along(interestTypes)) {
    ct <- interestTypes[[idx]]
    report(0, paste0("WGCNA: [", idx, "/", n_types, "] ", ct))

    outdir <- file.path(base_outdir, gsub("[^a-zA-Z0-9_-]", "_", ct))
    dir.create(outdir, showWarnings = FALSE, recursive = TRUE)
    setwd(outdir)

    result <- tryCatch({
      RunWGCNA(
        seurat_obj = pro, outdir = outdir,
        interestType = ct,
        minFraction = minFraction,
        sft_threshold = sft_threshold,
        ModuleScore = ModuleScore,
        k = k, max_shared = max_shared,
        min_cells = min_cells,
        n_hubs = n_hubs,
        n_genes_score = n_genes_score,
        progress_callback = function(pct, msg) {
          base_pct <- round((idx - 1) / n_types * 100)
          overall_pct <- min(base_pct + round(pct / n_types), 100)
          report(overall_pct, paste0("[", ct, "] ", msg))
        }
      )
    }, error = function(e) {
      report(round(idx/n_types * 100), paste0("[", ct, "] FAILED: ", conditionMessage(e)))
      return(NULL)
    })

    if (!is.null(result)) {
      output_files <- list.files(outdir, full.names = TRUE)
      for (f in output_files) {
        bname <- basename(f)
        bname_clean <- sub(paste0("^", ct, "_?"), "", bname)
        suffix <- gsub("\\.(png|pdf|csv|rds)$", "", paste0(ct, "_", bname_clean))
        suffix <- gsub("[^a-zA-Z0-9_.-]", "_", suffix)
        ext <- if (grepl("\\.png$", f)) "png"
               else if (grepl("\\.pdf$", f)) "pdf"
               else if (grepl("\\.csv$", f)) "csv"
               else "rds"
        fname <- make_output_name(project_path, "12", "wgcna", suffix, ext)
        fname_full <- file.path(project_path, fname)
        file.copy(f, fname_full, overwrite = TRUE)
        if (grepl("\\.(png|pdf)$", fname)) {
          all_plot_paths[[fname]] <- fname_full
        } else if (grepl("\\.(csv|rds)$", fname)) {
          all_data_paths[[fname]] <- fname_full
        }
      }
      all_stats[[ct]] <- list(
        soft_power = result$soft_power,
        n_modules = length(setdiff(colnames(result$hMEs), "grey")),
        n_hub_genes = nrow(result$hub_genes)
      )
      obj_name <- make_output_name(project_path, "12", "wgcna", ct, "rds")
      obj_path <- file.path(project_path, obj_name)
      tryCatch(saveRDS(result$seurat_obj_scored, obj_path), error = function(e) NULL)
      all_data_paths[[paste0(ct, "_obj")]] <- obj_path
    }
  }


  # hdWGCNA always generates PNG internally.
  # When user selects PDF, convert each PNG to a real PDF file.
  if (plot_format == "pdf") {
    library(png)
    report(98, "Converting PNG charts to PDF...")
    for (fname in names(all_plot_paths)) {
      png_path <- all_plot_paths[[fname]]
      if (grepl("[.]png$", png_path)) {
        pdf_path <- sub("[.]png$", ".pdf", png_path)
        img <- tryCatch(readPNG(png_path), error = function(e) NULL)
        if (!is.null(img)) {
          pdf(pdf_path)
          grid::grid.raster(img)
          dev.off()
          pdf_fname <- sub("[.]png$", ".pdf", fname)
          all_plot_paths[[pdf_fname]] <- pdf_path
          all_plot_paths[[fname]] <- NULL
          file.remove(png_path)
        }
      }
    }
  }
  setwd(old_wd)
  report(100, paste0("WGCNA 完成: ", sum(sapply(all_stats, function(x) !is.null(x))), "/", n_types))

  result_json <- file.path(project_path, "wgcna_result.json")
  result_data <- list(
    status = "success",
    outdir = base_outdir,
    plot_paths = all_plot_paths,
    data_paths = all_data_paths,
    stats = all_stats
  )
  jsonlite::write_json(result_data, result_json, auto_unbox = TRUE, pretty = TRUE)

  gc(verbose = FALSE)
  list(
    status = "success",
    result_path = result_json,
    outdir = base_outdir,
    plot_paths = all_plot_paths,
    data_paths = all_data_paths,
    stats = all_stats
  )
}
