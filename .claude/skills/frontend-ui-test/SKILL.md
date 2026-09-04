---
name: frontend-ui-test
description: Run scCloud frontend UI regression via real UI clicks (not API task submit). Use after deploy/release, after worker/r-engine/frontend changes, before calling an environment healthy, or when the user asks for 冒烟/smoke/UI 检查/frontend-ui-test/回归 on sccloud — any host (local, staging, GPU, etc.).
---

# scCloud frontend UI test（前端点击）

对**任意已部署的 scCloud 实例**做可操作的 UI 回归（全流程主路径）。  

**禁止**用 API 直接 `submitTask` / 创建 pipeline 代替点击。API 仅用于：健康探测、读 pipeline/task 状态旁证、下载示例数据。

本 skill 是**通用流程 + 判定标准**；具体 host/端口/账号由**当次对话的目标环境**提供（见「实例配置」），不要把某台机器的路径写死进流程。

## 测试技术栈

**不是** Playwright / Cypress / Jest 自动化套件；是 **Claude Code + 浏览器预览（或等价可点击浏览器）** 的点击回归。

| 层 | 技术（通用） | 用途 |
|----|--------------|------|
| 被测应用 | scCloud compose：Next.js FE + FastAPI + R engine/worker + DB + Redis +（可选）Nginx | 浏览器可打开的 Web 入口 |
| 到达入口 | 直连 `BASE_URL`，或 SSH 本地转发 + 本机 HTTP 反代 | 预览工具需要稳定的本机/可达 URL |
| UI 驱动 | Claude Browser 预览：`preview_start` / `snapshot` / `click` / `fill` / `screenshot`；大段 `preview_eval` 慎用 | 真实点击与断言文案 |
| 旁证 CLI | `curl`、compose/`docker` 日志与 exec、（可选）`gh` | health、pipeline GET、worker 日志 |
| 判定产物 | Markdown 报告（文末模板） | PASS / FAIL / PASS-with-known-issues |

**默认不用：** Playwright、Cypress、Selenium、Jest/Vitest 当本 skill 的门禁；CI 无人值守 E2E 应另开 skill/workflow。

### 到达 `BASE_URL` 的常见模式（选一，非绑定）

1. **已有公网/内网 URL** → 预览直接打开 `BASE_URL`。  
2. **SSH 可达的远端 compose** → `ssh -N -L <local>:<remote_bind> <SSH_HOST>`，本机 `http://127.0.0.1:<local>` 即为入口（若预览必须走独立端口，可再套一层只做反代的本地进程）。  
3. **本机已在跑的 dev/compose** → `BASE_URL=http://127.0.0.1:<port>`。

反代若使用 Python `urllib`，建议请求侧 `Accept-Encoding: identity`，避免把 gzip 原文当 HTML。

## 实例配置（每次运行前确认）

从用户消息、部署文档或当前会话推断并**写进报告「环境备注」**，缺项先问再测：

| 变量 | 含义 | 示例（仅说明格式，非默认值） |
|------|------|------------------------------|
| `BASE_URL` | 浏览器打开的站点根 | `http://127.0.0.1:8091` |
| `SSH_HOST` | 可选；需上机看日志/compose 时 | 部署文档中的 SSH 别名（**大小写按 config**） |
| `COMPOSE_DIR` | 可选；远端或本机项目目录 | 含 `docker-compose.yml` / `start.sh` 的路径 |
| `WEB_PORT` | 宿主机映射端口 | 与 `BASE_URL` 一致 |
| 账号 | 可登录的用户 | 部署 `.env` / 密钥文档；常见 dev 仅作 fallback |
| 样本项目 | 已有小 RDS 的项目名，或新建 | 优先「从项目文件选择」，避免无谓大文件拷贝 |

运维旁证（有 `SSH_HOST` + `COMPOSE_DIR` 时）：

```bash
# 模式示意 — 替换变量后执行
ssh "$SSH_HOST" "cd \"$COMPOSE_DIR\" && git log -1 --oneline && sh ./scripts/sccloud-ops.sh status"
curl -sS "$BASE_URL/api/health"
# 期望: status=ok 且 db/redis connected
```

Worker 相关（容器名以该环境 `compose ps` 为准）：

```bash
ssh "$SSH_HOST" 'docker exec <r-engine-worker容器> grep -n pid_alive /app/worker.R | head'
```

## 何时使用

- 任意环境 `pull` / `start.sh` / recreate 之后  
- worker / 全流程 / 登录导航相关修复后  
- 用户说「冒烟」「smoke」「前端点一遍」「UI 回归」「frontend-ui-test」  
- 发布前称环境 healthy 之前  

## 约束（硬）

| 做 | 不做 |
|----|------|
| 前端点击提交分析 | 用 API 创建 pipeline/task 冒充 UI 通过 |
| 旁证可用 health / pipeline GET / 日志 | `docker compose down -v`（清卷）除非用户明确要求 |
| 保留 DB/Redis/projects 数据卷 | 改动与本次目标无关的其它服务/端口 |
| 报告写清 `BASE_URL` 与 git HEAD | 把某一台机器的私有路径写死为 skill 唯一入口 |

（仓库/组织级额外禁忌以用户或 CLAUDE.md 为准，例如禁止碰某业务端口、禁止未授权 merge。）

## 流程总览

```
0 确认实例配置 → 1 打开 BASE_URL 预览 → 2 登录
→ 3 导航/按钮 → 4 选项目+加样本（点击）
→ 5 开始全流程 Phase1 → 6 Phase2（至少 markers）
→ 7 worker 日志无假 OOM（若可上机）→ 8 出报告
```

深度可选：`enrich` / CellChat / WGCNA / Monocle / inferCNV（默认**不要求**全开）。

## Checklist 与判定

每项：`PASS` / `FAIL` / `SKIP` + 一句证据（UI 文案、截图、API 旁证、日志）。

### A. 健康与进程（阻断）

| ID | 检查 | 成功标准 | 失败标准 |
|----|------|----------|----------|
| A1 | `GET {BASE_URL}/api/health` | `status=ok` 且 db/redis connected | 非 200、status≠ok、依赖断开 |
| A2 | compose `ps`（可上机时） | backend/web healthy；frontend/worker Up | 关键服务 Exit / unhealthy >2min |
| A3 | worker 含 `pid_alive`（可上机且相关时） | worker 脚本能 grep 到 | 无该符号且仍用旧判定 |
| A4 | 登录 → 业务账号进 dashboard | 无死循环 401、无白屏 | 无法登录 |

**门禁：** A1、A4 必过；A2/A3 在可上机时必过。任一适用项 FAIL → 整次 **FAIL**。

### B. 导航与按钮（主入口阻断）

| ID | 检查 | 成功标准 | 失败标准 |
|----|------|----------|----------|
| B1 | 侧栏：分析流程 / 多样本整合 / 设置 / 用户管理（权限内） | 可进对应页 | 404、空白、控制台红错阻断 |
| B2 | 项目选择器 | 能选已有或新建 | 非「真无项目」却无法选/建 |
| B3 | 分析页全流程 | PipelineForm（加样本 / 开始全流程） | 无法进入 pipeline 路径 |
| B4 | 添加样本 → 本地上传 / 从项目文件选择 | 菜单可开；能选中 RDS | 无响应；选后表不更新 |
| B5 | 导出项目 / 历史记录 | 可点；历史能打开已有流水线 | 无响应或明确 500（导出未落盘可非阻断） |
| B6 | 设置：改密表单 + 系统状态 | 表单与状态区渲染 | 整页报错 |
| B7 | 用户管理（admin） | 表可见；编辑/删除入口在 | admin 应进却进不去 |

**门禁：** B1/B3/B4 FAIL → **FAIL**。

### C. 全流程 Phase 1（阻断）

前置：项目内可用 RDS（优先「从项目文件选择」）。

| ID | 检查 | 成功标准 | 失败标准 |
|----|------|----------|----------|
| C1 | 样本表 ≥1 文件/样本 | 有细胞数等元数据 | 空表点开始静默失败 |
| C2 | 「开始全流程分析」 | 进 PipelineView；有运行中/进度 | 无跳转、立刻 error、未创建 |
| C3 | Phase1 步骤 | QC/标准化、降维聚类、注释均完成 | 任一步 failed 或假 OOM 文案 |
| C4 | Phase1 结束 | **已暂停** 等 Phase2（或产品等价） | 整单 failed |
| C5 | 关键结果 | 表/UMAP 或 canvas/注释等至少一类可见 | 完成但结果空白且 API 无 result |

**门禁：** C2/C3 FAIL → **FAIL**。

### D. 全流程 Phase 2（默认最小集）

| ID | 检查 | 成功标准 | 失败标准 |
|----|------|----------|----------|
| D1 | Phase2 参数页 | 能选步骤并开始 | 空白/按钮死 |
| D2 | 至少 **markers** | 完成；表或下载入口可见 | failed / 假 OOM |
| D3 | 终态 | UI + 旁证 **completed**（或所选子集全成功） | failed / running 超时 |
| D4 | （可选）其它高级步骤 | 选跑则完成 + 有结果入口 | 选跑却 failed |

默认：**D1–D3 必过**；D4 仅「深测」时要求。

### E. Worker / 日志旁证（可上机时与 C/D 绑定）

| ID | 检查 | 成功标准 | 失败标准 |
|----|------|----------|----------|
| E1 | 无假 OOM | 无 `run_job 进程退出但无结果(可能崩溃/OOM)` 误报 | 有该串且任务失败 |
| E2 | 步骤 HTTP | 相关 step 成功（如 `http_status=200`） | 反复 5xx / 无结果文件 |
| E3 | 真 vs 假崩溃 | 真 OOM 有 dmesg/容器证据并如实写 FAIL/资源问题 | 把真 OOM 报成通过 |

不可上机时：E 记 `SKIP`，但 C/D 的 UI 失败仍算 FAIL。

### F. 已知非阻断（记问题，不单判整次 FAIL）

| ID | 现象 | 处理 |
|----|------|------|
| F1 | 完成后横幅仍像「去设 Phase2」而状态已是已完成 | 文案 stale |
| F2 | 刷新后上传表空，盘上文件仍在 | session；用「从项目文件选择」 |
| F3 | 设置页角色展示与真实权限不一致 | 展示问题 |
| F4 | 图为 canvas/WebGL 非 `<img>` | 用快照/表证明即可 |
| F5 | 导出未核浏览器落盘 | 可选 |
| F6 | 未设 `sample_groups` 则无 Group 列 | **预期**；要验分组须故意设 |

随产品修复可删改 F 项；新问题进「新问题」列表。

## 超时建议

| 阶段 | 小样本（~2k cells）量级 | 超时后 |
|------|-------------------------|--------|
| Phase1 | 常数十分钟级 | 查 worker + pipeline；仍无进展 → FAIL-timeout |
| markers | 常数分钟到数十分钟 | 同上 |
| 单次 UI | ~30s | 重试一次点击/刷新 |

具体环境以机器负载为准，报告写实际耗时。

## 方法要点

1. **只点 UI** 提交；health / `GET` pipeline 仅旁证。  
2. 优先 `preview_snapshot` + `preview_click`；少用易超时的大 `preview_eval`。  
3. 刷新丢文件列表 → **从项目文件选择**，勿误判存储丢失。  
4. 历史成功 run 只助验 B5，**不能替代**部署后至少一条新的 C/D。  
5. 不用 API 造假进度写 PASS。  
6. 报告必须带本次 `BASE_URL` / 部署 HEAD，避免与其它环境混淆。

## 报告模板（必须输出）

```markdown
## 冒烟报告（前端点击）

**环境：** `BASE_URL=…` / SSH=…（无则 none）
**部署：** `<git HEAD>` / 容器或进程时间 / 镜像 tag（可知时）
**范围：** 默认 | 深（含 D4）
**结论：** PASS | FAIL | PASS-with-known-issues

### 清单
| ID | 结果 | 证据 |
|----|------|------|
| A1 | PASS | health json … |
| … | | |

### 全流程
- Phase1: …
- Phase2: …
- worker 假 OOM: 无/有/SKIP

### 非阻断 / 新问题
1. …

### 环境备注
- 项目、账号（勿写密码）、到达 BASE_URL 的方式
```

## 总判据

| 结论 | 条件 |
|------|------|
| **PASS** | 适用的 A 全过；B 主入口过；C 过；D1–D3 过；可上机时 E1 无假 OOM |
| **PASS-with-known-issues** | 同上，仅有 F 类或已跟踪的非阻断 |
| **FAIL** | 适用门禁任一项失败，或超时无进展 |

## 部署后最小复跑（快速）

只验「进程没挂」：A1+A4 + B1 + B3 +（可选）历史 pipeline（B5）→ **deploy-smoke PASS**，并注明 **未跑新全流程**。  
完整发布仍要 C+D。
