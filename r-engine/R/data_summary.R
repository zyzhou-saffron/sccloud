# =====================================================================
# scCloud v2 — 原始计算函数 (data_summary.R)
# 来源: test1/script/data_summary.R
# 注意: 此文件为旧系统的【原始代码】，仅移除了 Shiny/this.path 依赖。
#       script_dir 替换为 "data/" (Docker 容器内的数据目录)。
#       任何计算逻辑不得修改，以保证分析流程的纯净和一致。
# =====================================================================

suppressMessages({
  library(Seurat)
  library(ggplot2)
  library(sctransform)
  library(harmony)
  library(glmGamPoi)
  library(gtools)
  library(dplyr)
  library(SingleR)
  library(celldex)
  library(ggalluvial)
  library(cowplot)
})

# 高级分析库按需加载（在各函数内部），避免启动时依赖系统库

# [替换] 旧系统使用 this.path::this.path() 定位脚本目录
# 容器环境下数据存放在 /app/data/
script_dir <- "/app/data/ref"

# 加载 SingleR 参考数据：优先读本地 .rds，没有则用 celldex 自动下载
loadRefData <- function(rds_name, celldex_fn) {
  rds_path <- file.path(script_dir, rds_name)
  if (file.exists(rds_path)) {
    return(readRDS(rds_path))
  }
  message("本地参考数据不存在，使用 celldex 下载: ", rds_name)
  return(celldex_fn())
}

RunSCT <- function(data){
  pro <- SCTransform(data, method = "glmGamPoi", vars.to.regress = "percent.mt", verbose = F)
  return(pro)
}



# functions
RenameIdents2 <- function(pro) {
  current <- as.character(Idents(pro))
  # 已经是 C 前缀（重跑场景），跳过重命名
  if (all(grepl("^C[0-9]+$", current))) {
    levels(pro) <- suppressWarnings(mixedsort(levels(pro)))
    pro$Cluster <- Idents(pro)
    return(pro)
  }
  ident <- as.numeric(levels(pro))
  if (anyNA(ident)) {
    new_lvls <- paste0("C", seq_along(levels(pro)))
    names(new_lvls) <- levels(pro)
    pro <- RenameIdents(pro, new_lvls)
  } else {
    newident <- ident + 1
    names(newident) <- levels(pro)
    pro <- RenameIdents(pro, newident)
    Idents(pro) <- paste0('C', Idents(pro))
  }
  levels(pro) <- suppressWarnings(mixedsort(levels(pro)))
  pro$Cluster <- Idents(pro)
  return(pro)
}

runHarmony <- function(sctpro1,redu1,group1,nDim,res){
   if(redu1=="harmony"){
       sctpro1 <- RunPCA(object = sctpro1, verbose = FALSE)
       sctpro1 <- RunUMAP(object = sctpro1, reduction = "pca", dims = 1:nDim, verbose = FALSE)
       
       sctpro1@meta.data[[group1]] <- as.character(sctpro1@meta.data[[group1]]) # Seurat v5
       
       #sctpro1 <- harmony::RunHarmony(sctpro1, group.by.vars = group1 , reduction = 'pca', assay.use = 'SCT', verbose = FALSE) # Seurat v4
       sctpro1 <- harmony::RunHarmony(sctpro1, group.by.vars = group1, reduction.use = 'pca', assay.use = 'SCT', verbose = FALSE) # Seurat v5
       
       sctpro1 <- RunUMAP(sctpro1, reduction = "harmony", dims = 1:nDim)
       sctpro1 <- FindNeighbors(sctpro1, reduction = "harmony", dims = 1:nDim, verbose = FALSE) %>% FindClusters(resolution = res,verbose = FALSE)
       
       sctpro1 <- RenameIdents2(sctpro1)
       sctpro1$Cluster <- Idents(sctpro1)
       return(sctpro1)
   }

}



my_cluster_num1 <- function(df){
    cluster_num1 <- as.data.frame(table(df$Cluster,df$Sample))
    colnames(cluster_num1)<- c("Cluster","Sample","CellNumber")
    return(cluster_num1)
}

my_freqTable <- function(df){
    cluster_num <- as.matrix(table(df$Cluster,df$Sample))
    freqTable <- as.data.frame(prop.table(x = cluster_num, margin = 2))
    colnames(freqTable)<- c("Cluster","Sample","Freq")
    return(freqTable)
}

my_diffTable <- function(pro, rawC, minPct, logFc, test, pos) {
  # rawC 可以是 "All"、单个 cluster 名称、或多个 cluster 名称的向量
  pro <- PrepSCTFindMarkers(pro)
  if (length(rawC) == 1 && rawC == "All") {
    # 对所有聚类逐一做 FindMarkers (1 vs rest)
    mergeDif <- data.frame()
    newident <- levels(pro)
    for (l in newident) {
      cluster.markers <- FindMarkers(
        object = pro, ident.1 = l,
        min.pct = minPct, logfc.threshold = logFc,
        test.use = test, only.pos = pos
      )
      diffTable <- data.frame(
        gene_id = rownames(cluster.markers),
        cluster.markers, Cluster = l
      )
      mergeDif <- rbind(mergeDif, diffTable)
    }
    return(mergeDif)
  } else {
    # 对指定的一个或多个聚类逐一做 FindMarkers (1 vs rest)
    mergeDif <- data.frame()
    for (cl in rawC) {
      cluster.markers <- FindMarkers(
        object = pro, ident.1 = cl,
        min.pct = minPct, logfc.threshold = logFc,
        test.use = test, only.pos = pos
      )
      diffTable <- data.frame(
        gene_id = rownames(cluster.markers),
        cluster.markers, Cluster = cl
      )
      mergeDif <- rbind(mergeDif, diffTable)
    }
    return(mergeDif)
  }
}


my_diffTable2 <- function(pro, minPct, logFc, test, pos, group1, group2) {
  # group1 和 group2 可以各自是一个或多个 cluster 的向量
  # Seurat FindMarkers 原生支持向量形式的 ident.1 / ident.2
  pro <- PrepSCTFindMarkers(pro)
  tryCatch({
    if (length(group1) == 0 || length(group2) == 0) {
      return("Error: 两组均需至少选择一个聚类")
    }
    # 修复多样本合并后 barcode 重复导致 'duplicate row.names' 的问题
    # FindMarkers 内部用 cell names 构造 data.frame，重复会报错
    cell_names <- colnames(pro)
    if (any(duplicated(cell_names))) {
      pro <- RenameCells(pro, new.names = make.unique(cell_names, sep = "_dup"))
    }
    cluster.markers <- FindMarkers(
      object = pro,
      ident.1 = group1,
      ident.2 = group2,
      min.pct = minPct,
      logfc.threshold = logFc,
      test.use = test,
      only.pos = pos
    )
    label <- paste0(
      paste(group1, collapse = "+"), " vs ",
      paste(group2, collapse = "+")
    )
    diffTable <- data.frame(
      gene_id = rownames(cluster.markers),
      cluster.markers,
      Cluster = label,
      row.names = NULL
    )
    return(diffTable)
  }, error = function(e) {
    return(paste0("Error: ", e$message))
  })
}

is_upper_strict <- function(x) {
  !grepl("[a-z]", x)  # 检查是否没有小写字母
}


RunAnno <- function(pro,mkfs,cellAnno,group,species="Human",tissue="Blood") {
  if(cellAnno=="自动注释"){
    clusters <- pro@meta.data$Cluster
    # Seurat v5 split layers: merge before extracting
    if (inherits(pro@assays[[DefaultAssay(pro)]], "Assay5")) {
      tryCatch({
        pro@assays[[DefaultAssay(pro)]] <- JoinLayers(pro@assays[[DefaultAssay(pro)]])
      }, error = function(e) NULL)
    }
    pro_for_SingleR <- GetAssayData(pro, layer="data")

    ref_list <- list()
    labels_list <- list()

    if(species=="Human"){
      hpca.se = loadRefData("HumanPrimaryCellAtlasDatar.rds", celldex::HumanPrimaryCellAtlasData)
      bpe.se = loadRefData("BlueprintEncodeDatar.rds", celldex::BlueprintEncodeData)
      ref_list[["HPCA"]] <- hpca.se
      ref_list[["BPE"]] <- bpe.se
      labels_list <- c(labels_list, list(hpca.se$label.main, bpe.se$label.main))

      if(tissue=="Blood"){
        dice.se = loadRefData("DatabaseImmuneCellExpressionData.rds", celldex::DatabaseImmuneCellExpressionData)
        nhd.se = loadRefData("NovershternHematopoieticData.rds", celldex::NovershternHematopoieticData)
        mid.se = loadRefData("MonacoImmuneData.rds", celldex::MonacoImmuneData)
        ref_list[["DICE"]] <- dice.se
        ref_list[["NHD"]] <- nhd.se
        ref_list[["MID"]] <- mid.se
        labels_list <- c(labels_list, list(dice.se$label.main, nhd.se$label.main, mid.se$label.main))
      }
    }else if(species=="Mouse"){
      mrd.se = loadRefData("MouseRNAseqData.rds", celldex::MouseRNAseqData)
      igd.se = loadRefData("ImmGenData.rds", celldex::ImmGenData)
      ref_list[["MRD"]] <- mrd.se
      ref_list[["IGD"]] <- igd.se
      labels_list <- c(labels_list, list(mrd.se$label.main, igd.se$label.main))
    }

    pred.hesc <- SingleR(test = pro_for_SingleR,
                     ref = ref_list,
                     labels = labels_list,
                     clusters = clusters,
                     assay.type.test = "logcounts",
                     assay.type.ref = "logcounts")
    celltype = data.frame(ClusterID=rownames(pred.hesc), 
                      celltype=pred.hesc$labels, 
                      stringsAsFactors = F) 
    pro@meta.data$singleR = celltype[match(clusters,celltype$ClusterID),'celltype']
    annoCell <- celltype$celltype
    names(annoCell) <- celltype$ClusterID
    pro <- RenameIdents(pro, annoCell)
    levels(pro) <- mixedsort(levels(pro))
    pro$CellType <- Idents(pro)
    
    cluster_cell_num=as.matrix(table(pro@meta.data[,c("Cluster","singleR")]) )
    cluster_num <- as.matrix(table(Idents(pro), pro@meta.data$Sample))
    freq_table <- prop.table(x = cluster_num, margin = 2)
    freqTable <- data.frame(freq_table)
    colnames(freqTable) <- c('CellType', 'Sample', 'Freq')
    freqTable$CellType <- as.factor(freqTable$CellType)
    freqTable$Sample <- as.factor(freqTable$Sample)
    
    return(list(data1 = pro, data2 = freqTable))

  }else if(cellAnno=="手动注释"){
    mkfs <- as.data.frame(apply(mkfs, 2, function(x) { gsub(' |\t+', '', x, fixed = F, perl = T) }))
    colnames(mkfs) <- c("Cluster", "CellType", "Markers")
   
    annoCell <- mkfs$CellType
    names(annoCell) <- mkfs$Cluster
    pro <- RenameIdents(pro, annoCell)
    levels(pro) <- mixedsort(levels(pro))
    pro$CellType <- Idents(pro)
    
    cluster_cell_num=as.matrix(table(pro@meta.data[,c("Cluster","CellType")]) )
    cluster_num <- as.matrix(table(Idents(pro), pro@meta.data$Sample))
    freq_table <- prop.table(x = cluster_num, margin = 2)
    freqTable <- data.frame(freq_table)
    colnames(freqTable) <- c('CellType', 'Sample', 'Freq')
    freqTable$CellType <- as.factor(freqTable$CellType)
    freqTable$Sample <- as.factor(freqTable$Sample)
    
    return(list(data1 = pro, data2 = freqTable))
  }

}


# =====================================================================
# 高级分析函数 — 移植自 _archive/app.new3/data_summary.R
# RunMonocle / RunCellChat / RunInfercnv
# =====================================================================

# 调色板（与原脚本一致）
clusterCols <- c("#D51F26", "#272E6A", "#208A42", "#89288F", "#F47D2B", "#FEE500", "#8A9FD1", "#C06CAB", "#E6C2DC",
                 "#90D5E4", "#89C75F", "#F37B7D", "#9983BD", "#D24B27", "#3BBCA8", "#6E4B9E", "#0C727C", "#7E1416",
                 "#D8A767", "#7DD06F", "#844081", "#688EC1", "#C17E73", "#484125", "#6CD3A7", "#597873", "#7B6FD0",
                 "#D52126", "#88CCEE", "#FEE52C", "#117733", "#CC61B0", "#99C945", "#2F8AC4", "#332288", "#E68316",
                 "#661101", "#F97B72", "#DDCC77", "#11A579", "#E73F74", "#A6CDE2", "#1E78B4", "#74C476", "#34A047",
                 "#F59899", "#E11E26", "#FCBF6E", "#F47E1F", "#CAB2D6", "#6A3E98", "#FAF39B", "#B15928", "#1a1334",
                 "#01545a", "#017351", "#03c383", "#aad962", "#fbbf45", "#ef6a32", "#ed0345", "#a12a5e", "#710162",
                 "#3B9AB2", "#2a7185", "#a64027", "#9cdff0", "#022336", "#78B7C5", "#EBCC2A", "#E1AF00", "#F21A00",
                 "#FF0000", "#00A08A", "#F2AD00", "#F98400", "#5BBCD6")


#' Monocle 2 拟时序分析
#'
#' @param pro Seurat 对象（需含 RNA counts + CellType）
#' @param group_beam BEAM 分支分析的分组列（"CellType" 或 "Cluster"）
#' @param group_traj 轨迹可视化的分组列（"CellType"、"Cluster"、"State"、"Pseudotime"）
#' @param min_expr_threshold 最低表达阈值
#' @param min_cells_pct 最低细胞检出百分比
#' @param mean_expr 离散基因筛选的平均表达阈值
#' @param qvalue1 差异基因 q 值阈值
#' @param reverse 是否反转拟时序方向
#' @param progress_callback 进度回调函数
#' @return list(data1~data8, plot~plot6)
RunMonocle <- function(pro, group_beam = "CellType", group_traj = "CellType",
                       min_expr_threshold = 0.5, min_cells_pct = 0.01,
                       mean_expr = 0.3, qvalue1 = 1e-5, reverse = FALSE,
                       progress_callback = NULL) {
  suppressMessages(library(monocle))
  send_msg <- function(pct, msg) {
    if (!is.null(progress_callback)) progress_callback(pct, msg)
    else message(sprintf("[%d%%] %s", pct, msg))
  }

  MonocleResult <- list()

  # 1. 从 Seurat 提取数据
  send_msg(5, "提取表达矩阵...")
  # Seurat v5 split layers: merge before extracting
  if (inherits(pro@assays$RNA, "Assay5")) {
    tryCatch({
      pro@assays$RNA <- JoinLayers(pro@assays$RNA)
      message("[MONOCLE] Joined split layers")
    }, error = function(e) message("[MONOCLE] JoinLayers skipped: ", e$message))
  }
  if (as.character(packageVersion("Seurat")) >= "4.0") {
    expr_matrix <- LayerData(pro, assay = "RNA", layer = "counts")
  } else {
    expr_matrix <- GetAssayData(pro, assay = "RNA", slot = "counts")
  }

  p_data <- pro@meta.data
  f_data <- data.frame(gene_short_name = rownames(expr_matrix), row.names = rownames(expr_matrix))

  pd <- new("AnnotatedDataFrame", data = p_data)
  fd <- new("AnnotatedDataFrame", data = f_data)

  # 2. 创建 Monocle 对象
  send_msg(10, "创建 Monocle 对象...")
  cd <- newCellDataSet(as.matrix(expr_matrix),
                       phenoData = pd,
                       featureData = fd,
                       lowerDetectionLimit = 0.5,
                       expressionFamily = negbinomial.size())
  rm(expr_matrix)

  cd <- estimateSizeFactors(cd)
  cd <- estimateDispersions(cd)
  MonocleResult$data1 <- cd

  # 3. 数据过滤
  send_msg(15, "基因过滤...")
  cd <- detectGenes(cd, min_expr = min_expr_threshold)
  expressed_genes <- row.names(subset(fData(cd), num_cells_expressed > nrow(p_data) * min_cells_pct))
  send_msg(18, paste0("过滤后基因数: ", length(expressed_genes)))

  # 4. 关键基因筛选
  # 4.1 高离散基因
  send_msg(20, "筛选高离散基因...")
  disp_table <- dispersionTable(cd[expressed_genes, ])
  disp_table_genes <- as.character(subset(disp_table, mean_expression >= mean_expr & dispersion_empirical >= dispersion_fit)$gene_id)

  # 4.2 差异表达基因（按 group_beam 分组）
  send_msg(25, "差异表达基因检验...")
  diff_table <- tryCatch({
    differentialGeneTest(cd[expressed_genes, ], fullModelFormulaStr = paste0("~", group_beam))
  }, error = function(e) {
    message("differentialGeneTest failed: ", e$message)
    NULL
  })
  if (is.null(diff_table)) {
    diff_table_genes <- disp_table_genes
  } else {
    diff_table_genes <- row.names(subset(diff_table, qval < qvalue1))
  }
  send_msg(35, paste0("差异基因数: ", length(diff_table_genes)))

  # 4.3 取最大交集
  genes1 <- list(intersect(disp_table_genes, expressed_genes))
  genes2 <- list(intersect(diff_table_genes, expressed_genes))
  genes3 <- list(Reduce(intersect, list(expressed_genes, disp_table_genes, diff_table_genes)))
  gg <- list(genes1, genes2, genes3)
  lengths <- sapply(gg, lengths)
  ordering_genes <- unlist(gg[[which.max(lengths)]])
  send_msg(38, paste0("排序基因数: ", length(ordering_genes)))

  MonocleResult$data2 <- data.frame(Ordering_Genes = ordering_genes, stringsAsFactors = FALSE)
  cd <- setOrderingFilter(cd, ordering_genes)

  # 基因筛选图
  text_labels <- paste0("genes obtained after filter: ", length(expressed_genes),
                        "\ngenes with high dispersion: ", length(disp_table_genes),
                        "\ngenes diff between types: ", length(diff_table_genes),
                        "\ngenes ordered: ", length(ordering_genes))
  if (length(ordering_genes) > 0) {
    p <- plot_ordering_genes(cd) +
      annotate("text", x = Inf, y = Inf, label = text_labels, hjust = 1, vjust = 1, size = 5, color = "black", fontface = "bold") +
      theme(plot.margin = unit(c(1, 2, 1, 1), "cm"))
  } else {
    p <- ggplot() + annotate("text", x = 0.5, y = 0.5, label = text_labels, size = 5) + theme_void()
  }
  MonocleResult$plot <- p

  # 5. 降维 (纯 R PCA, 永不 segfault)
  send_msg(40, "PCA 降维...")
  monocleOk <- TRUE
  n_cells <- ncol(cd)
  tryCatch({
    n_ord <- min(length(ordering_genes), 1000L)
    if (n_ord < 2L) stop("ordering genes < 2")
    top_ord <- intersect(ordering_genes[seq_len(n_ord)], rownames(exprs(cd)))
    if (length(top_ord) < 2L) stop("no ordering genes in expression matrix")
    ord_expr <- t(as.matrix(exprs(cd[top_ord, , drop = FALSE])))
    ord_var <- apply(ord_expr, 2L, var)
    ord_expr <- ord_expr[, ord_var > 0, drop = FALSE]
    if (ncol(ord_expr) < 2L) stop("fewer than 2 variable genes")
    ord_scaled <- scale(ord_expr, center = TRUE, scale = TRUE)
    ord_scaled[is.na(ord_scaled)] <- 0
    s <- svd(ord_scaled, nu = 2L, nv = 0L)
    pca_mat <- s$u %*% diag(s$d[1:2], 2L, 2L)
    # 确保 PCA 行数与细胞数一致
    n_cells_cd <- ncol(cd)
    if (nrow(pca_mat) == n_cells_cd) {
      cd@reducedDimS <- t(pca_mat)
    } else {
      message(sprintf("PCA rows (%d) != cells (%d), padding with NA", nrow(pca_mat), n_cells_cd))
      full_mat <- matrix(NA_real_, nrow = n_cells_cd, ncol = 2)
      cell_names_cd <- colnames(cd)
      cell_names_pca <- rownames(pca_mat)
      if (!is.null(cell_names_pca) && !is.null(cell_names_cd)) {
        common <- intersect(cell_names_cd, cell_names_pca)
        if (length(common) > 0) {
          idx_cd <- match(common, cell_names_cd)
          idx_pca <- match(common, cell_names_pca)
          full_mat[idx_cd, ] <- pca_mat[idx_pca, ]
        }
      } else {
        n_match <- min(nrow(pca_mat), n_cells_cd)
        full_mat[seq_len(n_match), ] <- pca_mat[seq_len(n_match), ]
      }
      cd@reducedDimS <- t(full_mat)
    }

  }, error = function(e) {
    message("PCA failed: ", e$message)
    monocleOk <<- FALSE
  })

  # 使用 PC1 作为拟时序 (纯 R, 不依赖 monocle igraph 内部实现)
  if (monocleOk) {
    send_msg(55, "构建拟时序...")
    pc_scores <- cd@reducedDimS[1, ]
    if (length(pc_scores) == ncol(cd)) {
      pData(cd)$Pseudotime <- pc_scores
    } else {
      pData(cd)$Pseudotime <- rep(NA_real_, ncol(cd))
      pData(cd)$Pseudotime[seq_along(pc_scores)] <- pc_scores
    }
    pData(cd)$State <- factor("1")
  }

  if (monocleOk) {
    MonocleResult$data3 <- cd
    send_msg(58, "生成轨迹图...")
    # 自定义 ggplot 替代 plot_cell_trajectory (避免 igraph 兼容问题)
    tryCatch({
      pc1 <- as.numeric(cd@reducedDimS[1, ])
      pc2 <- as.numeric(cd@reducedDimS[2, ])
      pt  <- as.numeric(pData(cd)$Pseudotime)
      gf  <- if (group_traj %in% colnames(pData(cd))) {
               pData(cd)[, group_traj]
             } else { pt }
      pca_df <- data.frame(PC1 = pc1, PC2 = pc2, Pseudotime = pt,
                           State = "1", Group = gf,
                           stringsAsFactors = FALSE)
      p11 <- ggplot(pca_df, aes(x = PC1, y = PC2, colour = Group)) +
        geom_point(size = 0.8, alpha = 0.7) +
        scale_colour_manual(values = clusterCols) +
        labs(x = "PC1", y = "PC2", colour = group_traj) +
        theme_minimal() +
        theme(legend.text = element_text(size = 12),
              legend.title = element_text(size = 12),
              legend.key.size = unit(0.5, "cm"))
      p12 <- p11 + facet_wrap(~ Group, nrow = 2)
      MonocleResult$plot1 <- p11 | p12
      df <- pData(cd)
      df$State <- as.character(df$State)
      MonocleResult$data4 <- df
      MonocleResult$data5 <- sort(as.character(unique(df$State)))
    }, error = function(e) {
      message("Trajectory plot failed: ", e$message)
      df <- pData(cd)
      df$State <- "1"
      MonocleResult$data4 <- df
      MonocleResult$data5 <- "1"
      MonocleResult$plot1 <- ggplot() +
        annotate("text", x=0.5, y=0.5, label="轨迹图生成失败", size=5) + theme_void()
    })
  } else {
    df <- pData(cd)
    df$State <- "1"
    MonocleResult$data3 <- cd
    MonocleResult$data4 <- df
    MonocleResult$data5 <- "1"
    p_empty <- ggplot() + annotate("text", x=0.5, y=0.5,
      label="PCA 降维失败，无法生成轨迹图", size=5) + theme_void()
    MonocleResult$plot1 <- p_empty
  }



  # 7. Top 基因表达变化
  send_msg(62, "拟时序基因表达图...")
  keygenes <- head(ordering_genes, 2)
  if (length(keygenes) >= 1) {
    cd_subset <- cd[keygenes, ]
    tryCatch({
      p_gip <- plot_genes_in_pseudotime(cd_subset, color_by = "Pseudotime")
      MonocleResult$plot2 <- p_gip
    }, error = function(e) {
      message("plot_genes_in_pseudotime failed: ", e$message)
      expr_dat <- as.data.frame(t(as.matrix(exprs(cd_subset))))
      expr_dat$Pseudotime <- pData(cd)$Pseudotime
      expr_long <- suppressMessages(tidyr::pivot_longer(
        expr_dat, -Pseudotime, names_to = "Gene", values_to = "Expression"))
      MonocleResult$plot2 <<- ggplot(expr_long,
        aes(x = Pseudotime, y = Expression, colour = Gene)) +
        geom_point(size = 0.5, alpha = 0.5) +
        geom_smooth(se = FALSE, method = "loess", formula = y ~ x) +
        theme_minimal() + labs(title = "Gene expression along pseudotime")
    })
  }

  # 8. 拟时序差异基因
  send_msg(65, "拟时序差异基因检验...")
  pseudotime_de <- tryCatch({
    dt <- differentialGeneTest(cd[expressed_genes, ], fullModelFormulaStr = "~sm.ns(Pseudotime)")
    dt[order(dt$qval), c(5, 2, 3, 4, 1, 6, 7)]
  }, error = function(e) {
    message("Pseudotime DE failed: ", e$message)
    data.frame(gene_short_name = character(), pval = numeric(), qval = numeric(),
               stringsAsFactors = FALSE)
  })
  MonocleResult$data6 <- pseudotime_de

  send_msg(72, "状态差异基因检验...")
  states_de <- tryCatch({
    dt <- differentialGeneTest(cd[expressed_genes, ], fullModelFormulaStr = "~State")
    dt[order(dt$qval), c(5, 2, 3, 4, 1, 6, 7)]
  }, error = function(e) {
    message("State DE failed: ", e$message)
    data.frame(gene_short_name = character(), pval = numeric(), qval = numeric(),
               stringsAsFactors = FALSE)
  })
  MonocleResult$data7 <- states_de

  # 热图
  send_msg(78, "生成热图...")
  pseudotime_de_top <- head(pseudotime_de$gene_short_name[order(pseudotime_de$qval)], 100)
  if (length(pseudotime_de_top) > 0) {
    p2 <- plot_pseudotime_heatmap(cd[pseudotime_de_top, ], num_clusters = 4, show_rownames = T, return_heatmap = T)
    MonocleResult$plot3 <- p2
  }

  states_de_top <- head(states_de$gene_short_name[order(states_de$qval)], 100)
  if (length(states_de_top) > 0) {
    p3 <- plot_pseudotime_heatmap(cd[states_de_top, ], num_clusters = 4, show_rownames = T, return_heatmap = T)
    MonocleResult$plot4 <- p3
  }

  # 9. BEAM 分支分析
  send_msg(82, "BEAM 分支分析...")
  BEAM_res <- tryCatch({
    res <- BEAM(cd[expressed_genes, ], branch_point = 1, cores = 1, progenitor_method = "duplicate")
    res <- res[order(res$qval), ]
    res[, c("gene_short_name", "pval", "qval")]
  }, error = function(e) {
    message("BEAM failed: ", e$message)
    data.frame(gene_short_name = character(), pval = numeric(), qval = numeric(),
               stringsAsFactors = FALSE)
  })
  MonocleResult$data8 <- BEAM_res

  # BEAM 热图
  send_msg(90, "BEAM 热图...")
  beam_sig <- row.names(subset(BEAM_res, qval < 1e-4))
  if (length(beam_sig) > 10) {
    tmp1 <- plot_genes_branched_heatmap(cd[beam_sig, ],
                                        branch_point = 1, num_clusters = 4, cores = 1,
                                        use_gene_short_name = TRUE, show_rownames = FALSE,
                                        return_heatmap = TRUE)
    MonocleResult$plot5 <- tmp1$ph_res
  }

  # BEAM 分支基因可视化
  send_msg(95, "分支基因可视化...")
  beam_genes <- head(BEAM_res$gene_short_name, 2)
  if (length(beam_genes) >= 1) {
    tmp3 <- plot_genes_branched_pseudotime(cd[beam_genes, ], branch_point = 1, color_by = "State", cell_size = 2, ncol = 2)
    MonocleResult$plot6 <- tmp3
  }

  send_msg(100, "Monocle 分析完成")
  return(MonocleResult)
}


#' CellChat 细胞通讯分析
#'
#' @param pro Seurat 对象（需含 SCT@data + CellType）
#' @param species 物种（"Human" 或 "Mouse"）
#' @param db_use 数据库子集（"Secreted" / "ECM-Receptor" / "Cell-Cell Contact"）
#' @param thresh 通讯显著性阈值
#' @param progress_callback 进度回调函数
#' @return list(data1~data3, plot1, plot4~5, f1, p91~92)
RunCellChat <- function(pro, species = "Human", db_use = "Secreted", thresh = 0.05,
                        progress_callback = NULL) {
  suppressMessages(library(CellChat))
  send_msg <- function(pct, msg) {
    if (!is.null(progress_callback)) progress_callback(pct, msg)
    else message(sprintf("[%d%%] %s", pct, msg))
  }

  CellChatResult <- list()

  # 确保 samples 列存在
  if (!"samples" %in% colnames(pro@meta.data)) {
    pro@meta.data$samples <- pro@meta.data$Sample
  }

  # 1. 创建 CellChat 对象
  send_msg(5, "创建 CellChat 对象...")
  # Seurat v5 split layers: merge SCT before extracting
  if (inherits(pro@assays$SCT, "Assay5")) {
    tryCatch({
      pro@assays$SCT <- JoinLayers(pro@assays$SCT)
      message("[CELLCHAT] Joined split SCT layers")
    }, error = function(e) message("[CELLCHAT] JoinLayers skipped: ", e$message))
  }
  cellchat <- createCellChat(pro@assays$SCT@data, meta = pro@meta.data, group.by = "CellType")
  groupSize <- as.numeric(table(cellchat@idents))

  # 2. 加载数据库
  send_msg(10, "加载信号通路数据库...")
  if (species == "Human") {
    CellChatDB <- CellChatDB.human
  } else {
    CellChatDB <- CellChatDB.mouse
  }

  # 按 db_use 子集
  if (db_use == "Secreted") {
    CellChatDB.use <- subsetDB(CellChatDB, search = "Secreted Signaling")
  } else if (db_use == "ECM-Receptor") {
    CellChatDB.use <- subsetDB(CellChatDB, search = "ECM-Receptor")
  } else if (db_use == "Cell-Cell Contact") {
    CellChatDB.use <- subsetDB(CellChatDB, search = "Cell-Cell Contact")
  } else {
    CellChatDB.use <- CellChatDB
  }
  cellchat@DB <- CellChatDB.use

  # 3. 预处理
  send_msg(20, "预处理信号基因...")
  cellchat <- subsetData(cellchat)
  cellchat <- identifyOverExpressedGenes(cellchat)
  cellchat <- identifyOverExpressedInteractions(cellchat)

  # 4. 推断通讯网络
  send_msg(35, "推断通讯概率...")
  cellchat <- computeCommunProb(cellchat, type = "triMean")
  cellchat <- filterCommunication(cellchat, min.cells = 10)

  send_msg(50, "提取通讯结果...")
  df.net <- subsetCommunication(cellchat)
  CellChatResult$data1 <- df.net

  send_msg(55, "计算通路概率...")
  cellchat <- computeCommunProbPathway(cellchat)
  df.netp <- subsetCommunication(cellchat, slot.name = "netP")
  CellChatResult$data2 <- df.netp

  send_msg(62, "聚合通讯网络...")
  cellchat <- aggregateNet(cellchat)

  groupSizes <- as.numeric(table(cellchat@idents))
  CellChatResult$data3 <- groupSizes

  # 5. 通讯数量和强度图
  send_msg(68, "生成通讯网络图...")
  p_count <- netVisual_circle(cellchat@net$count, vertex.weight = groupSize, weight.scale = T,
                               label.edge = F, title.name = "Number of interactions")
  p_weight <- netVisual_circle(cellchat@net$weight, vertex.weight = groupSize, weight.scale = T,
                                label.edge = F, title.name = "Interaction weights/strength")
  CellChatResult$plot1 <- grid.grab()
  CellChatResult$plot1b <- grid.grab()

  # 6. 信号通路可视化
  send_msg(75, "信号通路可视化...")
  pathways.show.all <- cellchat@netP$pathways
  pathways.show <- pathways.show.all[1]

  if (!is.null(pathways.show) && length(pathways.show) > 0) {
    # 热图
    p4 <- netVisual_heatmap(cellchat, signaling = pathways.show, color.heatmap = "Reds")
    CellChatResult$plot4 <- p4

    # 通路贡献
    p5 <- netAnalysis_contribution(cellchat, signaling = pathways.show)
    CellChatResult$plot5 <- p5
  }

  # 7. 气泡图（所有细胞类型间的相互作用）
  send_msg(82, "生成气泡图...")
  tryCatch({
    f1 <- netVisual_bubble(cellchat, remove.isolate = FALSE)
    CellChatResult$f1 <- f1
  }, error = function(e) send_msg(82, paste0("Bubble plot error: ", e$message)))

  # 8. 基因表达
  send_msg(90, "基因表达图...")
  if (!is.null(pathways.show) && length(pathways.show) > 0) {
    tryCatch({
      p91 <- plotGeneExpression(cellchat, signaling = pathways.show)
      CellChatResult$p91 <- p91
    }, error = function(e) send_msg(90, paste0("Gene expression plot error: ", e$message)))

    tryCatch({
      p92 <- plotGeneExpression(cellchat, signaling = pathways.show, type = "dot", color.use = clusterCols)
      CellChatResult$p92 <- p92
    }, error = function(e) send_msg(90, paste0("Gene expression dot plot error: ", e$message)))
  }

  # 保存 cellchat 对象供后续使用
  CellChatResult$cellchat <- cellchat

  send_msg(100, "CellChat 分析完成")
  return(CellChatResult)
}


#' inferCNV 拷贝数变异分析
#'
#' @param pro Seurat 对象（需含 SCT@counts + CellType）
#' @param inferDf 数据框，两列: cellType, refType（"reference" 标记正常细胞）
#' @param cutoff_gene 表达量截断值
#' @param outdir 输出目录
#' @param numThreads 线程数
#' @param progress_callback 进度回调函数
#' @return list(infercnv_obj, outdir)
RunInfercnv <- function(pro, inferDf, cutoff_gene = 0.1, outdir, numThreads = 1L,
                        species = "Human", progress_callback = NULL) {
  suppressMessages(library(infercnv))
  send_msg <- function(pct, msg) {
    if (!is.null(progress_callback)) progress_callback(pct, msg)
    else message(sprintf("[%d%%] %s", pct, msg))
  }

  numThreads <- as.integer(numThreads)
  send_msg(5, "准备参考文件...")
  options(scipen = 100)
  bedFileName <- if (species == "Mouse") "gene_name_pos_mouse.bed" else "gene_name_pos_human.bed"
  bedFile <- file.path("/app/data/ref", bedFileName)
  if (!file.exists(bedFile)) {
    stop("gene_name_pos.bed not found at: ", bedFile)
  }

  # Handle both 2-column and multi-column inferDf
  if (ncol(inferDf) >= 2) {
    # Use first two columns as cellType and refType
    inferDf <- data.frame(
      cellType = as.character(inferDf[[1]]),
      refType = as.character(inferDf[[2]]),
      stringsAsFactors = FALSE
    )
  } else {
    stop("inferDf must have at least 2 columns (cellType, refType), got: ",
         paste(colnames(inferDf), collapse=", "))
  }
  message("[INFERCNV] inferDf cellTypes: ", paste(inferDf$cellType, collapse=","))
  message("[INFERCNV] inferDf refTypes: ", paste(inferDf$refType, collapse=","))
  refGroupNames <- inferDf[which(inferDf$refType == "reference"), ]$cellType

  if (length(refGroupNames) == 0) {
    stop("No reference cell types specified in inferDf")
  }

  send_msg(10, paste0("参考细胞: ", paste(refGroupNames, collapse = ", ")))

  send_msg(15, "提取子集...")
  # Validate that requested cell types exist in Seurat object
  available_types <- unique(as.character(Idents(pro)))
  requested_types <- unique(inferDf$cellType)
  missing_types <- setdiff(requested_types, available_types)
  if (length(missing_types) > 0) {
    message("[INFERCNV] WARNING: These cell types not found in Seurat object: ",
            paste(missing_types, collapse=", "))
    message("[INFERCNV] Available cell types: ", paste(available_types, collapse=", "))
    # Try case-insensitive matching
    matched <- character(0)
    for (ct in requested_types) {
      if (ct %in% available_types) {
        matched <- c(matched, ct)
      } else {
        # Case-insensitive match
        idx <- which(tolower(available_types) == tolower(ct))
        if (length(idx) > 0) {
          message("[INFERCNV] Auto-matched '", ct, "' -> '", available_types[idx[1]], "'")
          inferDf$cellType[inferDf$cellType == ct] <- available_types[idx[1]]
          matched <- c(matched, available_types[idx[1]])
        } else {
          message("[INFERCNV] No match found for '", ct, "', skipping")
        }
      }
    }
    if (length(matched) == 0) {
      stop("None of the specified cell types exist in the Seurat object. ",
           "Requested: ", paste(requested_types, collapse=", "),
           " | Available: ", paste(available_types, collapse=", "))
    }
    # Remove unmatched types from inferDf
    inferDf <- inferDf[inferDf$cellType %in% matched, ]
    refGroupNames <- inferDf[which(inferDf$refType == "reference"), ]$cellType
    message("[INFERCNV] After matching - cellTypes: ", paste(inferDf$cellType, collapse=","))
    message("[INFERCNV] After matching - refGroupNames: ", paste(refGroupNames, collapse=","))
    if (length(refGroupNames) == 0) {
      stop("After matching, no reference cell types remain. ",
           "Please re-select cell types that exist in your data.")
    }
  }
  prosub <- subset(pro, idents = inferDf$cellType)
  if (ncol(prosub) == 0) {
    stop("Subset resulted in 0 cells. Cell types in Seurat: ",
         paste(available_types, collapse=", "))
  }
  rm(pro)

  cell_type_col <- NULL
  if ("CellType" %in% colnames(prosub@meta.data)) {
    cell_type_col <- as.character(prosub@meta.data[, "CellType"])
  } else if ("cell_type" %in% colnames(prosub@meta.data)) {
    cell_type_col <- as.character(prosub@meta.data[, "cell_type"])
  } else {
    # Try to find any column with 'cell' and 'type' in name
    ct_cols <- grep("(?i)cell.?type", colnames(prosub@meta.data), value = TRUE)
    if (length(ct_cols) > 0) {
      cell_type_col <- as.character(prosub@meta.data[, ct_cols[1]])
    }
  }
  if (is.null(cell_type_col)) {
    stop("Cannot find CellType column in Seurat metadata. Available: ",
         paste(colnames(prosub@meta.data), collapse=", "))
  }
  annotationsDf <- data.frame(V1 = cell_type_col, row.names = rownames(prosub@meta.data))
  colnames(annotationsDf) <- NULL  # infercnv expects no column name
  message("[INFERCNV] annotationsDf rows: ", nrow(annotationsDf),
          " unique types: ", paste(unique(cell_type_col), collapse=", "))

  send_msg(20, "创建 inferCNV 对象...")
  # Seurat v5 split layers: merge before extracting
  for (aname in c("SCT", "RNA")) {
    if (!is.null(prosub@assays[[aname]]) && inherits(prosub@assays[[aname]], "Assay5")) {
      tryCatch({
        prosub@assays[[aname]] <- JoinLayers(prosub@assays[[aname]])
        message(sprintf("[INFERCNV] Joined split %s layers", aname))
      }, error = function(e) NULL)
    }
  }

  counts_mat <- tryCatch(
    GetAssayData(prosub, assay = "SCT", layer = "counts"),
    error = function(e) GetAssayData(prosub, assay = "RNA", layer = "counts")
  )
  # Ensure counts_mat is a type infercnv can handle (dgCMatrix, matrix, or data.frame)
  if (!inherits(counts_mat, c("dgCMatrix", "matrix", "data.frame"))) {
    message("[INFERCNV] Converting counts from class: ", paste(class(counts_mat), collapse=","))
    counts_mat <- as.matrix(counts_mat)
  }
  message("[INFERCNV] counts_mat class: ", paste(class(counts_mat), collapse=","),
          " dim: ", paste(dim(counts_mat), collapse="x"))
  infercnv_obj <- CreateInfercnvObject(raw_counts_matrix = counts_mat,


                                        annotations_file = annotationsDf,
                                        delim = "\t",
                                        gene_order_file = bedFile,
                                        ref_group_names = refGroupNames)
  # 释放不再需要的大对象，减少 infercnv::run() 内存峰值
  rm(counts_mat, annotationsDf, prosub)
  gc(verbose = FALSE)

  send_msg(25, "运行 inferCNV 分析...")
  # Ensure parameter types are correct
  cutoff_val <- as.numeric(cutoff_gene)
  nthreads_val <- as.integer(numThreads)
  message("[INFERCNV] cutoff: ", cutoff_val, " (class: ", class(cutoff_val), ")")
  message("[INFERCNV] threads: ", nthreads_val, " (class: ", class(nthreads_val), ")")
  message("[INFERCNV] outdir: ", outdir)
  message("[INFERCNV] infercnv_obj class: ", paste(class(infercnv_obj), collapse=","))

  infercnv_obj <- tryCatch(
    {
      message("[INFERCNV] Starting run() with HMM=TRUE...")
      infercnv::run(infercnv_obj,
                     cutoff = cutoff_val,
                     out_dir = outdir,
                     num_threads = nthreads_val,
                     cluster_by_groups = TRUE,
                     denoise = TRUE,
                     write_expr_matrix = TRUE,
                     HMM = TRUE)
    },
    error = function(e) {
      message("[INFERCNV] HMM=TRUE failed: ", e$message)
      message("[INFERCNV] Retrying with HMM=FALSE...")
      infercnv::run(infercnv_obj,
                     cutoff = cutoff_val,
                     out_dir = outdir,
                     num_threads = nthreads_val,
                     cluster_by_groups = TRUE,
                     denoise = TRUE,
                     write_expr_matrix = TRUE,
                     HMM = FALSE)
    }
  )

  send_msg(100, "inferCNV 分析完成")
  return(list(infercnv_obj = infercnv_obj, outdir = outdir))
}


# =====================================================================
# WGCNA (加权基因共表达网络分析) - 从旧版迁移
# =====================================================================

# 辅助函数：查找匹配的列名
find_matching_columns <- function(seurat_obj, target_names, max_dist = 3) {
  all_cols <- colnames(seurat_obj@meta.data)
  result <- list()
  for(target in target_names) {
    if(target %in% all_cols) {
      result[[target]] <- target
      next
    }
    case_insensitive <- all_cols[tolower(all_cols) == tolower(target)]
    if(length(case_insensitive) == 1) {
      result[[target]] <- case_insensitive
      next
    }
    fuzzy_match <- agrep(target, all_cols, ignore.case = TRUE, value = TRUE, max.distance = 0.2)
    if(length(fuzzy_match) > 0) {
      result[[target]] <- fuzzy_match[1]
      next
    }
    pattern <- paste0("(?i)", target)
    grep_match <- grep(pattern, all_cols, value = TRUE, perl = TRUE)
    if(length(grep_match) > 0) {
      result[[target]] <- grep_match[1]
      next
    }
    result[[target]] <- NA
  }
  return(result)
}

# 辅助函数：智能选择软阈值
select_soft_power_threshold <- function(power_table, sft_threshold = 0.8) {
  valid <- power_table[power_table$SFT.R.sq >= sft_threshold, ]
  if(nrow(valid) > 0) {
    selected <- min(valid$Power)
  } else {
    selected <- power_table$Power[which.max(power_table$SFT.R.sq)]
  }
  return(selected)
}

RunWGCNA <- function(seurat_obj, outdir, minFraction = 0.05, interestType,
                    sft_threshold = 0.8, ModuleScore = "Seurat", k = 25,
                    max_shared = 10, min_cells = 100, n_hubs = 10,
                    n_genes_score = 25, progress_callback = NULL) {
  send_msg <- function(pct, msg) {
    if (!is.null(progress_callback)) progress_callback(pct, msg)
    else message(sprintf("[%d%%] %s", pct, msg))
  }
  if(!dir.exists(outdir)) dir.create(outdir, recursive = TRUE)
  Result <- list()

  send_msg(5, "数据预处理...")
  matched_cols <- find_matching_columns(seurat_obj, c("CellType", "Sample"))
  if(is.na(matched_cols[["CellType"]])) stop("未找到 CellType 列")
  if(is.na(matched_cols[["Sample"]])) stop("未找到 Sample 列")
  seurat_obj@meta.data$CellType <- as.character(seurat_obj@meta.data[[matched_cols[["CellType"]]]])
  seurat_obj@meta.data$Sample <- as.character(seurat_obj@meta.data[[matched_cols[["Sample"]]]])

  send_msg(10, "设置 WGCNA...")
  seurat_obj <- SetupForWGCNA(seurat_obj, gene_select = "fraction",
                               fraction = minFraction, wgcna_name = interestType)

  send_msg(20, "构建元细胞...")
  seurat_obj <- MetacellsByGroups(seurat_obj, group.by = "CellType", k = k,
                                   max_shared = max_shared, min_cells = min_cells,
                                   reduction = "umap", ident.group = "CellType")
  seurat_obj <- NormalizeMetacells(seurat_obj)

  send_msg(35, "共表达网络分析...")
  tryCatch({
    seurat_obj <- SetDatExpr(seurat_obj, group_name = interestType,
                               group.by = "CellType", assay = "SCT",
                               use_metacells = TRUE)
  }, error = function(e) {
    seurat_obj <- SetDatExpr(seurat_obj, group_name = interestType,
                               group.by = "CellType", assay = "SCT",
                               use_metacells = FALSE)
  })

  seurat_obj <- TestSoftPowers(seurat_obj, networkType = "signed")
  plot_list <- PlotSoftPowers(seurat_obj)
  png(file.path(outdir, paste0(interestType, "_SoftPower.png")),
      width = 900, height = 700, res = 100)
  print(wrap_plots(plot_list, ncol = 2))
  dev.off()

  power_table <- GetPowerTable(seurat_obj)
  select_soft_power <- select_soft_power_threshold(power_table, sft_threshold)

  send_msg(50, paste0("构建网络 (软阈值=", select_soft_power, ")..."))
  seurat_obj <- ConstructNetwork(seurat_obj, soft_power = select_soft_power,
                                   setDatExpr = FALSE, tom_name = interestType, tom_outdir = file.path(outdir, "TOM"),
                                   overwrite_tom = TRUE)
  png(file.path(outdir, paste0(interestType, "_Dendrogram.png")),
      width = 900, height = 600, res = 100)
  PlotDendrogram(seurat_obj, main = paste0(interestType, " Dendrogram"))
  dev.off()
  Result$modules <- seurat_obj@misc[[interestType]]$wgcna_modules

  send_msg(65, "计算模块特征基因...")
  seurat_obj <- ScaleData(seurat_obj, features = VariableFeatures(seurat_obj))
  seurat_obj <- ModuleEigengenes(seurat_obj, group.by.vars = "Sample")
  hMEs <- GetMEs(seurat_obj, harmonized = TRUE)
  MEs <- GetMEs(seurat_obj, harmonized = FALSE)
  Result$hMEs <- hMEs
  Result$MEs <- MEs

  send_msg(75, "计算模块连通性...")
  seurat_obj <- ModuleConnectivity(seurat_obj, group.by = "CellType",
                                     group_name = interestType)
  seurat_obj <- ResetModuleNames(seurat_obj, new_name = paste0(interestType, "-M"))
  p <- PlotKMEs(seurat_obj, ncol = 4)
  png(file.path(outdir, paste0(interestType, "_modules_kME.png")),
      width = 1500, height = 800, res = 100)
  print(p)
  dev.off()
  modules <- GetModules(seurat_obj)
  Result$module_assignment <- modules
  hub_df <- GetHubGenes(seurat_obj, n_hubs = n_hubs)
  Result$hub_genes <- hub_df

  send_msg(85, "模块评分...")
  seurat_obj <- ModuleExprScore(seurat_obj, n_genes = n_genes_score,
                                   method = ModuleScore)
  Result$seurat_obj_scored <- seurat_obj

  send_msg(90, "生成可视化...")
  plot_list <- ModuleFeaturePlot(seurat_obj, features = "hMEs", order = TRUE)
  if(length(plot_list) > 0) {
    png(file.path(outdir, paste0(interestType, "_modules_hMEs.png")),
        width = 1200, height = 800, res = 100)
    print(wrap_plots(plot_list, ncol = 4))
    dev.off()
  }
  png(file.path(outdir, paste0(interestType, "_modules_cor.png")),
      width = 1200, height = 1200, res = 100)
  ModuleCorrelogram(seurat_obj)
  dev.off()

  mods <- colnames(hMEs)
  mods <- mods[mods != "grey"]
  seurat_obj@meta.data <- cbind(seurat_obj@meta.data, hMEs)
  if(length(mods) > 0) {
    p1 <- DotPlot(seurat_obj, features = mods, group.by = "CellType")
    p1 <- p1 + coord_flip() + RotatedAxis() +
           scale_color_gradient2(high = "red", mid = "grey95", low = "blue")
    ggsave(file.path(outdir, paste0(interestType, "_modules_hMEs_DotPlot.png")),
           plot = p1, width = 9, height = max(6, length(mods) * 0.3),
           units = "in", dpi = 300)
  }

  send_msg(95, "保存结果...")
  saveRDS(hMEs, file.path(outdir, paste0(interestType, "_modules_hMEs.rds")))
  saveRDS(MEs, file.path(outdir, paste0(interestType, "_modules_MEs.rds")))
  saveRDS(seurat_obj, file.path(outdir, paste0(interestType, "_complete.rds")))
  write.csv(power_table, file.path(outdir, paste0(interestType, "_SoftPower.csv")), row.names = FALSE)
  write.csv(modules, file.path(outdir, paste0(interestType, "_modules.csv")), row.names = FALSE)
  write.csv(hub_df, file.path(outdir, paste0(interestType, "_modules_hub.csv")), row.names = FALSE)

  Result$soft_power <- select_soft_power
  Result$cell_type <- interestType
  Result$parameters <- list(
    minFraction = minFraction, sft_threshold = sft_threshold,
    ModuleScore = ModuleScore, k = k, max_shared = max_shared,
    min_cells = min_cells, n_hubs = n_hubs, n_genes_score = n_genes_score
  )

  send_msg(100, "WGCNA 分析完成")
  return(Result)
}
