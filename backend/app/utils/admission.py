"""
重任务内存准入控制 (admission control, #42)。

思路: 每个重任务按"估算峰值内存"从**动态预算**(宿主 MemAvailable + 在跑重任务实占 − 余量)里**预约**一份额度;
- 预约成功 → 入队执行, 结束时释放;
- 预约不下(预算满) → 提交时回 503「服务器资源紧张, 请稍后重试」(而不是硬塞导致宿主 OOM);
- 估算 > 单 worker 封顶 → 回 400「数据过大, 超单任务内存上限」(再多并发也跑不动, 早拒早好)。

估算权重按 3.6MB / 80MB 两点实测标定的线性模型 weight = (base + slope×上传数据MB) × 安全系数。
真实峰值(GB)实测:
  step       3.6MB   80MB
  qc          1.5     2.8
  normalize   2.1    30.7   ← SCT 大数据内存大户
  reduce      1.5     7.5
  cluster     1.6     8.2
  annotate    3.3     9.4
  markers     2.0    11.6
  enrich      3.7     3.8
  monocle     5.0   >63(OOM)  ← 大数据最凶
  cellchat    1.8     7.3
  wgcna       3.2    10.0
  infercnv   11.0     (标定中, 暂用保守值)
"""
import asyncio
import glob
import json
import logging
import os

logger = logging.getLogger(__name__)

# 串行化"算预算 + 原子预约": 后端单进程单事件循环, 这把锁消除 dynamic_budget 快照与 Lua eval
# 之间的 TOCTOU(多协程同时看到够用各自预约 → 超订)。每次预约只是几次 Redis 往返, 锁持有极短。(bot #64)
_reserve_lock = asyncio.Lock()

RESV_HASH = "scc:mem_resv"          # Redis hash: task_id -> 预约峰值 GB
ALIVE_FMT = "scc:resv_alive:{tid}"  # TTL 存活键; reaper 据此回收泄漏的预约
WMEM_PREFIX = "scc:wmem:"           # worker 上报: scc:wmem:<task_id> = 任务容器实时 memory.current(bytes), 短 TTL 自清


def host_mem_available_gb() -> float:
    """宿主真实可用内存(GB)。backend 容器无 LXCFS, /proc/meminfo 即宿主内存, 反映含别人非-Docker 进程的真实空闲。"""
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) / 1024 / 1024  # KB → GB
    except Exception:
        pass
    return 256.0  # 读不到 → 保守退化值


async def heavy_actual_gb(r) -> float:
    """在跑重任务的实际内存占用之和(GB)。worker 在监督循环里把各自 memory.current 写到 scc:wmem:*。"""
    try:
        keys = await r.keys(WMEM_PREFIX + "*")
        if not keys:
            return 0.0
        vals = await r.mget(keys)
        total = 0.0
        for v in vals:
            if not v:
                continue
            try:
                total += float(v.decode() if isinstance(v, (bytes, bytearray)) else v)
            except (ValueError, AttributeError):
                pass
        return total / 1024 / 1024 / 1024  # bytes → GB
    except Exception:
        return 0.0


async def dynamic_budget_gb(r, settings) -> float:
    """动态总预算 = MemAvailable + 在跑重任务实占 − 安全余量。
    加回"实占"是为了不和 MemAvailable 双重扣减(MemAvailable 已减过这些任务的当前占用, 而预约扣的是它们的峰值)。
    净效果: 约束变成 sum(预约峰值) ≤ 宿主总内存 − 非重任务占用 − 余量, 既实时又防超订。"""
    avail = host_mem_available_gb()
    actual = await heavy_actual_gb(r)
    return max(0.0, avail + actual - float(settings.heavy_mem_reserve_gb))

# (base_gb, slope_gb_per_MB) — 过两实测点的直线
_W = {
    "qc":        (1.44, 0.017),
    "normalize": (0.76, 0.374),
    "reduce":    (1.23, 0.079),
    "cluster":   (1.33, 0.086),
    "annotate":  (3.02, 0.080),
    "markers":   (1.50, 0.126),
    "enrich":    (3.66, 0.002),
    "monocle":   (2.20, 0.900),   # OOM 截尾, slope 取保守
    "cellchat":  (1.52, 0.073),
    "wgcna":     (2.85, 0.089),
    "infercnv":  (7.00, 1.000),   # 标定中, 取陡保守值
    # 其余轻量子步骤
    "markers_pairwise": (1.5, 0.13),
    "subset_cluster":   (1.3, 0.09),
    "merge_celltypes":  (1.3, 0.05),
    "marker_expr":      (1.0, 0.02),
    "convert":          (1.0, 0.05),
}
_DEFAULT = (4.0, 0.4)
_SAFETY = 1.25

# 首选: 以细胞数为规模代理(比压缩文件 MB 稳——压缩比差异大, 真正决定内存的是细胞数)。
# slope = 每千细胞 GB, 由 ~45451 细胞示例集逐步实测峰值 / 45.451 标定;
# inferCNV 由 1888 细胞 11GB 这个点取陡值(它随细胞数涨得最快、最易 OOM)。
_WC_BASE = 0.5  # 固定开销(R+Seurat 加载等)
_WC = {
    "qc":        0.06,
    "normalize": 0.68,
    "reduce":    0.17,
    "cluster":   0.18,
    "annotate":  0.21,
    "markers":   0.26,
    "enrich":    0.08,
    "monocle":   1.40,
    "cellchat":  0.16,
    "wgcna":     0.22,
    "infercnv":  5.80,
    "markers_pairwise": 0.26,
    "subset_cluster":   0.18,
    "merge_celltypes":  0.10,
    "marker_expr":      0.05,
}
_WC_DEFAULT = 0.5


def _input_mb(project_path: str) -> float:
    """用上传的原始数据大小(MB)作为数据规模(细胞数)的代理。退化用项目目录里最大 rds。"""
    try:
        up = glob.glob(os.path.join(project_path, "_uploaded", "*"))
        cands = [f for f in up if os.path.isfile(f)]
        if not cands:
            cands = glob.glob(os.path.join(project_path, "*.rds"))
        if not cands:
            return 50.0
        return max(os.path.getsize(f) for f in cands) / 1e6
    except Exception:
        return 50.0


def _n_cells(project_path: str) -> int | None:
    """从已完成步骤的结果 json 读细胞数(stats.cells / qc 的 total_cells_after; jsonlite 会包成单元素数组)。
    用于单步重跑/已跑过的项目; 全流程首次提交无结果 json, 由调用方传 n_cells。拿不到返回 None。"""
    def _u(v):
        return v[0] if isinstance(v, list) and v else v
    try:
        # 确定性顺序: 优先 qc(total_cells_after 是规范的过滤后细胞数), 其余按名排序, 避免 glob 顺序不定致估算飘
        qc = os.path.join(project_path, "qc_result.json")
        files = ([qc] if os.path.exists(qc) else []) + sorted(
            f for f in glob.glob(os.path.join(project_path, "*_result.json"))
            if os.path.basename(f) != "qc_result.json")
        for f in files:
            try:
                with open(f) as fh:
                    st = (json.load(fh) or {}).get("stats", {}) or {}
                c = _u(st.get("cells")) or _u(st.get("total_cells_after"))
                if c and int(c) > 0:
                    return int(c)
            except Exception:
                continue
    except Exception:
        pass
    return None


def estimate_weight_gb(step: str, project_path: str | None, n_cells: int | None = None) -> float:
    """估算某步骤峰值内存(GB)。优先按细胞数(更准、不受压缩比/_uploaded 残留大文件干扰),
    拿不到细胞数才退回上传文件 MB 的旧公式。"""
    cells = n_cells if (n_cells and n_cells > 0) else (_n_cells(project_path) if project_path else None)
    if cells and cells > 0:
        per1k = _WC.get(step, _WC_DEFAULT)
        return round(max(2.0, (_WC_BASE + per1k * cells / 1000.0) * _SAFETY), 1)
    base, slope = _W.get(step, _DEFAULT)
    mb = _input_mb(project_path) if project_path else 50.0
    return round(max(2.0, (base + slope * mb) * _SAFETY), 1)


# 原子预约: 累加 hash 现有预约, 容得下才 HSET 并返回 1
_RESERVE_LUA = """
local sum = 0
for _, v in ipairs(redis.call('HVALS', KEYS[1])) do sum = sum + tonumber(v) end
local w = tonumber(ARGV[1]); local budget = tonumber(ARGV[2])
if sum + w <= budget then
  redis.call('HSET', KEYS[1], ARGV[3], w)
  return 1
else
  return 0
end
"""


async def try_reserve(r, task_id: str, weight: float, settings, ttl: int) -> bool:
    """原子地从**动态预算**预约 weight(峰值估算)。成功返回 True 并落 TTL 存活键(防泄漏)。"""
    async with _reserve_lock:  # 算预算+eval 整体串行, 防快照 TOCTOU 超订
        budget = await dynamic_budget_gb(r, settings)
        ok = await r.eval(_RESERVE_LUA, 1, RESV_HASH, str(weight), str(budget), str(task_id))
    if ok:
        try:
            await r.set(ALIVE_FMT.format(tid=task_id), "1", ex=ttl)
        except Exception:
            pass
    return bool(ok)


async def release(r, task_id: str) -> None:
    try:
        await r.hdel(RESV_HASH, str(task_id))
        await r.delete(ALIVE_FMT.format(tid=task_id))
    except Exception:
        pass


async def current_reserved_gb(r) -> float:
    try:
        vals = await r.hvals(RESV_HASH)
        return sum(float(v) for v in vals)
    except Exception:
        return 0.0


async def precheck(step: str, project_path: str | None, settings) -> tuple[bool, int, str]:
    """提交时建议性预检(不预约, 仅快速失败给前端弹窗)。返回 (ok, http_code, msg)。"""
    if step in ("plot_markers", "cellchat_pathway"):  # quick 步骤不走预算
        return True, 0, ""
    weight = estimate_weight_gb(step, project_path)
    if weight > settings.worker_mem_cap_gb:
        return False, 400, (f"数据过大：该步骤预计需 ~{weight:.0f}GB, 超过单任务内存上限 "
                            f"{settings.worker_mem_cap_gb}GB。请拆分数据或联系管理员调大上限。")
    try:
        import redis.asyncio as aioredis
        r = aioredis.from_url(settings.redis_url, socket_timeout=None)
        try:
            used = await current_reserved_gb(r)
            budget = await dynamic_budget_gb(r, settings)
        finally:
            try:
                await r.aclose()
            except Exception:
                pass
        if used + weight > budget:
            return False, 503, "服务器资源紧张, 请稍后重试(当前可用内存不足以再起这个任务)。"
    except Exception as e:
        logger.warning(f"[admission] precheck redis 异常, 放行: {e}")
    return True, 0, ""


async def reap_stale(r) -> int:
    """回收存活键已过期(后端崩溃泄漏)的预约。供后台 reaper 定期调用。"""
    n = 0
    try:
        fields = await r.hkeys(RESV_HASH)
        for f in fields:
            tid = f.decode() if isinstance(f, (bytes, bytearray)) else f
            alive = await r.exists(ALIVE_FMT.format(tid=tid))
            if not alive:
                await r.hdel(RESV_HASH, tid)
                n += 1
    except Exception:
        pass
    return n
