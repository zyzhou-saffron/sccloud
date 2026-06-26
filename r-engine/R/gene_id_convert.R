# =====================================================================
# gene_id_convert.R — 基因 ID 自动检测与转换
#
# 支持的 ID 格式:
#   Ensembl   (ENSG00000141510)
#   Entrez    (7157)
#   RefSeq    (NM_001136127)
#   UniProt   (P04637)
#   Symbol    (TP53) — 目标格式，无需转换
#
# 核心函数:
#   detect_gene_id_type()      — 检测基因 ID 类型
#   convert_ids_to_symbol()    — 将 Seurat 行名转为 gene symbol
#   lookup_gene_symbol()       — 双向查找
# =====================================================================

#' 检测基因 ID 类型
#'
#' @param gene_names character vector of gene names (e.g. rownames)
#' @return list: id_type ("ensembl"/"entrez"/"refseq"/"uniprot"/"symbol"), species, match_ratio
detect_gene_id_type <- function(gene_names) {
  sample_ids <- head(gene_names, 200)
  n <- length(sample_ids)

  # 各格式正则
  pat_ensembl  <- "^ENS[A-Z]*G[0-9]{11}"
  pat_refseq   <- "^[NX][MR]_[0-9]+"
  pat_uniprot  <- "^[A-Z][0-9][A-Z0-9]{3}[0-9]$"
  pat_entrez   <- "^[0-9]{1,9}$"

  # 按优先级检测
  r_ensembl <- mean(grepl(pat_ensembl, sample_ids))
  r_refseq  <- mean(grepl(pat_refseq, sample_ids))
  r_uniprot <- mean(grepl(pat_uniprot, sample_ids))
  r_entrez  <- mean(grepl(pat_entrez, sample_ids))

  THRESHOLD <- 0.5

  # 物种检测
  detect_species <- function(ids) {
    if (any(grepl("^ENSMUSG", ids))) return("mouse")
    if (any(grepl("^ENSG", ids)))    return("human")
    return("human")  # 默认
  }

  if (r_ensembl > THRESHOLD) {
    return(list(id_type = "ensembl", species = detect_species(sample_ids), match_ratio = r_ensembl))
  }
  if (r_refseq > THRESHOLD) {
    return(list(id_type = "refseq", species = "unknown", match_ratio = r_refseq))
  }
  if (r_uniprot > THRESHOLD) {
    return(list(id_type = "uniprot", species = "unknown", match_ratio = r_uniprot))
  }
  if (r_entrez > THRESHOLD) {
    return(list(id_type = "entrez", species = "unknown", match_ratio = r_entrez))
  }

  list(id_type = "symbol", species = NULL, match_ratio = 0)
}


#' 将 Seurat 对象的行名转换为 Gene Symbol
#'
#' 支持 Ensembl / Entrez / RefSeq / UniProt → Symbol 转换。
#' 转换后存储映射表到 @misc 供反向查找。
#'
#' @param seurat_obj Seurat object
#' @param id_type character, auto-detected if NULL
#' @param species "human"/"mouse", auto-detected if NULL
#' @param keep_unmapped logical, keep unmapped IDs as-is
#' @return modified Seurat object
convert_ids_to_symbol <- function(seurat_obj, id_type = NULL, species = NULL, keep_unmapped = TRUE) {
  original_ids <- rownames(seurat_obj)

  # 自动检测
  if (is.null(id_type)) {
    info <- detect_gene_id_type(original_ids)
    id_type <- info$id_type
    if (is.null(species) && !is.null(info$species)) species <- info$species
  }

  # 已经是 symbol，无需转换
  if (id_type == "symbol") return(seurat_obj)

  # 确定物种和注释数据库
  if (is.null(species) || species == "unknown") species <- "human"

  org_db <- switch(species,
    human = {
      if (!requireNamespace("org.Hs.eg.db", quietly = TRUE))
        stop("未安装 org.Hs.eg.db 包")
      org.Hs.eg.db::org.Hs.eg.db
    },
    mouse = {
      if (!requireNamespace("org.Mm.eg.db", quietly = TRUE))
        stop("未安装 org.Mm.eg.db 包")
      org.Mm.eg.db::org.Mm.eg.db
    },
    stop(paste("不支持的物种:", species))
  )

  # 确定 keytype
  keytype <- switch(id_type,
    ensembl  = "ENSEMBL",
    entrez   = "ENTREZID",
    refseq   = "REFSEQ",
    uniprot  = "UNIPROT",
    stop(paste("不支持的 ID 类型:", id_type))
  )

  # 预处理：Ensembl 去版本号
  clean_ids <- if (id_type == "ensembl") sub("\\.[0-9]+$", "", original_ids) else original_ids

  # 查询映射
  mapping <- tryCatch(
    AnnotationDbi::select(
      org_db,
      keys = clean_ids,
      columns = "SYMBOL",
      keytype = keytype
    ),
    error = function(e) {
      message(paste("AnnotationDbi::select 失败:", e$message))
      data.frame(tmp = character(0), SYMBOL = character(0))
    }
  )

  if (nrow(mapping) == 0) {
    message("警告: 无法映射任何 ID，保留原始行名")
    return(seurat_obj)
  }

  # 统一列名
  colnames(mapping)[1] <- "ID"
  mapping <- mapping[!is.na(mapping$SYMBOL), ]
  mapping <- mapping[!duplicated(mapping$ID), ]

  # 构建映射向量
  map_vec <- setNames(mapping$SYMBOL, mapping$ID)

  # 映射基因名
  new_names <- map_vec[clean_ids]
  unmapped <- is.na(new_names)
  if (keep_unmapped) {
    new_names[unmapped] <- original_ids[unmapped]
  }

  # 处理重复 symbol：多个 ID → 同一 symbol，保留表达量最高的
  dup_symbols <- unique(new_names[!unmapped & duplicated(new_names[!unmapped])])
  if (length(dup_symbols) > 0) {
    counts <- Seurat::GetAssayData(seurat_obj, assay = "RNA", layer = "counts")
    for (sym in dup_symbols) {
      idx <- which(new_names == sym & !unmapped)
      if (length(idx) <= 1) next

      mean_expr <- Matrix::rowMeans(counts[idx, , drop = FALSE])
      keep_idx <- idx[which.max(mean_expr)]
      drop_idx <- setdiff(idx, keep_idx)

      if (keep_unmapped) {
        new_names[drop_idx] <- original_ids[drop_idx]
      } else {
        new_names[drop_idx] <- NA
      }
    }
  }

  # 过滤 NA
  if (!keep_unmapped) {
    keep <- !is.na(new_names)
    seurat_obj <- seurat_obj[keep, ]
    new_names <- new_names[keep]
    original_ids <- original_ids[keep]
  }

  # 存储映射元数据
  final_map <- setNames(new_names, original_ids)
  seurat_obj@misc$gene_id_map     <- final_map
  seurat_obj@misc$original_gene_ids <- original_ids
  seurat_obj@misc$gene_id_type    <- id_type
  seurat_obj@misc$unmapped_genes  <- original_ids[original_ids == new_names]

  # 确保基因名唯一（多个 Ensembl ID 可能映射到同一 symbol）
  new_names <- make.unique(new_names)

  # 替换所有 assay 的 rownames（直接操作 Assay5 的 features 和 layers）
  for (assay_name in Seurat::Assays(seurat_obj)) {
    assay_obj <- seurat_obj[[assay_name]]
    # 更新 features 行名（Assay5 的 rownames 存储在这里）
    rownames(assay_obj@features) <- new_names
    # 更新每个 layer 矩阵的行名
    for (ln in names(assay_obj@layers)) {
      mat <- assay_obj@layers[[ln]]
      if (!is.null(mat) && nrow(mat) > 0) {
        rownames(mat) <- new_names
        assay_obj@layers[[ln]] <- mat
      }
    }
    seurat_obj[[assay_name]] <- assay_obj
  }

  n_mapped <- sum(original_ids != new_names | !grepl("^ENS", new_names))
  n_total <- length(original_ids)
  message(sprintf("基因名转换完成 (%s → symbol): %d/%d 个 ID 成功映射", id_type, n_mapped, n_total))

  seurat_obj
}


#' 双向查找基因名（任意 ID ↔ Symbol）
#'
#' @param gene_query character, 用户输入的基因名
#' @param seurat_obj Seurat object
#' @return character resolved gene name, or NULL if not found
lookup_gene_symbol <- function(gene_query, seurat_obj) {
  if (is.null(gene_query) || nchar(gene_query) == 0) return(NULL)

  current_rownames <- rownames(seurat_obj)

  # 1. 直接匹配
  if (gene_query %in% current_rownames) return(gene_query)

  # 2. 大小写不敏感匹配
  idx <- which(tolower(current_rownames) == tolower(gene_query))
  if (length(idx) > 0) return(current_rownames[idx[1]])

  # 3. 查找映射表（支持所有 ID 类型的反向查找）
  id_map <- seurat_obj@misc$gene_id_map
  if (!is.null(id_map)) {
    # 用户输入原始 ID → 查 symbol
    clean_query <- sub("\\.[0-9]+$", "", gene_query)
    if (clean_query %in% names(id_map)) return(id_map[[clean_query]])

    # 用户输入 symbol → 反向查原始 ID
    reverse_idx <- which(tolower(id_map) == tolower(gene_query))
    if (length(reverse_idx) > 0) {
      orig_id <- names(id_map)[reverse_idx[1]]
      if (orig_id %in% current_rownames) return(orig_id)
      return(id_map[[orig_id]])
    }
  }

  # 4. 模糊匹配（唯一前缀匹配）
  fuzzy_idx <- which(grepl(paste0("^", toupper(gene_query)), toupper(current_rownames)))
  if (length(fuzzy_idx) == 1) return(current_rownames[fuzzy_idx])

  NULL
}
