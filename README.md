# scCloud

单细胞 RNA-seq 分析平台。前端 Next.js 16，后端 FastAPI，计算侧 R / Seurat 5（Plumber + worker）。浏览器里跑全流程 Pipeline：Phase 1（质控 → 注释）结束后可选 Phase 2（差异基因、富集、CellChat 等）。

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

![scCloud Dashboard](docs/images/dashboard.png)

## 目录

- [架构](#架构)
- [快速开始](#快速开始)
  - [预构建镜像（GHCR）](#预构建镜像ghcr)
  - [发版](#发版)
  - [R 引擎镜像](#r-引擎镜像)
  - [不用 start.sh](#不用-startsh)
- [Host 网络部署](#host-网络部署)
- [环境变量](#环境变量)
- [分析流程](#分析流程)
- [项目结构](#项目结构)
- [API](#api)
- [常见问题](#常见问题)
- [本地开发](#本地开发)
- [部署后 UI 回归](#部署后-ui-回归)
- [License](#license)

## 架构

桥接 compose（`start.sh` 默认）对外一般只有 `WEB_PORT`；下图端口是 host 网络 / 容器内常见取值，方便对照。

```
┌─────────────────────────────────────────────────────────────┐
│                     Nginx (:9000)                           │
│                      反向代理入口                             │
├──────────────────┬──────────────────┬───────────────────────┤
│  Frontend (:3001)│  Backend (:8000) │   WebSocket (/ws/)    │
│  Next.js         │  FastAPI         │   任务进度            │
├──────────────────┴──────────────────┴───────────────────────┤
│            R-Engine (:8787)  Plumber + worker               │
├──────────────────┬──────────────────────────────────────────┤
│ MariaDB (:3307)  │              Redis (:6380)               │
└──────────────────┴──────────────────────────────────────────┘
```

| 组件 | 技术 | 作用 |
|------|------|------|
| 前端 | Next.js 16, deck.gl, Plotly | UI；UMAP 等用 WebGL |
| 后端 | FastAPI, SQLAlchemy 2, Redis | REST、鉴权、编排、WS 进度 |
| R 引擎 | R 4.3.2, Seurat 5, Plumber | HTTP 计算（`plumber.R`） |
| Worker | 同镜像 `worker.R` | 吃队列，跑 pipeline 各步 |
| DB | MariaDB 11 | 用户 / 项目 / 任务 |
| 缓存 | Redis 7 | 队列、进度 |
| 入口 | Nginx | 反代、WS、大上传 |

## 快速开始

需要：Docker ≥ 24、Compose v2；内存建议 ≥ 16 GB（大数据集 32 GB+）；磁盘预留几十 GB（R 镜像 + 项目数据）。

```bash
git clone https://github.com/zyzhou-saffron/sccloud.git
cd sccloud
sh ./start.sh
```

`start.sh` 大致会：

1. 检查 Compose v2（默认不装 Docker；共享机可 `sh ./start.sh --install-docker`）
2. 没有 `.env` / `./secrets/*` 时跑 `scripts/setup-wizard.sh`，密钥写到 **`./secrets/`**；默认管理员 `admin` / `admin123`
3. `WEB_PORT` 默认 `8080`，被占用则 +1…+9 并写回 `.env`
4. 能拉 GHCR 就 `compose pull`，否则本地 build
5. R 镜像：本地 tag → `data/sccloud-r-engine-image.tar.gz` load → 有 `r-engine/r-library` 再 build
6. `up -d`，等 db / redis / backend / r-engine 和入口 `/healthz`

浏览器打开 `http://localhost:${WEB_PORT}`（默认 8080）。空库首次起来会建管理员。

密钥只放 `./secrets/`（compose secrets）。容器默认 `no-new-privileges`、`cap_drop: ALL`；nginx / frontend / redis / db 另加 `read_only` 和非 root；MariaDB / Redis / nginx 镜像钉 digest。

```bash
sh ./scripts/sccloud-ops.sh status
sh ./scripts/sccloud-ops.sh logs
sh ./scripts/sccloud-ops.sh stop

sh ./start.sh --build      # 强制本地构建
sh ./start.sh --no-pull    # 不 pull

SCLOUD_ROOTLESS=1 sh ./start.sh
# 或: export COMPOSE_FILE=docker-compose.yml:docker-compose.rootless.yml
```

### 预构建镜像（GHCR）

| 镜像 | 说明 |
|------|------|
| `ghcr.io/zyzhou-saffron/sccloud-frontend` | CI 推送，**只打 linux/amd64**（arm64 在 QEMU 里 Next 静态生成会 SIGILL） |
| `ghcr.io/zyzhou-saffron/sccloud-backend` | CI 推送，**amd64 + arm64** |
| `ghcr.io/zyzhou-saffron/sccloud-r-engine` | 不进 FE/BE 的 publish workflow；本机/GPU 有 `r-library` 再 build、push（token 要 `write:packages`） |

| 何时 | tag |
|------|-----|
| `main` 改 `frontend/**` 或 `backend/**` | `latest` + 短 SHA（只建改动的那个） |
| GitHub Release（Release Please 合并后） | 再加 `vX.Y.Z`、`X.Y.Z` |
| Actions 手动 `workflow_dispatch` | FE/BE 都建 `latest` + SHA |

包设成 Public 最省事。私有包先 `docker login ghcr.io`。

可选 mirror 到阿里云 ACR：仓库 Variables/Secrets 配好 `ALIYUN_ACR_*` 后，CI 用 `buildx imagetools` 推过去（backend 多架构，frontend 只有 amd64）。`.env` 里把 `FRONTEND_IMAGE` / `BACKEND_IMAGE` 改成 ACR 前缀，见 `.env.example`。

### 发版

用 [release-please](https://github.com/googleapis/release-please)。`main` 上 `feat:` / `fix:` 会堆到 Release PR 里（改 `CHANGELOG.md`、`version.txt`、`.release-please-manifest.json`）。`ci:` / `chore:` 默认不进 CHANGELOG；没映射的类型（例如 `ui:`）也不会进。

1. 日常用 conventional commit
2. 打开**还没合的** Release PR，对过 CHANGELOG 再合（版本看 PR 标题 / manifest；合之前 main 上 `version.txt` 可能还是旧的）
3. 合完打 `vX.Y.Z` tag，建 GitHub Release
4. `release` 事件跑 docker-publish，FE/BE 推 `latest`、短 SHA、semver

别在 main 上手改 `version.txt` 和 release-please 抢。Release PR 没合就不算发过版。

### R 引擎镜像

`r-library/` 不进 git，镜像也大。查找顺序：

1. GHCR pull（`start.sh` 默认）
2. 本机已有 `sccloud-r-engine` / 目标 tag
3. `data/sccloud-r-engine-image.tar.gz` → `docker load`
4. 本地 build（先准备 `r-engine/r-library`）：

```bash
cp -r /path/to/R/library r-engine/r-library
docker build -t ghcr.io/zyzhou-saffron/sccloud-r-engine:latest ./r-engine
docker push ghcr.io/zyzhou-saffron/sccloud-r-engine:latest   # 需要 write:packages
```

从零装包大约两小时量级：改 Dockerfile，用 `install_packages.R` 代替 `COPY r-library/`。

只改了 `plumber.R` / `worker.R` / `run_job.R` / `R/` 时，可以基于现有 `sccloud-r-engine` 做一层 thin bake（`FROM` 后再 `COPY`），不必重编整个 library。全量 build 要构建机能拉 apt；拉不动就先 thin bake。机器上如果 bind-mount 了 `worker.R`，跑的是挂载文件，不是镜像里那份。

### 不用 start.sh

```bash
sh ./scripts/setup-wizard.sh   # 或 cp .env.example .env 再改
docker compose --env-file .env pull
docker compose --env-file .env up -d
curl -fsS "http://127.0.0.1:${WEB_PORT:-8080}/healthz"
```

SQL 可放 `data/initdb.d/`，只在 **空** MariaDB volume 第一次启动时导入。库里已有 users 就不会再 bootstrap 管理员。

## Host 网络部署

日常用桥接 + `start.sh` 即可。`docker-compose.server.yml` 是 host 网络，给要绑核、worker 内存很大的机器用。

| 服务 | 端口 | 说明 |
|------|------|------|
| Nginx | 9000 | 对外入口 |
| Frontend | 3001 | Next.js |
| Backend | 8000 | FastAPI |
| R-Engine | 8787 | Plumber |
| MariaDB | 3307 | 躲开宿主机 3306 |
| Redis | 6380 | 躲开宿主机 6379 |

```bash
cp .env.example .env.server
# 至少改 DB 密码、JWT（openssl rand -hex 32）

docker compose --env-file .env.server -f docker-compose.server.yml up -d --build
docker compose -f docker-compose.server.yml ps
docker compose -f docker-compose.server.yml logs -f r-engine
```

访问 `http://<server-ip>:9000`。

```bash
# 改 R 代码后
docker compose --env-file .env.server -f docker-compose.server.yml restart r-engine

# 改前端后
docker compose --env-file .env.server -f docker-compose.server.yml up -d --build frontend
```

## 环境变量

一键部署靠 `setup-wizard.sh` 写 `.env` 和 `./secrets/`。完整列表见 `.env.example`。

| 变量 | 默认 | 必填 | 说明 |
|------|------|------|------|
| `WEB_PORT` | `8080` | | 对外端口（占用会换） |
| `WEB_BIND_ADDRESS` | `0.0.0.0` | | rootless 叠加时常为 `127.0.0.1` |
| `FRONTEND_IMAGE` / `BACKEND_IMAGE` / `R_ENGINE_IMAGE` | GHCR `…/sccloud-*:latest` | | 可改成 ACR |
| `DB_NAME` | `sccloud_v2` | | |
| `DB_USER` | `sccloud_app` | | |
| `./secrets/db-password` | 向导生成 | ✅ | 应用库密码 |
| `./secrets/db-root-password` | 向导生成 | ✅ | root |
| `./secrets/jwt-secret` | 向导生成 | ✅ | JWT |
| `./secrets/redis-password` | 向导生成 | ✅ | Redis requirepass |
| `./secrets/bootstrap-admin-password` | `admin123` | | 空库首个管理员密码 |
| `R_REDIS_URL` | 向导写入 | | R 侧带密码的 Redis URL |
| `JWT_ALGORITHM` | `HS256` | | |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `60` | | |
| `REFRESH_TOKEN_EXPIRE_DAYS` | `30` | | |
| `R_ENGINE_TIMEOUT` | `86400` | | R 请求超时（秒） |
| `R_ENGINE_MEM_LIMIT` / `R_WORKER_MEM_LIMIT` | `16g` / `32g` | | 容器内存上限 |
| `PROJECTS_ROOT` | `/data/projects` | | 项目数据目录 |
| `BOOTSTRAP_ADMIN_USER` | `admin` | | |
| `SCLOUD_ROOTLESS` | `0` | | `1` 叠加 rootless compose |
| `ENVIRONMENT` | `production` | | |

## 分析流程

主入口是 **全流程 Pipeline**（旧单步 UI 已归档，见 issue #16）。Phase 1 跑完会暂停，确认注释后再配 Phase 2。

**Phase 1**

```
1. QC / 标准化
2. 降维与聚类（PCA / UMAP / Harmony + Louvain）
3. 细胞注释（SingleR 或手动）
```

**Phase 2（按需）**

```
4. markers     FindMarkers
5. enrich      GO / KEGG / GSEA
6. cellchat    CellChat
7. wgcna
8. monocle     Monocle 2
9. infercnv
```

另外还有：H5AD / H5Seurat / 表格式 ↔ RDS；10X ZIP 多样本整合；deck.gl UMAP；Plotly 火山图；进度走 Redis → WebSocket。

<details>
<summary>截图</summary>

**UMAP**
![UMAP](docs/images/umap.png)

**火山图**
![volcano](docs/images/volcano.png)

**Marker**
![marker](docs/images/marker.png)

</details>

## 项目结构

```
sccloud/
├── frontend/
│   ├── Dockerfile              # CI 只建 amd64
│   └── src/app/
│       ├── lib/api.ts
│       ├── components/         # ResultViewer、charts、TaskHistory
│       ├── dashboard/analysis/ # PipelineForm / PipelineView
│       ├── convert/
│       └── settings/
├── backend/
│   ├── Dockerfile
│   ├── pyproject.toml
│   └── app/                    # auth, projects, pipeline, tasks, upload, convert, ws
├── r-engine/
│   ├── Dockerfile
│   ├── plumber.R
│   ├── worker.R                # compose 服务 r-engine-worker
│   ├── install_packages.R
│   ├── R/
│   └── data/                   # SingleR 等，运行时再下
├── .claude/skills/frontend-ui-test/
├── nginx/
├── data/                       # init SQL；可选 r-engine tar
├── start.sh
├── docker-compose.yml
├── docker-compose.rootless.yml
├── docker-compose.server.yml
├── docker-compose.dev.yml
├── secrets/                    # gitignore，向导生成
├── scripts/setup-wizard.sh
├── scripts/sccloud-ops.sh
└── .env.example
```

## API

### 认证 `/api/auth`

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/register` | 注册 |
| POST | `/api/auth/login` | 登录（OAuth2 表单） |
| POST | `/api/auth/refresh` | 刷新 token |
| GET | `/api/auth/me` | 当前用户 |
| POST | `/api/auth/change-password` | 改密 |

### 项目 `/api/projects`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/projects` | 列表 |
| POST | `/api/projects` | 创建 |
| DELETE | `/api/projects/{id}` | 删除 |

### 任务 `/api/tasks`

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/tasks` | 提交 |
| GET | `/api/tasks` | 查询（可按 project_id / status） |
| GET | `/api/tasks/{id}` | 详情 |
| POST | `/api/tasks/{id}/cancel` | 取消 |
| GET | `/api/tasks/example-marker` | 示例 marker.txt |
| POST | `/api/tasks/marker-file` | 上传 marker 文件 |

### 上传 `/api/upload`

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/upload/init` | 初始化分片 |
| POST | `/api/upload/chunk` | 分片 |
| POST | `/api/upload/complete` | 合并 |
| GET | `/api/upload/status/{id}` | 进度 |

### 转换 `/api/convert`

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/convert/upload` | 上传待转文件 |
| POST | `/api/convert` | 执行转换 |

### 系统

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| WS | `/ws/tasks/{id}` | 任务进度 |

## 常见问题

### R 引擎起不来 / 没镜像

没有 `r-engine/r-library/` 时，用 GHCR、本机已有 tag，或 `data/sccloud-r-engine-image.tar.gz` load；再不行就按上面从零 build。

```bash
curl http://localhost:8787/health    # 期望 {"status":"ok"}
docker compose logs r-engine
```

### SingleR 参考数据

第一次自动注释时 `celldex` 会从 Bioconductor 拉参考（大约几百 MB），缓存在容器 `~/.cache/R/ExperimentHub/`。失败多半是出网问题：

```bash
docker exec sccloud-r-engine-r-engine-1 curl -I https://experimenthub.bioconductor.org
```

### 数据库重来

首次启动会跑 `data/sccloud_v2_dump.sql`。要清空重来：

```bash
docker compose down -v   # 会删 volume，先确认没有要留的数据
docker compose up -d
```

### 大文件上传超时

默认上限大约 30 GB。超时看：Nginx `client_max_body_size`、`proxy_read_timeout`；后端 / R 的 timeout 相关变量。

### 内存不够

R 引擎默认约 16 GB 上限。大数据集 OOM 时在 compose 里加大 `deploy.resources.limits.memory`，或调 `R_ENGINE_MEM_LIMIT` / `R_WORKER_MEM_LIMIT`。

## 本地开发

不必整栈 Docker build 时：

```bash
docker compose -f docker-compose.dev.yml up -d   # Redis + MariaDB

cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp ../.env.example ../.env
uvicorn app.main:app --reload --port 8000

cd frontend
npm install
npm run dev

docker run -p 8787:8787 \
  -v "$(pwd)/r-engine/plumber.R:/app/plumber.R:ro" \
  -v "$(pwd)/r-engine/R:/app/R:ro" \
  sccloud-r-engine
```

## 部署后 UI 回归

仓库里有一份 Claude skill，用浏览器**真点击**做回归，不是 Playwright / Cypress CI：

[`.claude/skills/frontend-ui-test/SKILL.md`](.claude/skills/frontend-ui-test/SKILL.md)

覆盖登录、导航、全流程 Phase 1，以及 Phase 2 至少 markers。提交分析应走 UI；health / pipeline GET 只做旁证。跑的时候带上当次环境的 `BASE_URL`（需要的话再加 SSH / compose）。细节和判定标准在 skill 正文；只想确认进程活着可以用里面的 deploy-smoke 最小集。

## License

MIT
