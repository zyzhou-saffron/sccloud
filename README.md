# scCloud — 单细胞 RNA-seq 分析平台

> 现代全栈架构：**Next.js 16 + FastAPI + R Plumber**，支持完整的 scRNA-seq 8 步分析流程。

<p align="left">
  <img src="https://img.shields.io/badge/Next.js-16-000000?style=flat-square&logo=next.js&logoColor=white" alt="Next.js" />
  <img src="https://img.shields.io/badge/FastAPI-009688?style=flat-square&logo=fastapi&logoColor=white" alt="FastAPI" />
  <img src="https://img.shields.io/badge/R_Engine-4.3.2-276DC3?style=flat-square&logo=r&logoColor=white" alt="R" />
  <img src="https://img.shields.io/badge/Seurat-V5-4A90E2?style=flat-square" alt="Seurat V5" />
  <img src="https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker" />
  <img src="https://img.shields.io/badge/Redis-DC382D?style=flat-square&logo=redis&logoColor=white" alt="Redis" />
  <img src="https://img.shields.io/badge/MariaDB-003545?style=flat-square&logo=mariadb&logoColor=white" alt="MariaDB" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
</p>

![scCloud Dashboard 预览](docs/images/dashboard.png)

## 文档导览

| 章节 | 内容 |
|---|---|
| [架构总览](#架构总览) | ASCII 架构图 + 技术栈表 |
| [快速开始](#快速开始--一键部署) | `sh ./start.sh` 拉镜像并启动 |
| [R 引擎构建](#r-引擎镜像说明) | GHCR pull / tar load / r-library 本地 build |
| [分析流程](#分析流程) | 8步标准 scRNA-seq 分析及 WebGL 可视化 |
| [服务器部署](#服务器部署host-网络模式) | Host 网络模式（高级）+ 端口规划 |
| [环境变量](#环境变量参考) | 完整参考表，标注必填项 |
| [API 端点](#api-端点) | 全部 REST + WebSocket 端点 |
| [常见问题](#常见问题) | R 引擎故障 / 数据库初始化 / 大文件超时 / OOM |
| [开发模式](#开发模式) | 前后端热重载本地开发 |


## 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                     Nginx (:9000)                           │
│            反向代理 — 统一入口                               │
├──────────────────┬──────────────────┬───────────────────────┤
│  Frontend (:3001)│  Backend (:8000) │   WebSocket (/ws/)    │
│  Next.js 16      │  FastAPI         │   任务进度推送         │
│  SSR + SPA       │  REST API        │   Redis Pub/Sub       │
├──────────────────┴──────────────────┴───────────────────────┤
│                  R-Engine (:8787)                            │
│            Plumber API — Seurat 5 计算引擎                   │
├──────────────────┬──────────────────────────────────────────┤
│ MariaDB (:3307)  │              Redis (:6380)               │
│ 用户/项目/任务    │         消息队列 + 进度缓存               │
└──────────────────┴──────────────────────────────────────────┘
```

| 组件 | 技术 | 说明 |
|------|------|------|
| 前端 | Next.js 16, deck.gl, Plotly.js | 响应式 SPA，WebGL 海量点散点图 |
| 后端 | FastAPI, SQLAlchemy 2.0, Redis | REST API + WebSocket 实时进度 |
| 计算引擎 | R 4.3.2, Seurat 5, Plumber | 无状态 HTTP 计算引擎 |
| 数据库 | MariaDB 11 | 用户认证、项目管理、任务记录 |
| 缓存 | Redis 7 | 进度推送、任务状态同步 |
| 代理 | Nginx | 反向代理、WebSocket 升级、大文件上传 |

---

## 快速开始 — 一键部署

### 前提条件

- **Docker** ≥ 24.0 + **Docker Compose** v2
- **内存** ≥ 16 GB（分析大数据集时建议 32GB+）
- **磁盘** ≥ 50 GB（R 镜像约 2GB+ + 项目数据）

### 一键启动

```bash
git clone https://github.com/zyzhou-saffron/sccloud.git
cd sccloud
sh ./start.sh
```

脚本会自动：

1. 检测 Docker Compose v2（缺省不自动装 Docker；共享机可用 `sh ./start.sh --install-docker`）
2. 无 `.env` 或 `./secrets/*` 时运行 `scripts/setup-wizard.sh`（随机 DB/JWT/Redis 密钥写入 **`./secrets/`**，默认管理员 `admin` / `admin123`）
3. `WEB_PORT` 默认 `8080`；若占用（例如闲鱼助手）则自动 +1…+9 并写回 `.env`
4. 探测 GHCR → `docker compose pull`；失败则本地 `build`
5. R 镜像兜底：本地 tag → `data/sccloud-r-engine-image.tar.gz` load → 有 `r-engine/r-library` 再 build
6. `up -d` 并等待 db / redis / backend / r-engine / 入口 `/healthz`

访问 **http://localhost:${WEB_PORT}**（默认 8080）。空库首次启动会 bootstrap 管理员。

**安全（对齐闲鱼助手）**：`DB`/`JWT`/`Redis`/管理员密码仅在 `./secrets/`（compose secrets 挂载），容器默认 `no-new-privileges`、`cap_drop: ALL`，nginx/frontend/redis/db 额外 `read_only` + 非 root；MariaDB/Redis/nginx **钉镜像 digest**。

```bash
# 常用运维
sh ./scripts/sccloud-ops.sh status
sh ./scripts/sccloud-ops.sh logs
sh ./scripts/sccloud-ops.sh stop

# 强制本地构建 / 跳过 pull
sh ./start.sh --build
sh ./start.sh --no-pull

# rootless / 只绑本机
SCLOUD_ROOTLESS=1 sh ./start.sh
# 或: export COMPOSE_FILE=docker-compose.yml:docker-compose.rootless.yml
```

### 预构建镜像（GHCR）

| 镜像 | 说明 |
|------|------|
| `ghcr.io/zyzhou-saffron/sccloud-frontend` | CI 自动构建推送，**linux/amd64 + arm64** |
| `ghcr.io/zyzhou-saffron/sccloud-backend` | 同上 |
| `ghcr.io/zyzhou-saffron/sccloud-r-engine` | 需 `r-library`，在 GPU/本机构建后手动 push |

**标签**

| 触发 | 镜像 tag |
|------|----------|
| `main` 上改 `frontend/**` / `backend/**` | `latest` + git 短 SHA |
| Release Please 发版（GitHub Release published） | 另加 `vX.Y.Z` 与 `X.Y.Z` |
| Actions → 手动 `workflow_dispatch` | `latest` + SHA（两边都建） |

包建议设为 **Public**，免登录 pull。私有包需先 `docker login ghcr.io`。

**阿里云 ACR（可选）**：在仓库 Settings → Variables/Secrets 配置 `ALIYUN_ACR_REGISTRY`、`ALIYUN_ACR_NAMESPACE`、`ALIYUN_ACR_USERNAME`、`ALIYUN_ACR_PASSWORD` 后，CI 会用 `buildx imagetools` 把多架构清单 mirror 到 ACR。`.env` 中把 `FRONTEND_IMAGE`/`BACKEND_IMAGE` 改成 ACR 前缀即可（见 `.env.example`）。

### 发版（Release Please）

仓库已接 [release-please](https://github.com/googleapis/release-please)：`main` 上的 conventional commits（`feat:` / `fix:` …）会自动维护 **Release PR**（更新 `CHANGELOG.md`、`version.txt`、`.release-please-manifest.json`）。

1. 日常开发：commit 用 `feat:` / `fix:` 前缀（`ci:` / `chore:` 默认不进 CHANGELOG 正文）。
2. 打开/审查 Release PR（例如当前的 1.1.0），确认 CHANGELOG 后 **合并**。
3. 合并后自动打 `vX.Y.Z` tag 并创建 GitHub Release。
4. `release` 事件触发 docker-publish：FE/BE 推 `latest`、短 SHA、`vX.Y.Z`、`X.Y.Z`。

`version.txt` 在 main 上可能暂时落后（例如仍为 `0.0.0`），**以 Release PR 合并后的值 / GitHub tag 为准**，不要手改 main 上的 version 与 release-please 抢跑。

### R 引擎镜像说明

R 引擎体积大且 `r-library/` 不在 git 中。优先级：

1. **GHCR pull**（`start.sh` 默认）
2. **本地已有** `sccloud-r-engine` / 目标 tag
3. **`data/sccloud-r-engine-image.tar.gz`** → `docker load`
4. **本地 build**（需准备 `r-engine/r-library`）：

```bash
cp -r /path/to/R/library r-engine/r-library
docker build -t ghcr.io/zyzhou-saffron/sccloud-r-engine:latest ./r-engine
docker push ghcr.io/zyzhou-saffron/sccloud-r-engine:latest
```

从零编译（约 2h）：改 `r-engine/Dockerfile`，用 `install_packages.R` 替代 `COPY r-library/`。

### 手动 compose（等价）

```bash
sh ./scripts/setup-wizard.sh   # 或 cp .env.example .env 后手改
docker compose --env-file .env pull
docker compose --env-file .env up -d
curl -fsS "http://127.0.0.1:${WEB_PORT:-8080}/healthz"
```

可选：将 SQL 放到 `data/initdb.d/`，仅在 **空** MariaDB volume 首次启动时导入（若已有 users 则不会 bootstrap 管理员）。

---

## 服务器部署（Host 网络模式）

**高级/历史路径。** 日常请优先 `sh ./start.sh`（桥接 `docker-compose.yml`）。以下 host 网络适用于需要绑核/超大内存 worker 的 GPU 现网。

### 端口规划

| 服务 | 端口 | 说明 |
|------|------|------|
| Nginx | 9000 | **统一入口** — 用户访问此端口 |
| Frontend | 3001 | Next.js SSR |
| Backend | 8000 | FastAPI API |
| R-Engine | 8787 | Plumber 计算 |
| MariaDB | 3307 | 避免与宿主机 3306 冲突 |
| Redis | 6380 | 避免与宿主机 6379 冲突 |

### 部署命令

```bash
# 创建服务器专用环境配置
cp .env.example .env.server
vim .env.server  # 修改以下必填项：
#   - DB_PASS / DB_ROOT_PASS（数据库密码）
#   - JWT_SECRET — 用 `openssl rand -hex 32` 生成，如：
#     a583661e1b2f7bf173e2ca320a5889009f9ae2f64ab5365434a4914935d500f8

# 启动（使用 server 配置文件）
docker compose --env-file .env.server -f docker-compose.server.yml up -d --build

# 查看状态
docker compose -f docker-compose.server.yml ps

# 查看日志
docker compose -f docker-compose.server.yml logs -f r-engine
```

访问 **http://\<server-ip\>:9000**。

### 重启单个服务

```bash
# 仅重启 R 引擎（修改 R 代码后）
docker compose --env-file .env.server -f docker-compose.server.yml restart r-engine

# 仅重建前端（修改前端代码后）
docker compose --env-file .env.server -f docker-compose.server.yml up -d --build frontend
```

---

## 环境变量参考

一键部署由 `setup-wizard.sh` 生成 `.env` + `./secrets/`。完整模板见 `.env.example`。

| 变量 | 默认值 | 必填 | 说明 |
|------|--------|------|------|
| `WEB_PORT` | `8080` | | 唯一对外端口（占用自动换） |
| `WEB_BIND_ADDRESS` | `0.0.0.0` | | 监听地址；rootless 叠加默认 `127.0.0.1` |
| `FRONTEND_IMAGE` / `BACKEND_IMAGE` / `R_ENGINE_IMAGE` | GHCR `…/sccloud-*:latest` | | 预构建镜像（可改 ACR） |
| `DB_NAME` | `sccloud_v2` | | 数据库名 |
| `DB_USER` | `sccloud_app` | | 数据库用户 |
| `./secrets/db-password` | 向导生成 | ✅ | **应用库密码**（compose secret） |
| `./secrets/db-root-password` | 向导生成 | ✅ | **root 密码** |
| `./secrets/jwt-secret` | 向导生成 | ✅ | **JWT 签名密钥** |
| `./secrets/redis-password` | 向导生成 | ✅ | **Redis requirepass** |
| `./secrets/bootstrap-admin-password` | `admin123` | | 空库首次管理员密码 |
| `R_REDIS_URL` | 向导写入 | | 供 R 引擎的带密码 Redis URL |
| `JWT_ALGORITHM` | `HS256` | | JWT 算法 |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `60` | | 访问令牌有效期 |
| `REFRESH_TOKEN_EXPIRE_DAYS` | `30` | | 刷新令牌有效期 |
| `R_ENGINE_TIMEOUT` | `86400` | | R 请求超时（秒） |
| `R_ENGINE_MEM_LIMIT` / `R_WORKER_MEM_LIMIT` | `16g` / `32g` | | 容器内存上限 |
| `PROJECTS_ROOT` | `/data/projects` | | 项目数据路径 |
| `BOOTSTRAP_ADMIN_USER` | `admin` | | 空库首次管理员用户名 |
| `SCLOUD_ROOTLESS` | `0` | | `1` 时叠加 `docker-compose.rootless.yml` |
| `ENVIRONMENT` | `production` | | `development` / `production` |

---

## 分析流程

支持 **8 步标准 scRNA-seq 分析**流程，每步结果自动衔接：

```
1. 数据预处理 (QC)        → 质控过滤（线粒体比例、基因数、UMI）
2. 数据标准化              → SCTransform
3. 数据降维                → PCA / UMAP / tSNE
4. 批次校正聚类            → Harmony 校正 + Louvain 聚类
5. 差异基因分析            → FindMarkers + DotPlot / Heatmap
6. 通路富集                → GO / KEGG / GSEA
7. Marker 基因表达         → FeaturePlot + VlnPlot 可视化
8. 细胞注释                → SingleR 自动注释 / 手动注释
```

### 核心特性

- **格式转换**：H5AD / H5Seurat / CSV / TSV ↔ RDS 双向转换
- **多样本 MTX 整合**：批量上传 10X ZIP → 自动合并 RDS
- **WebGL 交互式散点图**：deck.gl 渲染百万级细胞点
- **交互式火山图**：Plotly 双簇对比
- **实时进度推送**：Redis Pub/Sub → WebSocket

### 界面展示

<details open>
<summary><b>展开查看分析可视化图表</b></summary>

**1. 降维聚类 (UMAP)**
![UMAP 降维图](docs/images/umap.png)

**2. 差异基因火山图**
![差异基因火山图](docs/images/volcano.png)

**3. Marker 基因表达可视化**
![Marker 基因表达](docs/images/marker.png)

</details>


---

## 项目结构

```
sccloud/
├── frontend/                   # Next.js 16 前端
│   ├── Dockerfile              # 多阶段构建 (deps → build → standalone)
│   └── src/app/
│       ├── lib/api.ts          # 统一 API 客户端 + JWT 自动刷新
│       ├── components/         # 可复用组件
│       │   ├── ResultViewer.tsx # 8 步分析结果渲染（核心组件）
│       │   ├── charts/         # deck.gl 散点图、Plotly 火山图
│       │   └── TaskHistory.tsx  # 任务历史面板
│       ├── dashboard/          # 仪表盘（分析主页）
│       ├── convert/            # 格式转换页
│       └── settings/           # 用户设置
│
├── backend/                    # FastAPI 后端
│   ├── Dockerfile
│   ├── pyproject.toml          # Python 依赖
│   └── app/
│       ├── main.py             # 应用入口 + CORS
│       ├── auth/               # JWT 认证 (注册/登录/刷新)
│       ├── projects/           # 项目 CRUD
│       ├── tasks/              # 任务管理 + R 引擎调用
│       ├── upload/             # 分片上传 (大文件)
│       ├── convert/            # 格式转换
│       ├── ws/                 # WebSocket 进度推送
│       └── utils/              # R 引擎 HTTP 桥接
│
├── r-engine/                   # R 计算引擎
│   ├── Dockerfile              # rocker/r-ver:4.3.2 + 预编译 R 库
│   ├── plumber.R               # API 入口 (所有端点)
│   ├── install_packages.R      # 从零安装 R 包脚本 (备用)
│   ├── R/                      # 分析模块
│   │   ├── data_plot.R         # 绘图函数 (QC/降维/差异/Marker)
│   │   └── data_summary.R     # 数据汇总函数
│   └── data/                   # SingleR 参考数据等（首次运行时自动下载，无需手动准备）
│
├── nginx/
│   └── nginx.conf              # 反向代理配置
│
├── data/
│   ├── sccloud_v2_dump.sql     # 数据库初始化 SQL
│   └── sccloud-r-engine-image.tar.gz  # 预构建 R 引擎镜像 (~2GB)
│
├── start.sh                    # 一键启动（对齐闲鱼助手）
├── docker-compose.yml          # 一键桥接部署（secrets + 加固 + digest pin）
├── docker-compose.rootless.yml # rootless/本机绑定叠加
├── docker-compose.server.yml   # 高级 host 网络
├── secrets/                    # 密钥目录（gitignore；向导生成）
├── scripts/setup-wizard.sh
├── scripts/sccloud-ops.sh
├── nginx/nginx.bridge.conf
├── docker-compose.dev.yml      # 开发环境 (仅 Redis)
│
├── .env.example                # 环境变量模板
└── .gitignore
```

---

## API 端点

### 认证 (`/api/auth`)

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/register` | 注册 |
| POST | `/api/auth/login` | 登录 (OAuth2 表单) |
| POST | `/api/auth/refresh` | 刷新 Token |
| GET | `/api/auth/me` | 当前用户信息 |
| POST | `/api/auth/change-password` | 修改密码 |

### 项目 (`/api/projects`)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/projects` | 列出项目 |
| POST | `/api/projects` | 创建项目 |
| DELETE | `/api/projects/{id}` | 删除项目 |

### 任务 (`/api/tasks`)

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/tasks` | 提交分析任务 |
| GET | `/api/tasks` | 查询任务 (支持 project_id/status 筛选) |
| GET | `/api/tasks/{id}` | 获取任务详情 |
| POST | `/api/tasks/{id}/cancel` | 取消任务 |
| GET | `/api/tasks/example-marker` | 下载示例 marker.txt |
| POST | `/api/tasks/marker-file` | 上传 marker 基因文件 |

### 文件上传 (`/api/upload`)

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/upload/init` | 初始化分片上传 |
| POST | `/api/upload/chunk` | 上传单个分片 |
| POST | `/api/upload/complete` | 合并分片 |
| GET | `/api/upload/status/{id}` | 查询上传进度 |

### 格式转换 (`/api/convert`)

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/convert/upload` | 上传转换文件 |
| POST | `/api/convert` | 执行格式转换 |

### 系统

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| WS | `/ws/tasks/{id}` | 任务进度 WebSocket |

---

## 常见问题

### R 引擎构建失败

R 引擎需要预编译的 R 包库（`r-engine/r-library/`）。如果没有，使用方式 B（预构建镜像）或方式 C（从零编译）。

```bash
# 检查 R 引擎是否正常
curl http://localhost:8787/health
# 预期返回: {"status":"ok"}

# 查看 R 引擎日志
docker compose logs r-engine
```

### SingleR 参考数据

SingleR 细胞注释所需的参考数据集（~460MB）**无需手动准备**。首次运行自动注释时，`celldex` 包会自动从 Bioconductor 下载并缓存到容器内 `~/.cache/R/ExperimentHub/`。后续分析直接从缓存读取。

如果下载失败（网络问题），可重试任务或检查 R 引擎容器的网络连通性：

```bash
docker exec sccloud-r-engine-r-engine-1 curl -I https://experimenthub.bioconductor.org
```

### 数据库初始化

首次启动时，MariaDB 会自动执行 `data/sccloud_v2_dump.sql` 初始化表结构。如果需要重新初始化：

```bash
# 删除数据库卷并重建
docker compose down -v
docker compose up -d
```

### 上传大文件超时

默认支持最大 **30 GB** 文件上传。如遇超时，检查：

1. Nginx `client_max_body_size`（默认 30G）
2. 后端 `R_ENGINE_TIMEOUT`（默认 3600 秒）
3. Nginx `proxy_read_timeout`（默认 3600 秒）

### 内存不足

R 引擎默认限制 16 GB 内存。如分析大数据集 OOM：

```yaml
# docker-compose.yml 中修改
r-engine:
  deploy:
    resources:
      limits:
        memory: 32G  # 增加到 32GB
```

---

## 开发模式

适用于前端/后端开发调试，无需全量 Docker 构建：

```bash
# 1. 启动基础服务 (Redis + MariaDB)
docker compose -f docker-compose.dev.yml up -d

# 2. 启动后端 (热重载)
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp ../.env.example ../.env  # 配置环境变量
uvicorn app.main:app --reload --port 8000

# 3. 启动前端 (热重载)
cd frontend
npm install
npm run dev

# 4. R 引擎 (Docker)
docker run -p 8787:8787 \
  -v $(pwd)/r-engine/plumber.R:/app/plumber.R:ro \
  -v $(pwd)/r-engine/R:/app/R:ro \
  sccloud-r-engine
```

---

## License

MIT
