# 维护者文档

面向改代码、发版、编镜像、管机器的人。最终用户请看仓库根目录 [README.md](../README.md)。

## 架构端口对照

桥接 compose（`start.sh` 默认）对外一般只有 `WEB_PORT`（容器内 nginx 听 8080）。下表是 **host 网络 / 容器内**常见取值，方便对照 `docker-compose.server.yml`。

```
┌─────────────────────────────────────────────────────────────┐
│                     Nginx (:9000 host 网络入口)              │
├──────────────────┬──────────────────┬───────────────────────┤
│  Frontend (:3001)│  Backend (:8000) │   WebSocket (/ws/)    │
├──────────────────┴──────────────────┴───────────────────────┤
│            R-Engine (:8787)  Plumber + worker               │
├──────────────────┬──────────────────────────────────────────┤
│ MariaDB (:3307)  │              Redis (:6380)               │
└──────────────────┴──────────────────────────────────────────┘
```

| 组件 | 技术 | 作用 |
|------|------|------|
| 前端 | Next.js 16, deck.gl, Plotly | UI |
| 后端 | FastAPI, SQLAlchemy 2, Redis | REST、鉴权、编排、WS |
| R 引擎 | R 4.3.2, Seurat 5, Plumber | HTTP 计算 |
| Worker | 同镜像 `worker.R` | 队列重任务 |
| DB | MariaDB 11 | 用户 / 项目 / 任务 |
| 缓存 | Redis 7 | 队列、进度 |

## 预构建镜像（GHCR）

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

包建议 Public。可选 ACR：Variables/Secrets 配 `ALIYUN_ACR_*`，CI 用 `buildx imagetools` mirror（backend 多架构，frontend 仅 amd64）。

推 R 镜像时加 OCI label，才会出现在仓库 Packages 页：

```dockerfile
LABEL org.opencontainers.image.source="https://github.com/zyzhou-saffron/sccloud"
```

## 发版（Release Please）

[release-please](https://github.com/googleapis/release-please) 在 `main` 上根据 `feat:` / `fix:` 维护 Release PR（`CHANGELOG.md`、`version.txt`、`.release-please-manifest.json`）。`ci:` / `chore:` 默认不进 CHANGELOG。

1. 日常 conventional commits  
2. 审未合并的 Release PR，确认 CHANGELOG 后合并  
3. 自动打 `vX.Y.Z` + GitHub Release  
4. `release` 事件触发 docker-publish，FE/BE 推 semver tag  

不要在 main 上手改 `version.txt` 与 release-please 抢跑。未合 Release PR 就不算发过版。

## R 引擎镜像

`r-library/` 不进 git。查找顺序见用户 README；维护者常用：

```bash
cp -r /path/to/R/library r-engine/r-library
docker build -t ghcr.io/zyzhou-saffron/sccloud-r-engine:latest ./r-engine
docker push ghcr.io/zyzhou-saffron/sccloud-r-engine:latest
```

从零装包约两小时：Dockerfile 用 `install_packages.R` 代替 `COPY r-library/`。

只改 `plumber.R` / `worker.R` / `run_job.R` / `R/` 时，可 `FROM` 现有镜像再 `COPY` 做 thin bake，避免重编 library。注意：若 compose bind-mount 了这些文件，进程读的是挂载内容不是镜像层。

Dockerfile 需 `COPY plumber.R worker.R run_job.R`，无挂载时 worker 才能启动。

## Host 网络部署

`docker-compose.server.yml`：绑核、大内存 worker 等场景。

```bash
cp .env.example .env.server
# 配置 DB / JWT 等；生产勿用默认管理员口令

docker compose --env-file .env.server -f docker-compose.server.yml up -d --build
# 或 pull 预构建镜像后 up -d（按 .env 中 IMAGE 变量）
```

访问 `http://<server-ip>:9000`。

## 环境变量与 secrets

完整列表见 [`.env.example`](../.env.example)。一键部署由 `scripts/setup-wizard.sh` 写 `.env` 与 `./secrets/`。

要点：

- DB / JWT / Redis / bootstrap 管理员密码在 **`./secrets/`**，compose secrets 挂载  
- `R_REDIS_URL` 由向导/start 按 redis 密码生成  
- `PROJECTS_ROOT` 默认 `/data/projects`；桥接栈多为 named volume `projects_data`  
- `SCLOUD_ROOTLESS=1` 叠加 `docker-compose.rootless.yml`  
- 安全：`no-new-privileges`、`cap_drop`；部分服务 `read_only`；基础镜像钉 digest  

## 项目数据路径

```text
/data/projects/{user.id}/{project_name}/
  _uploaded/    # 上传
  ...           # 分析结果
```

- 游客：`guest_<uuid>`，`user.id` 仍为数字目录；默认短保留（见 `ROLE_DEFAULTS`）  
- `storage_path` 存在 DB；更换 volume / `PROJECTS_ROOT` 后旧路径会失效  
- server 栈常 bind 宿主机大盘；与一键 named volume **不要混用同一套 DB 却不迁文件**  

## 不用 start.sh

```bash
sh ./scripts/setup-wizard.sh
docker compose --env-file .env pull
docker compose --env-file .env up -d
curl -fsS "http://127.0.0.1:${WEB_PORT:-8080}/healthz"
```

桥接栈 R 探活：`http://127.0.0.1:${WEB_PORT}/r-health`（8787 默认不映射到宿主）。

SQL 可放 `data/initdb.d/`，仅空 MariaDB volume 首次导入。库中已有 users 不会再次 bootstrap 管理员。

## 本地开发

```bash
docker compose -f docker-compose.dev.yml up -d   # Redis + MariaDB

cd backend && python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8000

cd frontend && npm install && npm run dev

docker run -p 8787:8787 \
  -v "$(pwd)/r-engine/plumber.R:/app/plumber.R:ro" \
  -v "$(pwd)/r-engine/R:/app/R:ro" \
  sccloud-r-engine
```

## 部署后 UI 回归

[`.claude/skills/frontend-ui-test/SKILL.md`](../.claude/skills/frontend-ui-test/SKILL.md) — 浏览器真点击回归（非 Playwright CI）。带上环境 `BASE_URL`。

## 项目结构（摘）

```
sccloud/
├── frontend/          # Next.js；CI 仅 amd64
├── backend/           # FastAPI
├── r-engine/          # plumber + worker + Dockerfile
├── nginx/
├── start.sh
├── docker-compose.yml
├── docker-compose.rootless.yml
├── docker-compose.server.yml
├── secrets/           # gitignore
├── scripts/
└── docs/
```

## API 索引

认证 `/api/auth`：register、login、refresh、me、change-password；另有 guest / upgrade-guest。  
项目 `/api/projects`：CRUD。  
任务 `/api/tasks`：提交、查询、取消、marker。  
上传 `/api/upload`：分片 init/chunk/complete。  
转换 `/api/convert`。  
系统：`GET /api/health`，`WS /ws/tasks/{id}`。

入口健康：桥接 `GET /healthz`（经 nginx）。
