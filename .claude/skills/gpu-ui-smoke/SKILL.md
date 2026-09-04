---
name: gpu-ui-smoke
description: Run scCloud GPU UI smoke tests via frontend clicks only (not API task submit). Use whenever deploying to GPU-zhouy1 :8091, after worker/r-engine/frontend changes, before calling a deploy healthy, or when the user asks for 冒烟/smoke/UI 检查/回归 on sccloud GPU.
---

# scCloud GPU UI 冒烟（前端点击）

对 **GPU-zhouy1** 上的 scCloud（默认 `WEB_PORT=8091`，路径 `~/Projects/scRNA/sccloud-v2`）做**可操作的 UI 回归**。  
**禁止**用 API 直接 `submitTask` / 创建 pipeline 来代替点击；API 只用于健康探测、读状态旁证、或下载示例数据。

## 何时使用

- 刚 `git pull` / `start.sh` / recreate 容器之后
- worker 假 OOM、全流程、登录/导航相关修复后
- 用户说「冒烟」「smoke」「前端点一遍」「检查 GPU 部署」

## 约束（硬）

| 做 | 不做 |
|----|------|
| SSH host **`GPU-zhouy1`**（大小写敏感） | 动 xianyu **:8080** |
| 前端点击提交分析 | `docker compose down -v` |
| 旁证可用 `curl` health / pipeline GET | 在 PR 正文写闲鱼相关字样 |
| 保留 DB/Redis/projects 卷 | 未授权 merge Release PR |

## 环境与入口

| 项 | 值 |
|----|-----|
| 仓库目录（GPU） | `~/Projects/scRNA/sccloud-v2` |
| 对外端口 | `:8091` → nginx → frontend/backend |
| Tailscale | `100.123.160.102` |
| 本机隧道 | `ssh -N -L 18091:127.0.0.1:8091 GPU-zhouy1` |
| 预览代理 | `python3 /tmp/sccloud_proxy.py 18092 127.0.0.1 18091` + launch `sccloud-gpu` |
| 默认账号 | `admin` / 见服务器登录说明或部署 `.env`（常见 dev：`admin123`） |
| 推荐项目 | 已有小样本项目（如 `0903`）；无则新建后「从项目文件选择」示例 RDS |

运维：

```bash
ssh GPU-zhouy1 'cd ~/Projects/scRNA/sccloud-v2 && git log -1 --oneline && sh ./scripts/sccloud-ops.sh status'
curl -sS http://127.0.0.1:18091/api/health
# 期望: {"status":"ok",...,"db":"connected","redis":"connected"}
```

Worker 假 OOM 修复依赖 `r-engine/worker.R` 的 `pid_alive`（常 bind-mount）。确认：

```bash
ssh GPU-zhouy1 'docker exec sccloud-r-engine-worker-1 grep -n pid_alive /app/worker.R | head'
```

## 流程总览

```
0 部署旁证 → 1 隧道+预览 → 2 登录
→ 3 导航/按钮 → 4 选项目+加样本（点击）
→ 5 开始全流程 Phase1 → 6 Phase2（至少 markers）
→ 7 worker 日志无假 OOM → 8 出报告
```

深度可选：`enrich` / CellChat / WGCNA / Monocle / inferCNV（默认冒烟**不要求**全开，见范围）。

## Checklist 与判定

每项记：`PASS` / `FAIL` / `SKIP`（并写一句证据：UI 文案、截图、API 旁证、日志行）。

### A. 健康与进程（阻断）

| ID | 检查 | 成功标准 | 失败标准 |
|----|------|----------|----------|
| A1 | `GET /api/health`（经 8091 或隧道） | `status=ok` 且 db/redis connected | 非 200、status≠ok、db/redis 断开 |
| A2 | compose `ps` | backend/web healthy；frontend/worker Up | 关键服务 Exit / unhealthy 持续 >2min |
| A3 | worker 含 `pid_alive` | 容器内 `worker.R` 能 grep 到 | 无该符号且仍用旧判定逻辑 |
| A4 | 登录页 → admin 登录 | 进入 dashboard，无死循环 401 | 无法登录、白屏、持续跳登录 |

**门禁：** A1–A4 任一 FAIL → 整次冒烟 **FAIL**，不必跑全流程。

### B. 导航与按钮（阻断级：主入口）

| ID | 检查 | 成功标准 | 失败标准 |
|----|------|----------|----------|
| B1 | 侧栏：分析流程 / 多样本整合 / 设置 / 用户管理 | 均可进入对应页 | 404、空白、控制台红错阻断 |
| B2 | 项目选择器 | 能选中已有项目；可见新建 | 列表空且无法建（非「真无项目」） |
| B3 | 分析页「全流程」 | 见 PipelineForm（加样本 / 开始全流程） | 只有坏掉的单步残留且无法开 pipeline |
| B4 | 添加样本 → 本地上传 / 从项目文件选择 | 菜单可开；项目文件可选中 RDS | 菜单无响应；选文件后表不更新 |
| B5 | 导出项目 / 历史记录 | 按钮可点；历史能打开已有流水线 | 点击无响应或 500 弹窗（导出未落盘可记非阻断） |
| B6 | 设置：改密表单 + 系统状态 | 表单与状态区渲染 | 整页报错 |
| B7 | 用户管理（admin） | 用户表可见；编辑/删除入口在 | admin 进不去或表加载失败 |

**门禁：** B1/B3/B4 FAIL → **FAIL**。B5–B7 失败记入报告，可标「主路径外」。

### C. 全流程 Phase 1（阻断）

前置：项目内已有可用 RDS（优先「从项目文件选择」已有 `*.rds` / filter 结果，避免大文件 scp）。

| ID | 检查 | 成功标准 | 失败标准 |
|----|------|----------|----------|
| C1 | 样本表有 ≥1 文件/样本 | 表显示细胞数等元数据 | 空表仍点开始却静默失败 |
| C2 | 点击「开始全流程分析」 | 进入 PipelineView；出现运行中/步骤进度 | 无跳转、立即 error toast、未创建 pipeline |
| C3 | Phase1 步骤 | QC/标准化、降维聚类、细胞注释均 **已完成**（或等价 UI） | 任一步 failed；或 worker 报「进程退出但无结果(可能崩溃/OOM)」 |
| C4 | Phase1 结束后状态 | 设计为 **已暂停** 等 Phase2，或产品等价文案 | 整单直接 failed |
| C5 | 关键结果可视 | 过滤表/UMAP 或 canvas、注释表或占比等至少一类可见 | 完成但结果区空白且 API 也无 result |

**门禁：** C2/C3 FAIL → **FAIL**。

### D. 全流程 Phase 2（默认最小集）

| ID | 检查 | 成功标准 | 失败标准 |
|----|------|----------|----------|
| D1 | Phase2 参数页可开 | 能勾选步骤并点开始 | 页空白/按钮死 |
| D2 | 至少跑 **差异基因 (markers)** | 步骤完成；表或下载入口可见 | markers failed / 假 OOM |
| D3 | 流水线终态 | UI +（旁证）pipeline 状态 **completed**（若只跑子集，以所选步骤全成功为准） | failed / 卡 running 超时（见超时） |
| D4 | （可选）enrich / cellchat / … | 选跑则各步 completed + 有结果入口 | 选跑却 failed |

默认冒烟：**D1–D3 必过**；D4 除非用户要求「深冒烟」。

### E. Worker / 日志旁证（阻断级与 C/D 绑定）

| ID | 检查 | 成功标准 | 失败标准 |
|----|------|----------|----------|
| E1 | worker 日志无假 OOM | 无 `run_job 进程退出但无结果(可能崩溃/OOM)` 误报 | 出现该串且任务实失败 |
| E2 | 步骤 HTTP | 相关 step `http_status=200`（或成功完成语义） | 反复 5xx / 结果文件缺失 |
| E3 | 真崩溃区分 | 若真 OOM，dmesg/容器 OOM 有据，报告为真资源问题 | 把真 OOM 当成通过 |

### F. 已知非阻断（记问题，不单独判整次 FAIL）

| ID | 现象 | 处理 |
|----|------|------|
| F1 | 完成后横幅仍像「注释完成、去设 Phase2」而状态已是已完成 | 记 UI 文案 stale |
| F2 | 回参数页/刷新后上传表空，盘上文件仍在 | 记 session 持久化；用「从项目文件选择」继续 |
| F3 | 设置页角色显示 `user` 但能进用户管理 | 记展示不一致 |
| F4 | 图为 canvas/WebGL 非 `<img>` | 用快照/结果表证明，不要求 img 选择器 |
| F5 | 导出未核对浏览器落盘 | 可选补；不挡 PASS |
| F6 | Group 列 | 未在 UI 设 `sample_groups` 则 RDS 无 Group **属预期**；要验分组须故意设 Control/Case |

## 超时建议

| 阶段 | 小样本（~2k cells） | 超时后 |
|------|---------------------|--------|
| Phase1 全段 | 常 10–40 min | 查 worker 日志 + pipeline tasks；仍 running 则 FAIL-timeout |
| markers | 常 5–20 min | 同上 |
| 单次 UI 操作 | 30s | 重试一次点击/刷新 |

## 方法要点

1. **只点 UI** 提交；`GET /api/health`、`GET /api/pipeline/:id` 仅旁证。  
2. 预览用 Browser 工具：`preview_snapshot` / `preview_click`；避免依赖易超时的大 `preview_eval`。  
3. 刷新丢文件列表 → **从项目文件选择**，不要误判存储丢了。  
4. 历史流水线可打开已完成 run，用于验 B5，**不能替代**一次新的 C/D（部署后至少一条新 run）。  
5. 不要用 API 造假进度来写 PASS。

## 报告模板（必须输出）

```markdown
## 冒烟报告（前端点击，GPU :8091）

**部署：** `<git HEAD>` / 容器创建时间 / 镜像 tag
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
- worker 假 OOM: 无/有

### 非阻断 / 新问题
1. …

### 环境备注
- 项目、账号、隧道端口
```

## 总判据

| 结论 | 条件 |
|------|------|
| **PASS** | A 全过；B 主入口过；C 过；D1–D3 过；E1 无假 OOM |
| **PASS-with-known-issues** | 同上，但仅有 F 类或已建 issue 的非阻断 |
| **FAIL** | A/B 主路径/C/D2–D3/E1 任一门禁失败，或超时无进展 |

## 部署后最小复跑（快速）

若只验证「部署没挂」：A1–A4 + B1 + B3 + 打开历史已完成 pipeline（B5）→ 可报 **deploy-smoke PASS**，并注明 **未跑新全流程**。  
完整发布仍要 C+D。
