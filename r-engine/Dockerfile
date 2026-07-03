# scCloud v2 — R 计算引擎 Dockerfile
# 基于 rocker/r-ver 官方镜像 + 服务器预编译 R 库
#
# 构建前准备:
#   cp -r /data/software/scRNAseq/anaconda3/envs/R4.3/lib/R/library ~/sccloud-r-engine/r-library
# 构建: docker build -t sccloud-r-engine .
# 运行: docker run -p 8787:8787 -v /data/projects:/data/projects sccloud-r-engine

FROM rocker/r-ver:4.3.2

LABEL maintainer="scCloud Team"
LABEL description="scCloud v2 R Compute Engine — Seurat + Plumber API"

# ===== 系统依赖 =====
# Seurat/HDF5/网络/图形渲染所需的 C/C++ 运行时库
RUN apt-get update && apt-get install -y --no-install-recommends \
    libhdf5-dev \
    libcurl4-openssl-dev \
    libssl-dev \
    libxml2-dev \
    libpng-dev \
    libjpeg-dev \
    libgit2-dev \
    libfontconfig1-dev \
    libharfbuzz-dev \
    libfribidi-dev \
    libtiff5-dev \
    libglpk-dev \
    libcairo2-dev \
    libsodium-dev \
    libhiredis-dev \
    libfreetype6-dev \
    libwebp-dev \
    jags \
    cmake \
    make \
    curl \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Ubuntu 的 jags 把模块装到 /usr/lib/x86_64-linux-gnu/JAGS，rjags 编译时按 /usr/local/JAGS 找
RUN ln -s /usr/lib/x86_64-linux-gnu/JAGS /usr/local/JAGS

# ===== Python 依赖（reticulate 用于 H5AD/Loom 格式处理）=====
RUN pip3 install --no-cache-dir anndata loompy

ENV RETICULATE_PYTHON=/usr/bin/python3

WORKDIR /app

# ===== 编译子进程 reap 助手（解决 system(wait=FALSE) 留下僵尸导致任务卡死）=====
COPY reap.c /app/reap.c
RUN R CMD SHLIB /app/reap.c

# ===== R 库：从服务器预编译包直接复制 =====
# 572 个已编译包，包含 Seurat、Bioconductor、SingleR、clusterProfiler 等
# 源路径: /data/software/scRNAseq/anaconda3/envs/R4.3/lib/R/library
COPY r-library/ /usr/local/lib/R/site-library/
# 关键: COPY 进来的 conda 包属 root、默认权限不让容器 rengine 用户读, 须放开读/执行位
# (否则 R 只认出极少数包, 镜像不可用)
RUN chmod -R a+rX /usr/local/lib/R/site-library/

# ===== 修复 ABI 不兼容的包 + 补装容器专用包 =====
# stringi/Cairo: 服务器编译时链接了 ICU 75，容器内只有 ICU 70，须重编译
# ragg/svglite: 二进制 ragg 链接 libtiff.so.6, 镜像内只有 libtiff5, 须源码重编;
#   ragg/svglite 依赖 systemfonts/textshaping, 一并源码装(供 SVG/TIFF 导出持久内置)
# plumber/redux: API 服务层，原研究环境不需要，仅容器需要
RUN Rscript -e " \
    options(repos = c(CRAN = 'https://mirrors.ustc.edu.cn/CRAN/')); \
    install.packages(c('stringi', 'Cairo', 'systemfonts', 'textshaping', 'svglite', 'ragg'), type = 'source', Ncpus = 1L); \
    install.packages(c('plumber', 'redux'), Ncpus = 2L); \
    install.packages('rjags', type = 'source', Ncpus = 2L) \
"

# ===== 应用代码 =====
COPY plumber.R .
COPY R/ R/

# ===== 数据资源 =====
# SingleR 参考数据等（可选，首次运行时也会自动下载）
COPY data/ data/

# ===== 安全 =====
# 以非 root 用户运行
RUN useradd -m rengine && chown -R rengine:rengine /app
USER rengine

# ===== 端口 =====
EXPOSE 8787

# ===== 健康检查 =====
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:8787/health || exit 1

# ===== 启动 =====
CMD ["R", "-e", "plumber::plumb('plumber.R')$run(host='0.0.0.0', port=8787)"]
