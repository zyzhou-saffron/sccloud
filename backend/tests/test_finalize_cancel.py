"""收尾写库的取消保护(bot #64 Major)：已 cancelled 的任务, 完成/失败路径都不能覆盖回去。"""
import uuid

from app.utils import r_bridge
from app.db.models import Task


def _mk_task(SessionLocal, status):
    db = SessionLocal()
    tid = str(uuid.uuid4())
    db.add(Task(id=tid, project_id=1, user_id=1, step="qc", status=status, progress=0))
    db.commit()
    db.close()
    return tid


def _status(SessionLocal, tid):
    db = SessionLocal()
    t = db.query(Task).filter(Task.id == tid).first()
    s = t.status if t else None
    db.close()
    return s


def test_completed_does_not_overwrite_cancelled(sqlite_session):
    """核心回归: 用户点停止已置 cancelled, worker 恰好正常算完回 success →
    完成收尾 skip_if_cancelled=True 必须保持 cancelled, 不能翻成 completed。"""
    tid = _mk_task(sqlite_session, "cancelled")
    r_bridge._finalize_task(tid, status="completed", progress=100,
                            message="✅ 分析完成", skip_if_cancelled=True)
    assert _status(sqlite_session, tid) == "cancelled"


def test_completed_finalizes_running_task(sqlite_session):
    """正常运行中的任务, 完成收尾置 completed。"""
    tid = _mk_task(sqlite_session, "running")
    r_bridge._finalize_task(tid, status="completed", progress=100, skip_if_cancelled=True)
    assert _status(sqlite_session, tid) == "completed"


def test_failed_does_not_overwrite_cancelled(sqlite_session):
    """失败路径同样不覆盖已 cancelled(取消信号让 worker kill 后, 上层 except 不应改写)。"""
    tid = _mk_task(sqlite_session, "cancelled")
    r_bridge._finalize_task(tid, status="failed", error_msg="boom", skip_if_cancelled=True)
    assert _status(sqlite_session, tid) == "cancelled"


def test_failed_finalizes_running_task(sqlite_session):
    tid = _mk_task(sqlite_session, "running")
    r_bridge._finalize_task(tid, status="failed", error_msg="boom", skip_if_cancelled=True)
    assert _status(sqlite_session, tid) == "failed"
