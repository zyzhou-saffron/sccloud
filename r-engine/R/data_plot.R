# =====================================================================
# scCloud v2 — 原始可视化函数 (data_plot.R)
# 来源: test1/script/data_plot.R
# 注意: 此文件为旧系统的【原始代码】。
#       仅移除了 Shiny 独有的依赖 (argparser, this.path, plan())。
#       所有绘图函数和颜色定义不得修改。
# =====================================================================

suppressMessages({
  library(Seurat)
  library(ggplot2)
  library(ggrepel)
  library(ggalluvial)
  library(sctransform)
  library(purrr)
  library(Cairo)
  library(RCurl)
  library(cowplot)
  library(tidyverse)
  library(data.table)
  library(Hmisc)
  library(harmony)
  library(glmGamPoi)
  library(gtools)
  library(ggpubr)
  library(viridis)
  library(future)
  library(clusterProfiler)
  library(org.Hs.eg.db)
  library(RColorBrewer)
  library(dplyr)
  library(msigdbr)
  library(enrichplot)
  library(org.Mm.eg.db)
  library(gridExtra)
  library(grid)
  library(stats)
  library(ggplotify)
  library(patchwork)
  library(stringr)
  library(SingleR)
  library(celldex)
})

# ── Nature 风格主题 ──
nature_theme <- function(base_size = 9) {
  theme_bw(base_size = base_size) %+replace%
    theme(
      axis.line = element_line(linewidth = 0.35, color = "grey30"),
      axis.ticks = element_line(linewidth = 0.35, color = "grey30"),
      axis.text = element_text(size = rel(0.85), color = "grey20"),
      axis.title = element_text(size = rel(1.0), color = "grey15"),
      legend.text = element_text(size = rel(0.80)),
      legend.title = element_text(size = rel(0.90), face = "bold"),
      legend.key.size = unit(3.5, "mm"),
      legend.margin = margin(0, 0, 0, 0),
      panel.border = element_blank(),
      panel.grid.major.y = element_line(linewidth = 0.2, color = "grey90"),
      panel.grid.major.x = element_blank(),
      panel.grid.minor = element_blank(),
      plot.background = element_blank(),
      panel.background = element_blank(),
      strip.background = element_blank(),
      strip.text = element_text(size = rel(0.95), face = "bold", hjust = 0),
      plot.title = element_text(size = rel(1.05), face = "bold", hjust = 0.5, margin = margin(b = 6)),
      plot.margin = margin(6, 10, 4, 4),
      complete = TRUE
    )
}

#colours
clusterCols <- c("#D51F26", "#272E6A", "#208A42", "#89288F", "#F47D2B", "#FEE500", "#8A9FD1", "#C06CAB", "#E6C2DC",
                 "#90D5E4", "#89C75F", "#F37B7D", "#9983BD", "#D24B27", "#3BBCA8", "#6E4B9E", "#0C727C", "#7E1416",
                 "#D8A767", "#7DD06F", "#844081", "#688EC1", "#C17E73", "#484125", "#6CD3A7", "#597873", "#7B6FD0",
                 "#CF4A31", "#D0CD47", "#722A2D", "#CBC594", "#D19EC4", "#5A7E36", "#D4477D", "#403552", "#76D73C",
                 "#96CED5", "#CE54D1", "#C48736", "#FFB300", "#803E75", "#FF6800", "#A6BDD7", "#C10020", "#CEA262",
                 "#817066", "#007D34", "#F6768E", "#00538A", "#FF7A5C", "#53377A", "#FF8E00", "#B32851", "#F4C800",
                 "#7F180D", "#93AA00", "#593315", "#F13A13", "#232C16", "#faa818", "#41a30d", "#fbdf72", "#367d7d",
                 "#d33502", "#6ebcbc", "#37526d", "#916848", "#f5b390", "#342739", "#bed678", "#a6d9ee", "#0d74b6",
                 "#60824f", "#725ca5", "#e0598b", "#371377", "#7700FF", "#9E0142", "#FF0080", "#DC494C", "#F88D51",
                 "#FAD510", "#FFFF5F", "#88CFA4", "#238B45", "#02401B", "#0AD7D3", "#046C9A", "#A2A475", "grey35",
                 "#D52126", "#88CCEE", "#FEE52C", "#117733", "#CC61B0", "#99C945", "#2F8AC4", "#332288", "#E68316",
                 "#661101", "#F97B72", "#DDCC77", "#11A579", "#E73F74", "#A6CDE2", "#1E78B4", "#74C476", "#34A047",
                 "#F59899", "#E11E26", "#FCBF6E", "#F47E1F", "#CAB2D6", "#6A3E98", "#FAF39B", "#B15928", "#1a1334",
                 "#01545a", "#017351", "#03c383", "#aad962", "#fbbf45", "#ef6a32", "#ed0345", "#a12a5e", "#710162",
                 "#3B9AB2", "#2a7185", "#a64027", "#9cdff0", "#022336", "#78B7C5", "#EBCC2A", "#E1AF00", "#F21A00",
                 "#FF0000", "#00A08A", "#F2AD00", "#F98400", "#5BBCD6")

sampleCols <- c("#D52126","#FEE52C", "#117733", "#CC61B0", "#99C945", "#2F8AC4", "#332288", "#E68316", "#88CCEE",
                "#661101", "#F97B72", "#DDCC77", "#11A579", "#89288F", "#E73F74", "#A6CDE2", "#1E78B4", "#74C476",
                "#34A047", "#F59899", "#E11E26", "#FCBF6E", "#F47E1F", "#CAB2D6", "#6A3E98", "#FAF39B", "#B15928",
                "#1a1334", "#01545a", "#017351", "#03c383", "#aad962", "#fbbf45", "#ef6a32", "#ed0345", "#a12a5e",
                "#710162", "#3B9AB2", "#2a7185", "#a64027", "#fbdf72", "#60824f", "#9cdff0", "#022336", "#725ca5",
                "#78B7C5", "#EBCC2A", "#E1AF00", "#F21A00", "#FF0000", "#00A08A", "#F2AD00", "#F98400", "#5BBCD6")

groupCols <- c("#ef6a32", "#ed0345", "#a12a5e", "#710162", "#3B9AB2", "#2a7185", "#a64027", "#fbdf72", "#60824f",
               "#9cdff0", "#022336", "#725ca5", "#78B7C5", "#EBCC2A", "#E1AF00", "#F21A00", "#FF0000", "#00A08A",
               "#F2AD00", "#F98400", "#5BBCD6")


my_distPlot1 <- function(exp){
  plot1 <- FeatureScatter(exp, feature1 = "nCount_RNA", feature2 = "percent.mt")
  plot2 <- FeatureScatter(exp, feature1 = "nCount_RNA", feature2 = "nFeature_RNA")
  return(plot1 + plot2)
}

my_distPlot2 <- function(exp,pro){
  plot1 <- VlnPlot(exp, features = c("nCount_RNA", "nFeature_RNA", "percent.mt"), ncol = 3, pt.size = 0)+ NoLegend()
  plot2 <- VlnPlot(pro, features = c("nCount_RNA", "nFeature_RNA", "percent.mt"), ncol = 3, pt.size = 0)+ NoLegend()
  return(plot1/plot2)
}

my_distPlot3 <- function(sctpro,redu,group,nPCA){
  pro <- RunPCA(object = sctpro, verbose = FALSE)
  if(redu=="pca"){
    if(group=="Sample"){
      p <- ElbowPlot(pro, ndims = nPCA)
      p1 <- DimPlot(pro, reduction = 'pca',group.by = 'Sample')
      print(p+p1)
    }else if(group=="Group"){
      p <- DimPlot(pro, reduction = 'pca', group.by = 'Group')
      print(p)
    }
  }
  if(redu=="umap"){
    pro1 <- RunUMAP(object = pro, reduction = "pca", dims = 1:nPCA, verbose = FALSE)
    if(group=="Sample"){
      p <- DimPlot(pro1, reduction = 'umap', group.by = 'Sample')
    }else if(group=="Group"){
      p <- DimPlot(pro1, reduction = 'umap', group.by = 'Group')
    }
    print(p)
  }
   if(redu=="tsne"){
    pro1 <- RunTSNE(object = pro, reduction = "pca", dims = 1:nPCA, perplexity = 30, verbose = FALSE)
    if(group=="Sample"){
      p <- DimPlot(pro1, reduction = 'tsne', group.by = 'Sample')
    }else if(group=="Group"){
      p <- DimPlot(pro1, reduction = 'tsne', group.by = 'Group')
    }
    print(p)
  }
}

my_distPlot4 <- function(df){
  cluster_num <- as.matrix(table(df$Cluster,df$Sample))
  freqTable <- as.data.frame(prop.table(x = cluster_num, margin = 2))
  colnames(freqTable)<- c("Cluster","Sample","Freq")
  freqTable$Cluster <- as.factor(freqTable$Cluster)
  freqTable$Sample <- as.factor(freqTable$Sample)
  
  # Fraction of cell populations(%) Sankey Diagram
  plot1 <- ggplot(freqTable, aes(x = Sample, y = 100 * Freq, fill = Cluster, colour = Cluster,
                           stratum = Cluster, alluvium = Cluster)) +
  geom_stratum() +  #代替 geom_col() 绘制堆叠柱形图
  geom_flow(alpha = 0.5, linewidth = 0, linetype = 'blank', se = FALSE) +  #绘制同类别之间的连接线
  # facet_wrap(~group, scales = 'free_x', ncol = 2) +  #分面图
  scale_fill_manual(values = clusterCols) +
  scale_color_manual(values = clusterCols) +
  labs(x = '', y = 'Fraction of cell populations(%)') +
  guides(fill = guide_legend(ncol = 2, override.aes = list(linewidth = 2))) +
  cowplot::theme_cowplot() +
  theme(legend.position = 'right',
        legend.spacing.x = unit(0.2, 'cm'),
        axis.text.x = element_text(angle = 30, vjust = 0.5, hjust = 0.9),
        axis.title.y = element_text(size = 10))

  # Fraction of cell populations(%)
  plot2 <- ggbarplot(freqTable, x = "Sample", y = "Freq",
               # facet.by = 'Cluster',
               # add = c("mean_se"),
               width = 0.5,
               color = "Cluster",
               fill = "Cluster",
               lab.pos = 'in', # y value in or out
               # label = TRUE, # y value
               lab.vjust = 0.5, # y value vertical justification of labels.
               # top = 5,
               palette = clusterCols) +
  labs(x = '', y = 'Fraction of cell populations') +
  guides(color = guide_legend(ncol = 2,
                              # keywidth = 2,
                              # keyheight = 2,
                              # default.unit = "inch",
                              override.aes = list(linewidth = 2))) +
  theme(legend.position = 'right',
        legend.spacing.x = unit(0.2, 'cm'),
        axis.text.x = element_text(angle = 30, vjust = 0.5, hjust = 0.88),
        axis.title.y = element_text(size = 10))

  plot1/plot2
}


my_distPlot5 <- function(pro){
  p <- DimPlot(pro, reduction = 'umap', group.by = 'Cluster', label = T, cols = clusterCols, repel = T)
  p
}

my_distPlot6 <- function(pro,group){
  p1 <- DimPlot(pro, reduction = 'umap', group.by = group, repel = T) #
  p2 <- DimPlot(pro, reduction = 'umap', group.by = 'Cluster', split.by = group, cols = clusterCols,
             label = T, ncol = 4, repel = T)
  p1/p2
}

my_distPlot7 <- function(pro, minPct, logFc, test, pos, ntop, rawC = "All") {
    # 根据用户选择的 cluster 过滤
    if (length(rawC) == 1 && rawC == "All") {
      target_idents <- levels(pro)
    } else {
      target_idents <- rawC
      pro <- subset(pro, idents = target_idents)
    }

    pro <- PrepSCTFindMarkers(pro)
    difG <- data.frame()
    for (l in target_idents) {
      cluster.markers <- FindMarkers(
        object = pro, ident.1 = l,
        min.pct = minPct, logfc.threshold = logFc,
        test.use = test, only.pos = pos
      )
      diffTable <- data.frame(
        gene_id = rownames(cluster.markers),
        cluster.markers, Cluster = l
      )
      difG <- rbind(difG, diffTable)
    }
    difGtop3 <- difG %>%
      group_by(Cluster) %>%
      arrange(Cluster, p_val_adj, desc(avg_log2FC), desc(pct.1)) %>%
      dplyr::slice(1:ntop)

    plotFeatures <- as.character(unique(difGtop3$gene_id))
    # dotplot
    p <- DotPlot(pro, features = plotFeatures, dot.scale = 5) &
      scale_color_gradientn(
        colours = c("#4575B4", "#91BFDB", "#E0F3F8", "#FEE090", "#FC8D59", "#D73027")
      ) &
      guides(
        color = guide_colorbar(
          title = "Avg Expression",
          title.position = "top", title.hjust = 0.5,
          barwidth = unit(4, "cm"), barheight = unit(0.25, "cm"),
          label.position = "bottom"
        ),
        size = guide_legend(
          title = "% Expressed",
          title.position = "top", title.hjust = 0.5
        )
      ) &
      theme(
        axis.text.x = element_text(size = 8, angle = 45, hjust = 1, color = "grey20"),
        axis.text.y = element_text(size = 8, color = "grey20"),
        axis.title = element_blank(),
        panel.border = element_rect(linewidth = 0.4, color = "grey70"),
        panel.grid.major = element_line(linewidth = 0.15, color = "grey90"),
        legend.position = "bottom",
        legend.box = "horizontal",
        legend.margin = margin(t = -4),
        legend.text = element_text(size = 7),
        legend.title = element_text(size = 8, face = "bold")
      )
    p
}


my_distPlot8 <- function(pro, minPct, logFc, test, pos, ntop, rawC = "All") {
    # 根据用户选择的 cluster 过滤
    if (length(rawC) == 1 && rawC == "All") {
      target_idents <- levels(pro)
    } else {
      target_idents <- rawC
      pro <- subset(pro, idents = target_idents)
    }

    pro <- PrepSCTFindMarkers(pro)
    difG <- data.frame()
    for (l in target_idents) {
      cluster.markers <- FindMarkers(
        object = pro, ident.1 = l,
        min.pct = minPct, logfc.threshold = logFc,
        test.use = test, only.pos = pos
      )
      diffTable <- data.frame(
        gene_id = rownames(cluster.markers),
        cluster.markers, Cluster = l
      )
      difG <- rbind(difG, diffTable)
    }
    difGtop3 <- difG %>%
      group_by(Cluster) %>%
      arrange(Cluster, p_val_adj, desc(avg_log2FC), desc(pct.1)) %>%
      dplyr::slice(1:ntop)

    plotFeatures <- as.character(unique(difGtop3$gene_id))
    featuresVar <- VariableFeatures(pro)
    plotFeatures2 <- intersect(plotFeatures, featuresVar)

    p <- DoHeatmap(
      pro, features = plotFeatures2,
      size = 3, group.bar = TRUE, group.colors = clusterCols
    ) &
    scale_fill_viridis() &
    guides(
      fill = guide_colorbar(
        title.position = "left", title.hjust = 0.5,
        title.theme = element_text(angle = 90, size = 10), order = 1
      ),
      color = guide_legend(
        title.position = "left", title.hjust = 0.5, ncol = 1,
        title.theme = element_text(angle = 90, size = 10),
        override.aes = list(size = 1, alpha = 1), order = 2
      )
    )
    p
}


my_distPlot9 <- function(pro, rawC, minPct, logFc, test, pos, ntop, custom_genes = NULL) {
  if (rawC == "All") {
    stop("请选择单个聚类群，不支持 'All'")
  }

  # 验证 cluster identity 是否存在
  valid_idents <- levels(Idents(pro))
  if (!(rawC %in% valid_idents)) {
    stop(paste0(
      "聚类 '", rawC, "' 不存在。可用聚类: ",
      paste(valid_idents, collapse = ", ")
    ))
  }

  # 对当前 cluster 运行 FindMarkers (1 vs rest)
  pro <- PrepSCTFindMarkers(pro)
  cluster.markers <- FindMarkers(
    object = pro, ident.1 = rawC,
    min.pct = minPct, logfc.threshold = logFc,
    test.use = test, only.pos = pos
  )

  if (nrow(cluster.markers) == 0) {
    stop(paste0("聚类 ", rawC, " 未找到差异基因，请调整参数"))
  }

  diffTable <- data.frame(
    gene_id = rownames(cluster.markers),
    cluster.markers, Cluster = rawC
  )

  # 获取 SCT data 层中实际存在的基因
  allgenes <- rownames(GetAssayData(pro, assay = "SCT", layer = "data"))

  # 按显著性排序取 top N
  mkfsSub <- diffTable %>%
    arrange(p_val_adj, desc(avg_log2FC), desc(pct.1)) %>%
    dplyr::slice(1:ntop)

  markers <- intersect(mkfsSub$gene_id, allgenes)
  markers <- na.omit(markers)

  # 合并用户自定义基因（放在最前面，去重）
  if (!is.null(custom_genes) && length(custom_genes) > 0) {
    valid_custom <- intersect(custom_genes, allgenes)
    markers <- unique(c(valid_custom, markers))
  }

  if (length(markers) == 0) {
    stop(paste0("聚类 ", rawC, " 的 Top ", ntop, " 差异基因未在 SCT 数据层中找到"))
  }

  geneP <- markers
  p <- FeaturePlot(pro, features = geneP, pt.size = 0.2, ncol = 2, slot = "data") &
    scale_color_gradientn(colours = rev(rainbow(7, start = 0, end = 0.7)))
  p2 <- VlnPlot(pro, features = geneP, pt.size = 0, cols = clusterCols, ncol = 2)

  return(list(feature = p, vln = p2))
}



# functions
# description string length 80
#slice_str <- function(x){
#  if (nchar(x) <= 80){
#    return(x)
#  } else{
#    return(paste0(substr(x, start = 1, stop = 80), '...'))
#  }
#}

#is_upper_strict <- function(x) {
#  !grepl("[a-z]", x)  # 检查是否都是大写字母
#}


# 字符串截断函数
slice_str <- function(x, width = 60) {
  if (nchar(x) > width) {
    return(paste0(substr(x, 1, width - 3), "..."))
  }
  return(x)
}

# 判断大写基因函数
is_upper_strict <- function(x) {
  grepl("^[A-Z0-9]+$", as.character(x))
}
  
my_distPlot10 <- function(sigDegs, pathway, pos1, pAdjust, pvalue, qvalue, nTerm) {
  # 抑制bitr的select警告
  options(warn = -1)
  on.exit(options(warn = 0))  # 函数结束时恢复
  
  # 1. 计算大写基因的比例
  upper_ratio <- mean(sapply(sigDegs$gene_id, is_upper_strict))
  
  # 2. 确定物种和数据库
  if (upper_ratio == 1) {
    species <- "Homo sapiens"
    goDB <- 'org.Hs.eg.db'
  } else if (upper_ratio > 0.5) {
    species <- "Homo sapiens"
    goDB <- 'org.Hs.eg.db'
    sigDegs$gene_id <- toupper(sigDegs$gene_id)
  } else {
    species <- "Mus musculus"
    goDB <- 'org.Mm.eg.db'
  }
  
  # 3. 统一获取KEGG集
  keggSets <- msigdbr(
    species = species,
    category = "C2",
    subcategory = 'CP:KEGG'
  ) %>% dplyr::select(gs_name, entrez_gene)
  

  # 执行GO分析
  perform_go_analysis <- function(direction) {
    # 筛选差异基因
    if (direction == "Up") {
      sigDegsSub <- sigDegs[which(sigDegs$avg_log2FC > 0), ]
    } else {
      sigDegsSub <- sigDegs[which(sigDegs$avg_log2FC < 0), ]
    }
    
    if (nrow(sigDegsSub) == 0) {
      warning(paste("No", direction, "regulated genes found"))
      return(NULL)
    }
    
    degGenes <- sigDegsSub$gene_id
    
    # ID转换
    suppressWarnings({
      degConverted <- bitr(degGenes, fromType = "SYMBOL", toType = c('ENTREZID'), OrgDb = goDB)
    })
    
    if (nrow(degConverted) == 0) {
      warning(paste("No genes could be converted to ENTREZID for", direction, "regulation"))
      return(NULL)
    }
    
    # GO富集分析
    goAll <- enrichGO(
      gene = degConverted$ENTREZID,
      universe = NULL,
      OrgDb = goDB,
      ont = 'ALL',
      pAdjustMethod = pAdjust,
      pvalueCutoff = pvalue,
      qvalueCutoff = qvalue,
      readable = TRUE
    )
    
    if (is.null(goAll) || nrow(goAll) == 0) {
      warning(paste("GO enrichment analysis", direction, "failed - no significant terms"))
      return(NULL)
    }
    
    return(list(result = goAll, genes = degConverted))
  }
  
  # 创建GO可视化函数
  create_go_plots <- function(goAll, nTerm) {
    goAll@result$Description <- purrr::map_chr(goAll@result$Description, slice_str)
    
    dt <- goAll@result %>% 
      group_by(ONTOLOGY) %>% 
      arrange(pvalue) %>% 
      dplyr::slice(1:nTerm) %>%
      na.omit()
    
    if (nrow(dt) == 0) return(NULL)
    
    dt$Description <- factor(dt$Description, levels = rev(dt$Description))
    CPCOLS <- c("#aad962", "#F47D2B", "#2482dd")
    names(CPCOLS) <- c('MF', 'CC', 'BP')
    
    # 柱状图
    p <- ggplot(data = dt, aes(x = Description, y = -log10(pvalue), fill = ONTOLOGY)) +
      geom_bar(stat = "identity", width = 0.8) + 
      coord_flip() +
      scale_fill_manual(values = CPCOLS, breaks = c('BP', 'CC', 'MF')) + 
      nature_theme() +
      scale_y_continuous(expand = c(0.01, 0.01)) +
      guides(fill = guide_legend(
        title = "GO : ",
        title.theme = element_text(size = 8),
        label.theme = element_text(size = 8),
        override.aes = list(size = 2)
      )) +
      geom_hline(yintercept = -log10(0.05), lty = 2, col = "gray", lwd = 0.5) +
      theme(
        axis.text.x = element_text(color = "grey20"),
        axis.text.y = element_text(size = 8),
        axis.title.y = element_blank(),
        legend.position = 'top',
        legend.key.size = unit(5, 'mm')
      )
    
    # 点图
    goAll2 <- goAll
    goAll2@result <- data.frame(goAll2) %>% 
      group_by(ONTOLOGY) %>% 
      arrange(pvalue) %>% 
      dplyr::slice(1:nTerm)
    
    p2 <- dotplot(goAll2, split = 'ONTOLOGY', showCategory = nTerm, 
                  font.size = 8, color = "pvalue") +
      scale_colour_gradientn(colours = colorRampPalette(brewer.pal(11, "RdBu"))(100)) +
      scale_size_area(max_size = 6)  # 使用scale_size_area替代scale_radius
    
    return(p + p2)
  }
  
  
  # 执行KEGG分析
  perform_kegg_analysis <- function(direction) {
    # 筛选差异基因
    if (direction == "Up") {
      sigDegsSub <- sigDegs[which(sigDegs$avg_log2FC > 0), ]
    } else {
      sigDegsSub <- sigDegs[which(sigDegs$avg_log2FC < 0), ]
    }
    
    if (nrow(sigDegsSub) == 0) {
      warning(paste("No", direction, "regulated genes found"))
      return(NULL)
    }
    
    degGenes <- sigDegsSub$gene_id
    
    # ID转换
    suppressWarnings({
      degConverted <- bitr(degGenes, fromType = "SYMBOL", toType = c('ENTREZID'), OrgDb = goDB)
    })
    
    if (nrow(degConverted) == 0) {
      warning(paste("No genes could be converted to ENTREZID for", direction, "regulation"))
      return(NULL)
    }
    
    # KEGG富集分析
    kk <- enricher(
      degConverted$ENTREZID,
      TERM2GENE = keggSets,
      minGSSize = 10,
      maxGSSize = 500,
      pAdjustMethod = pAdjust,
      pvalueCutoff = pvalue,
      qvalueCutoff = qvalue
    )
    
    if (is.null(kk) || nrow(kk) == 0) {
      warning(paste("KEGG enrichment analysis", direction, "failed - no significant terms"))
      return(NULL)
    }
    
    # 添加基因名称
    annog <- degConverted$SYMBOL
    names(annog) <- degConverted$ENTREZID
    
    kk@result$geneName <- purrr::map_chr(kk@result$geneID, function(x) {
      genes <- unlist(strsplit(x, '/'))
      paste(annog[genes], collapse = '/')
    })
    
    return(list(result = kk, genes = degConverted))
  }
  
  # 创建KEGG可视化函数
  create_kegg_plots <- function(kk, nTerm, direction) {
    kk@result$Description <- purrr::map_chr(kk@result$Description, slice_str)
    
    # 柱状图数据
    kgdt <- data.frame(kk) %>% 
      arrange(pvalue) %>% 
      dplyr::slice(1:min(3 * nTerm, nrow(kk))) %>%
      na.omit()
    
    if (nrow(kgdt) == 0) return(NULL)
    
    kgdt$Description <- factor(kgdt$Description, levels = rev(kgdt$Description))
    
    # 柱状图
    p <- ggplot(data = kgdt, aes(x = Description, y = -log10(pvalue), fill = Count)) +
      geom_bar(stat = "identity", width = 0.8) + 
      coord_flip() +
      scale_fill_gradientn(colours = rev(colorRampPalette(brewer.pal(11, "RdBu"))(100))) + 
      nature_theme() +
      scale_y_continuous(expand = c(0.01, 0.01)) +
      labs(title = paste('KEGG pathway -', direction)) +
      geom_hline(yintercept = -log10(0.05), lty = 2, col = "gray", lwd = 0.5) +
      theme(
        axis.text = element_text(color = "grey20"),
        axis.title.y = element_blank(),
        plot.title = element_text(size = 10, hjust = 0.5)
      )
    
    # 点图
    kk2 <- kk
    show_n <- min(30, nrow(kk))
    kk2@result <- kk2@result %>% 
      arrange(pvalue) %>% 
      dplyr::slice(1:show_n)
    
    p2 <- dotplot(kk2, showCategory = show_n, font.size = 8, color = "pvalue") +
      scale_colour_gradientn(colours = colorRampPalette(brewer.pal(11, "RdBu"))(100)) +
      scale_size_area(max_size = 6) +
      labs(title = paste('KEGG pathway -', direction)) +
      theme(
        axis.text = element_text(color = "grey20"),
        axis.title.y = element_blank(),
        plot.title = element_text(size = 10, hjust = 0.5)
      )
    
    return(p + p2)
  }
  
  
  # 执行GSEA分析
  perform_gsea_analysis <- function() {
    degGenes <- sigDegs$gene_id
    
    # ID转换
    suppressWarnings({
      degConverted <- bitr(degGenes, fromType = "SYMBOL", toType = c('ENTREZID'), OrgDb = goDB)
    })
    
    if (nrow(degConverted) == 0) {
      warning("No genes could be converted to ENTREZID for GSEA")
      return(NULL)
    }
    
    # 准备基因列表
    geneList <- sigDegs %>%
      filter(gene_id %in% degConverted$SYMBOL) %>%
      left_join(degConverted, by = c("gene_id" = "SYMBOL")) %>%
      filter(!is.na(ENTREZID)) %>%
      arrange(desc(avg_log2FC), desc(-log10(p_val))) %>%
      {structure(.$avg_log2FC, names = .$ENTREZID)}
    
    # GSEA分析
    em <- GSEA(geneList, TERM2GENE = keggSets, eps = 0)
    
    if (is.null(em) || nrow(em) == 0) {
      warning("GSEA enrichment analysis failed - no significant terms")
      return(NULL)
    }
    
    return(list(result = em, gene_list = geneList))
  }
  
  # 创建GSEA可视化
  create_gsea_plots <- function(em, nTerm) {
    n_plots <- min(nTerm, nrow(em))
    
    if (n_plots == 0) {
      return(NULL)
    }
    
    plot_list <- list()
    for (i in 1:n_plots) {
      p <- gseaplot2(em,geneSetID = i,
        title = paste0(slice_str(em$Description[i], 40),'\nP.adjust = ', sprintf("%.2e", em$p.adjust[i]),' , NES = ', round(em$NES[i], 2)),
        pvalue_table = FALSE,
        ES_geom = 'line'
      )
      plot_list[[i]] <- ggplotify::as.ggplot(p)
    }
    
    # 自动确定网格布局
    ncol <- min(2, length(plot_list))
    nrow <- ceiling(length(plot_list) / ncol)
    
    combined_plot <- gridExtra::grid.arrange(
      grobs = plot_list,
      ncol = ncol,
      nrow = nrow
    )
    
    return(combined_plot)
  }
  
  
  # 4. 根据参数执行不同分析
  result_data <- NULL
  result_plot <- NULL
  if (pathway == "GO") {
    if (pos1 %in% c("Up", "Down")) {
      go_res <- perform_go_analysis(pos1)
      if (!is.null(go_res)) {
        result_plot <- create_go_plots(go_res$result, nTerm)
        result_data <- na.omit(data.frame(go_res$result))
      }
    }
  } 
  else if (pathway == "KEGG") {
    if (pos1 %in% c("Up", "Down")) {
      kegg_res <- perform_kegg_analysis(pos1)
      if (!is.null(kegg_res)) {
        result_plot <- create_kegg_plots(kegg_res$result, nTerm, pos1)
        result_data <- na.omit(data.frame(kegg_res$result))
      }
    }
  } 
  else if (pathway == "GSEA") {
    gsea_res <- perform_gsea_analysis()
    if (!is.null(gsea_res)) {
      result_plot <- create_gsea_plots(gsea_res$result, nTerm)
      result_data <- na.omit(data.frame(gsea_res$result))
    }
  } 
  else {
    warning(paste("Unknown pathway type:", pathway))
  }
  
  # 5. 返回结果
  if (is.null(result_plot) || is.null(result_data)) {
    warning(paste("No results for", pathway, pos1, "- returning empty plot"))
    
    # 创建空图
    empty_plot <- ggplot() +
      annotate("text", x = 0.5, y = 0.5, 
               label = paste("No significant enrichment for", pathway, pos1),
               size = 6, color = "gray") +
      theme_void()
    
    return(list(
      data = data.frame(),
      plot = empty_plot
    ))
  }
  
  return(list(data = result_data,plot = result_plot))
  
}




my_distPlot11 <- function(pro,mkfs,cellType) {
  allgenes <- rownames(GetAssayData(pro, assay = 'SCT', layer = 'data'))
  marker <- strsplit(mkfs[cellType,], '[\t, ]+')[[1]]
  if(all(sapply(allgenes, is_upper_strict))){
      markers <- intersect(marker[marker != ''], allgenes)
  }else{
      markers <- allgenes[toupper(allgenes) %in% toupper(marker[marker != ''])]
  }
  #print(markers)
  #print(class(mkfs))
  #print(class(pro))
  markers <- sort(na.omit(markers))
  if(length(markers)>=1){
    # 计算所有 marker 基因的最大表达量，统一颜色范围
    expr_mat <- GetAssayData(pro, assay = "SCT", layer = "data")
    max_expr <- max(expr_mat[markers, ], na.rm = TRUE)
    if (max_expr == 0) max_expr <- 1  # 避免 limits 退化

    # 列数随基因数动态调整，最多 4 列
    n_col <- min(length(markers), 4)

    p <- FeaturePlot(pro, features = markers, pt.size = 0.2, ncol = n_col, slot = 'data') &
      scale_color_gradientn(
        colours = c("lightgrey", "#FFF7BC", "#FEC44F", "#D95F0E", "#7F0000"),
        limits  = c(0, max_expr),
        name    = "Expression"
      )

    n_col_vln <- max(1, min(length(markers), 2))
    p2 <- VlnPlot(pro, features = markers, pt.size = 0, cols = clusterCols, ncol = n_col_vln)

    return(p / p2)
  }else{
    # 返回一个简单的文本图
    par(mar = c(0, 0, 0, 0))
    plot(0, 0, type = "n", xlab = "", ylab = "", axes = FALSE, xlim = c(-1, 1), ylim = c(-1, 1))
    text(0, 0, paste0("No marker genes", "
", "in dataset!"), col = "red", cex = 1.2, font = 2)
  }

}


 
