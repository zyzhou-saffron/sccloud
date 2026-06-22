"""admission(内存准入)单测：权重估算、动态预算、原子预约/释放。"""
import pytest

from app.utils import admission


# ---- 权重估算 ----

def test_input_mb_reads_uploaded(tmp_path):
    up = tmp_path / "_uploaded"
    up.mkdir()
    (up / "data.rds").write_bytes(b"x" * (2 * 1024 * 1024))  # 2MB
    assert 1.9 < admission._input_mb(str(tmp_path)) < 2.1


def test_input_mb_default_when_missing(tmp_path):
    # NFS 不可达/目录不存在 → 退化默认值(best-effort)
    assert admission._input_mb(str(tmp_path / "nope")) == 50.0


def test_estimate_weight_scales_with_data(monkeypatch):
    monkeypatch.setattr(admission, "_input_mb", lambda p: 3.6)
    w_small = admission.estimate_weight_gb("normalize", "x")
    monkeypatch.setattr(admission, "_input_mb", lambda p: 80.0)
    w_big = admission.estimate_weight_gb("normalize", "x")
    assert w_big > w_small
    assert 25 < w_big < 45  # 实测 ~30G × 1.25 安全系数


def test_estimate_monocle_big_exceeds_cap(monkeypatch):
    # monocle@80MB 实测 OOM(>63G) → 估算应 > 64g 单任务上限 → 提交时会被 400「数据过大」
    monkeypatch.setattr(admission, "_input_mb", lambda p: 80.0)
    assert admission.estimate_weight_gb("monocle", "x") > 64


# ---- 动态预算 ----

async def test_dynamic_budget_formula(monkeypatch):
    # budget = MemAvailable + 在跑实占 − 余量
    monkeypatch.setattr(admission, "host_mem_available_gb", lambda: 465.0)

    async def fake_actual(r):
        return 20.0

    monkeypatch.setattr(admission, "heavy_actual_gb", fake_actual)

    class S:
        heavy_mem_reserve_gb = 60

    bud = await admission.dynamic_budget_gb(None, S())
    assert abs(bud - (465 + 20 - 60)) < 0.5


# ---- 原子预约 / 释放 / 超预算拒绝 ----

class _Settings:
    heavy_mem_reserve_gb = 60
    redis_url = "redis://localhost"


async def test_reserve_release_and_over_budget(fake_redis, monkeypatch):
    # 固定 MemAvailable=100、无在跑实占 → 动态预算 = 100 − 60 = 40G
    monkeypatch.setattr(admission, "host_mem_available_gb", lambda: 100.0)
    s = _Settings()

    try:
        ok1 = await admission.try_reserve(fake_redis, "t1", 30, s, 60)
    except Exception as e:  # fakeredis 无 Lua 支持时优雅跳过
        pytest.skip(f"fakeredis 不支持 Lua eval: {e}")

    assert ok1 is True
    assert abs(await admission.current_reserved_gb(fake_redis) - 30) < 0.01

    # 再要 30G: 30+30=60 > 40 预算 → 拒(原子 Lua 看到已有预约)
    assert await admission.try_reserve(fake_redis, "t2", 30, s, 60) is False

    # 释放 t1 后预算腾出 → t2 能装下
    await admission.release(fake_redis, "t1")
    assert abs(await admission.current_reserved_gb(fake_redis)) < 0.01
    assert await admission.try_reserve(fake_redis, "t2", 30, s, 60) is True


async def test_reap_stale_removes_dead(fake_redis):
    # 预约存在但存活键已过期(模拟后端崩溃泄漏) → reaper 回收
    await fake_redis.hset(admission.RESV_HASH, "dead", "10")     # 无对应 alive 键
    await fake_redis.hset(admission.RESV_HASH, "alive", "5")
    await fake_redis.set(admission.ALIVE_FMT.format(tid="alive"), "1")
    n = await admission.reap_stale(fake_redis)
    assert n == 1
    remaining = await fake_redis.hkeys(admission.RESV_HASH)
    remaining = {k.decode() if isinstance(k, (bytes, bytearray)) else k for k in remaining}
    assert remaining == {"alive"}
