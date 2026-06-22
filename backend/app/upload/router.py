"""
scCloud v2 — 分片上传路由
支持大文件 (>1GB RDS/H5AD) 的断点续传。

流程:
  1. POST /api/upload/init → 获取 upload_id
  2. POST /api/upload/chunk → 逐片上传 (每片 5MB)
  3. POST /api/upload/complete → 合并所有分片

前端使用 File.slice() 分割文件，并行/顺序上传每一片。
"""

import os
import shutil
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from app.auth.deps import get_current_user
from app.config import get_settings
from app.db.models import User

router = APIRouter(prefix="/api/upload", tags=["文件上传"])

# 临时分片存储目录
CHUNK_DIR = "/tmp/sccloud_chunks"


class InitUploadResponse(BaseModel):
    upload_id: str
    chunk_size: int


class ChunkResponse(BaseModel):
    upload_id: str
    chunk_index: int
    received: int


class CompleteUploadResponse(BaseModel):
    status: str
    path: str
    filename: str
    size_mb: float
    total_chunks: int


@router.post("/init", response_model=InitUploadResponse)
async def init_upload(
    filename: str = Form(...),
    file_size: int = Form(...),
    current_user: User = Depends(get_current_user),
):
    """
    初始化分片上传 — 返回 upload_id 用于后续分片标识。
    默认分片大小 5MB，前端据此切分文件。
    """
    # 配额检查（仅 super/admin）
    if current_user.total_quota and current_user.used_quota >= current_user.total_quota:
        raise HTTPException(
            status_code=403,
            detail="操作配额使用结束，无法继续进行。",
        )

    # 验证文件类型
    allowed_ext = {".rds", ".h5seurat", ".h5ad", ".h5", ".rdata", ".loom"}
    ext = os.path.splitext(filename)[1].lower()
    if ext not in allowed_ext:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的文件类型: {ext}，支持: {', '.join(allowed_ext)}",
        )

    # 检查大小限制 (默认 30GB)
    settings = get_settings()
    max_bytes = settings.max_upload_size_gb * 1024 * 1024 * 1024
    if file_size > max_bytes:
        raise HTTPException(
            status_code=400,
            detail=f"文件过大 ({file_size / 1e9:.1f}GB)，"
                   f"上限 {settings.max_upload_size_gb}GB",
        )

    upload_id = uuid.uuid4().hex
    chunk_dir = os.path.join(CHUNK_DIR, upload_id)
    os.makedirs(chunk_dir, exist_ok=True)

    # 保存元数据
    meta_path = os.path.join(chunk_dir, "_meta.txt")
    with open(meta_path, "w") as f:
        f.write(f"{filename}\n{file_size}\n{current_user.id}\n")

    chunk_size = 5 * 1024 * 1024  # 5MB

    return InitUploadResponse(upload_id=upload_id, chunk_size=chunk_size)


@router.post("/chunk", response_model=ChunkResponse)
async def upload_chunk(
    upload_id: str = Form(...),
    chunk_index: int = Form(...),
    chunk: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """
    上传单个分片。
    前端使用 File.slice(start, end) 切片后逐个上传。
    """
    chunk_dir = os.path.join(CHUNK_DIR, upload_id)
    if not os.path.exists(chunk_dir):
        raise HTTPException(status_code=404, detail="Upload ID 不存在")

    # 保存分片
    chunk_path = os.path.join(chunk_dir, f"chunk_{chunk_index:06d}")
    content = await chunk.read()

    with open(chunk_path, "wb") as f:
        f.write(content)

    return ChunkResponse(
        upload_id=upload_id,
        chunk_index=chunk_index,
        received=len(content),
    )


@router.post("/complete", response_model=CompleteUploadResponse)
async def complete_upload(
    upload_id: str = Form(...),
    project_id: int = Form(None),
    sample_groups: str = Form(None),
    current_user: User = Depends(get_current_user),
):
    """
    合并所有分片为完整文件。
    合并后清理临时分片目录。
    """
    from app.db.models import Project, SessionLocal

    settings = get_settings()

    # 配额检查（仅 super/admin）
    if current_user.total_quota and current_user.used_quota >= current_user.total_quota:
        raise HTTPException(
            status_code=403,
            detail="操作配额使用结束，无法继续进行。",
        )

    chunk_dir = os.path.join(CHUNK_DIR, upload_id)

    if not os.path.exists(chunk_dir):
        raise HTTPException(status_code=404, detail="Upload ID 不存在")

    # 分析后禁止上传（非 admin）
    if current_user.role != "admin":
        from app.db.models import Project
        db_check = SessionLocal()
        try:
            user_projects = db_check.query(Project).filter(
                Project.user_id == current_user.id
            ).order_by(Project.created_at.desc()).all()
            if user_projects and user_projects[0].has_analyzed:
                raise HTTPException(
                    status_code=403,
                    detail="分析已开始，当前账户类型无法继续上传新文件。",
                )
        finally:
            db_check.close()

    # 读取元数据
    meta_path = os.path.join(chunk_dir, "_meta.txt")
    if not os.path.exists(meta_path):
        raise HTTPException(status_code=400, detail="上传元数据丢失")

    with open(meta_path, "r") as f:
        lines = f.readlines()
        original_filename = lines[0].strip()

    # 确定最终存储路径 — 使用项目的 storage_path 保持一致
    if project_id:
        db = SessionLocal()
        try:
            project = (
                db.query(Project)
                .filter(
                    Project.id == project_id,
                    Project.user_id == current_user.id,
                )
                .first()
            )
            if not project:
                raise HTTPException(status_code=404, detail="项目不存在")
            dest_dir = os.path.join(project.storage_path, "_uploaded")
        finally:
            db.close()
    else:
        dest_dir = os.path.join(
            settings.projects_root,
            str(current_user.id),
            "_uploads",
        )
    os.makedirs(dest_dir, exist_ok=True)
    os.chmod(dest_dir, 0o777)

    # 生成唯一文件名
    ext = os.path.splitext(original_filename)[1].lower()

    # 去重：删除同名文件的旧副本，防止重复上传产生多个 UUID 前缀文件
    for existing in os.listdir(dest_dir):
        if existing.endswith(f"_{original_filename}") or existing == original_filename:
            existing_path = os.path.join(dest_dir, existing)
            if os.path.isfile(existing_path):
                os.unlink(existing_path)

    safe_name = f"{uuid.uuid4().hex[:8]}_{original_filename}"
    final_path = os.path.join(dest_dir, safe_name)

    # 保存样本分组信息（如果前端提供了）
    if sample_groups:
        try:
            groups_data = json.loads(sample_groups)
            if isinstance(groups_data, dict) and groups_data:
                groups_path = os.path.join(dest_dir, f"{safe_name}_groups.json")
                with open(groups_path, "w", encoding="utf-8") as gf:
                    json.dump(groups_data, gf, ensure_ascii=False)
        except Exception:
            pass  # 分组信息解析失败不影响主流程

    # 按序合并分片
    chunk_files = sorted(
        [f for f in os.listdir(chunk_dir) if f.startswith("chunk_")]
    )

    if not chunk_files:
        raise HTTPException(status_code=400, detail="没有分片数据")

    total_size = 0
    with open(final_path, "wb") as out:
        for cf in chunk_files:
            chunk_path = os.path.join(chunk_dir, cf)
            with open(chunk_path, "rb") as inp:
                data = inp.read()
                out.write(data)
                total_size += len(data)

    # 清理临时目录
    shutil.rmtree(chunk_dir, ignore_errors=True)

    # 非 RDS 格式自动转换
    NEEDS_CONVERT = {".h5seurat", ".h5", ".rdata", ".loom", ".csv", ".tsv", ".txt"}
    if ext in NEEDS_CONVERT:
        try:
            converted_path = await _auto_convert_to_rds(final_path, ext, original_filename)
            # 转换成功，删除原始文件
            if os.path.exists(final_path) and converted_path != final_path:
                os.unlink(final_path)
            final_path = converted_path
        except Exception as e:
            # 转换失败，清理文件并报错
            if os.path.exists(final_path):
                os.unlink(final_path)
            raise HTTPException(
                status_code=400,
                detail=f"格式转换失败: {str(e)}",
            )

    # 递增上传配额（仅 super/admin）
    db2 = SessionLocal()
    try:
        user = db2.query(User).filter(User.id == current_user.id).first()
        if user:
            user.used_quota = (user.used_quota or 0) + 1
            db2.commit()
    except Exception:
        db2.rollback()
    finally:
        db2.close()

    return CompleteUploadResponse(
        status="completed",
        path=final_path,
        filename=original_filename,
        size_mb=round(total_size / 1024 / 1024, 2),
        total_chunks=len(chunk_files),
    )


class SampleInfo(BaseModel):
    """样本信息"""
    name: str
    cell_count: int


class InspectResponse(BaseModel):
    """文件解析结果"""
    filename: str
    n_cells: int  # 细胞数
    n_genes: int  # 基因数
    n_rows: int  # 兼容旧字段, 现统一 = 细胞数
    n_cols: int  # 兼容旧字段, 现统一 = 基因数
    genes: list[str]  # 基因名列表
    gene_ids: list[str]  # Ensemble ID 列表
    file_size_mb: float
    metadata_columns: list[str] = []  # 元数据列名（Sample, Group, CellType 等）
    samples: list[SampleInfo] = []  # 样本列表（从 Sample 列检测）
    ensembl_version: str = "unknown"  # Ensembl 版本推断


@router.post("/inspect", response_model=InspectResponse)
async def inspect_file(
    upload_id: str = Form(...),
    current_user: User = Depends(get_current_user),
):
    """
    解析已上传的文件，返回维度信息和基因名。
    通过 R 引擎 /inspect 端点解析，支持 .rds, .h5ad, .h5seurat 格式。
    """

    chunk_dir = os.path.join(CHUNK_DIR, upload_id)
    if not os.path.exists(chunk_dir):
        raise HTTPException(status_code=404, detail="Upload ID 不存在")

    # 读取元数据
    meta_path = os.path.join(chunk_dir, "_meta.txt")
    if not os.path.exists(meta_path):
        raise HTTPException(status_code=400, detail="上传元数据丢失")

    with open(meta_path, "r") as f:
        lines = f.readlines()
        original_filename = lines[0].strip()

    # 合并分片到临时文件
    chunk_files = sorted(
        [f for f in os.listdir(chunk_dir) if f.startswith("chunk_")]
    )

    if not chunk_files:
        raise HTTPException(status_code=400, detail="没有分片数据")

    # 创建临时文件（放在共享卷中，R 引擎容器也能访问）
    settings = get_settings()
    tmp_dir = os.path.join(settings.projects_root, "_inspect_tmp")
    os.makedirs(tmp_dir, exist_ok=True)

    ext = os.path.splitext(original_filename)[1].lower()
    tmp_path = os.path.join(tmp_dir, f"{upload_id}{ext}")
    with open(tmp_path, "wb") as tmp_file:
        for cf in chunk_files:
            chunk_path = os.path.join(chunk_dir, cf)
            with open(chunk_path, "rb") as inp:
                tmp_file.write(inp.read())

    try:
        # 通过 R 引擎解析文件
        data = await _call_r_engine_inspect(tmp_path, original_filename)

        # R 引擎返回的标量值可能被包装为列表，需要解包
        def unwrap(val):
            if isinstance(val, list) and len(val) == 1:
                return val[0]
            return val

        # 解包 samples 列表中的嵌套值
        raw_samples = data.get("samples", [])
        samples = [
            SampleInfo(
                name=unwrap(s.get("name", "")),
                cell_count=int(unwrap(s.get("cell_count", 0))),
            )
            for s in raw_samples
        ]

        return InspectResponse(
            filename=unwrap(data["filename"]),
            # 滚动部署兜底: r-engine 未更新(响应无 n_cells/n_genes)时回退到旧字段, 避免 KeyError→500。
            # 过渡期注意: h5ad 旧 n_rows 恰=细胞数(正确), 但 RDS/Loom 旧 n_rows=基因数(仍贴反),
            # 待 r-engine 更新后自动修正。
            n_cells=int(unwrap(data.get("n_cells", data["n_rows"]))),
            n_genes=int(unwrap(data.get("n_genes", data["n_cols"]))),
            n_rows=int(unwrap(data["n_rows"])),
            n_cols=int(unwrap(data["n_cols"])),
            genes=data["genes"][:100],
            gene_ids=data["gene_ids"][:100],
            file_size_mb=round(float(unwrap(data["file_size_mb"])), 2),
            metadata_columns=data.get("metadata_columns", []),
            samples=samples,
            ensembl_version=unwrap(data.get("ensembl_version", "unknown")),
        )

    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


async def _auto_convert_to_rds(input_path: str, ext: str, original_filename: str) -> str:
    """
    上传完成后自动将非 RDS 格式转换为 RDS。
    返回转换后的 RDS 文件路径。失败时抛出异常。
    """
    import httpx
    from app.config import get_settings

    settings = get_settings()

    # 确定输入格式
    ext_to_format = {
        ".h5ad": "h5ad",
        ".h5seurat": "h5seurat",
        ".h5": "h5",
        ".rdata": "rdata",
        ".loom": "loom",
        ".csv": "csv",
        ".tsv": "tsv",
        ".txt": "tsv",
    }
    input_format = ext_to_format.get(ext)
    if not input_format:
        raise ValueError(f"不支持自动转换的格式: {ext}")

    # 输出路径：同目录下替换扩展名为 .rds
    output_path = os.path.splitext(input_path)[0] + ".rds"

    payload = {
        "direction": "import",
        "input_path": input_path,
        "input_format": input_format,
        "output_path": output_path,
    }

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(connect=10.0, read=600.0, write=30.0, pool=10.0)
    ) as client:
        resp = await client.post(
            f"{settings.r_engine_url}/convert",
            json=payload,
        )

    if resp.status_code != 200:
        detail = resp.json().get("error", resp.text) if resp.headers.get("content-type", "").startswith("application/json") else resp.text
        raise RuntimeError(f"R 引擎转换失败: {detail}")

    return output_path


async def _call_r_engine_inspect(file_path: str, filename: str) -> dict:
    """调用 R 引擎 /inspect 端点解析文件"""
    import httpx
    from app.config import get_settings

    settings = get_settings()
    r_engine_url = settings.r_engine_url

    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(
            f"{r_engine_url}/inspect",
            json={"file_path": file_path, "filename": filename},
        )
        if resp.status_code != 200:
            detail = resp.json().get("error", resp.text)
            raise Exception(f"R 引擎解析失败: {detail}")
        return resp.json()


@router.get("/status/{upload_id}")
async def upload_status(
    upload_id: str,
    current_user: User = Depends(get_current_user),
):
    """查询上传进度 — 返回已接收的分片数量。"""
    chunk_dir = os.path.join(CHUNK_DIR, upload_id)
    if not os.path.exists(chunk_dir):
        raise HTTPException(status_code=404, detail="Upload ID 不存在")

    chunk_files = [f for f in os.listdir(chunk_dir) if f.startswith("chunk_")]

    return {
        "upload_id": upload_id,
        "received_chunks": len(chunk_files),
    }


@router.post("/inspect-path", response_model=InspectResponse)
async def inspect_file_by_path(
    file_path: str = Form(...),
    current_user: User = Depends(get_current_user),
):
    """
    按文件路径解析文件（用于已存在于项目目录中的文件）。
    安全检查：路径必须在当前用户的某个项目 storage_path 下。
    """
    from app.db.models import Project, SessionLocal

    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="文件不存在")

    # 安全检查：验证路径属于当前用户的某个项目
    db = SessionLocal()
    try:
        user_projects = (
            db.query(Project)
            .filter(Project.user_id == current_user.id)
            .all()
        )
        allowed = any(
            file_path.startswith(p.storage_path) for p in user_projects if p.storage_path
        )
        if not allowed:
            raise HTTPException(status_code=403, detail="无权访问该文件路径")
    finally:
        db.close()

    filename = os.path.basename(file_path)

    try:
        data = await _call_r_engine_inspect(file_path, filename)

        def unwrap(val):
            if isinstance(val, list) and len(val) == 1:
                return val[0]
            return val

        raw_samples = data.get("samples", [])
        samples = [
            SampleInfo(
                name=unwrap(s.get("name", "")),
                cell_count=int(unwrap(s.get("cell_count", 0))),
            )
            for s in raw_samples
        ]

        return InspectResponse(
            filename=unwrap(data["filename"]),
            # 滚动部署兜底: r-engine 未更新(响应无 n_cells/n_genes)时回退到旧字段, 避免 KeyError→500。
            # 过渡期注意: h5ad 旧 n_rows 恰=细胞数(正确), 但 RDS/Loom 旧 n_rows=基因数(仍贴反),
            # 待 r-engine 更新后自动修正。
            n_cells=int(unwrap(data.get("n_cells", data["n_rows"]))),
            n_genes=int(unwrap(data.get("n_genes", data["n_cols"]))),
            n_rows=int(unwrap(data["n_rows"])),
            n_cols=int(unwrap(data["n_cols"])),
            genes=data["genes"][:100],
            gene_ids=data["gene_ids"][:100],
            file_size_mb=round(float(unwrap(data["file_size_mb"])), 2),
            metadata_columns=data.get("metadata_columns", []),
            samples=samples,
            ensembl_version=unwrap(data.get("ensembl_version", "unknown")),
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"解析文件失败: {str(e)}")
