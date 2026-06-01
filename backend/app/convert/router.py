"""
scCloud v2 — 格式转换路由 (双向: 导入 + 导出)

导入方向: H5AD / H5 / CSV / TSV → Seurat RDS
导出方向: RDS → H5Seurat / H5AD
多样本整合: 多个 10X MTX ZIP → merge → RDS
"""

import os
import uuid
import zipfile
import shutil

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    UploadFile,
)
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user
from app.config import get_settings
from app.db.models import User, get_db

RDS_EXTENSIONS = {".rds", ".h5ad", ".h5seurat", ".h5", ".rdata", ".loom"}

router = APIRouter(prefix="/api/convert", tags=["格式转换"])


# ===== 请求/响应模型 =====

class ConvertRequest(BaseModel):
    """格式转换请求。"""
    direction: str  # "import" | "export"
    input_path: str
    input_format: str | None = None   # 导入时必填 (h5ad/h5/csv/tsv/rds)
    output_format: str | None = None  # 导出时必填 (h5seurat/h5ad/rds)


class ConvertResponse(BaseModel):
    """格式转换响应。"""
    status: str
    input_path: str
    output_path: str
    direction: str
    cells: int | None = None
    genes: int | None = None
    file_size_mb: float | None = None
    download_url: str | None = None


class MtxMergeResponse(BaseModel):
    """多样本整合响应。"""
    status: str
    n_samples: int
    cells: int | None = None
    genes: int | None = None
    file_size_mb: float | None = None
    output_path: str
    download_url: str | None = None


# ===== 上传端点 =====

@router.post("/upload")
async def upload_for_convert(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """
    上传文件用于格式转换。
    支持: .rds / .h5ad / .h5 / .csv / .tsv / .txt / .zip
    返回服务端存储路径。
    """
    settings = get_settings()

    allowed_ext = {".rds", ".h5seurat", ".h5ad", ".h5", ".csv", ".tsv", ".txt", ".zip", ".loom", ".rdata"}
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in allowed_ext:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的文件类型: {ext}，支持: {', '.join(allowed_ext)}",
        )

    # 存储到用户的 _convert 临时目录
    upload_dir = os.path.join(
        settings.projects_root,
        str(current_user.id),
        "_convert",
    )
    os.makedirs(upload_dir, exist_ok=True)
    os.chmod(upload_dir, 0o777)

    filename = f"{uuid.uuid4().hex}{ext}"
    filepath = os.path.join(upload_dir, filename)

    content = await file.read()
    with open(filepath, "wb") as f:
        f.write(content)

    return {
        "status": "uploaded",
        "path": filepath,
        "original_name": file.filename,
        "size_mb": round(len(content) / 1024 / 1024, 2),
    }


# ===== 格式转换端点 (双向) =====

@router.post("", response_model=ConvertResponse)
async def convert_format(
    req: ConvertRequest,
    current_user: User = Depends(get_current_user),
):
    """
    执行格式转换 (双向)。
    - direction="import": 外部格式 → RDS
    - direction="export": RDS → 外部格式
    """
    settings = get_settings()

    # 构造输出路径
    input_dir = os.path.dirname(req.input_path)
    input_name = os.path.splitext(os.path.basename(req.input_path))[0]

    if req.direction == "import":
        output_path = os.path.join(input_dir, f"{input_name}_converted.rds")
        payload = {
            "direction": "import",
            "input_path": req.input_path,
            "input_format": req.input_format,
            "output_path": output_path,
        }
    else:
        fmt = req.output_format or "h5ad"
        ext_map = {"rds": ".rds", "h5seurat": ".h5seurat", "h5ad": ".h5ad"}
        out_ext = ext_map.get(fmt, f".{fmt}")
        output_path = os.path.join(input_dir, f"{input_name}{out_ext}")
        payload = {
            "direction": "export",
            "input_path": req.input_path,
            "output_format": fmt,
            "output_path": output_path,
        }

    # 调用 R 引擎
    import httpx

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(connect=10.0, read=600.0, write=30.0, pool=10.0)
    ) as client:
        response = await client.post(
            f"{settings.r_engine_url}/convert",
            json=payload,
        )

    if response.status_code != 200:
        raise HTTPException(
            status_code=500,
            detail=f"R 引擎转换失败: {response.text}",
        )

    result = response.json()

    return ConvertResponse(
        status=result.get("status", "success"),
        input_path=req.input_path,
        output_path=output_path,
        direction=req.direction,
        cells=result.get("cells"),
        genes=result.get("genes"),
        file_size_mb=result.get("file_size_mb"),
        download_url=f"/api/convert/download?path={output_path}",
    )


# ===== 多样本 MTX 整合端点 =====

@router.post("/mtx-merge", response_model=MtxMergeResponse)
async def mtx_merge(
    sample_names: list[str] = Form(...),
    sample_groups: list[str] = Form(...),
    files: list[UploadFile] = File(...),
    current_user: User = Depends(get_current_user),
):
    """
    多样本整合。支持两种格式：
      - 10X MTX ZIP（包含 matrix.mtx.gz / features.tsv.gz / barcodes.tsv.gz）
      - 单文件格式（.rds / .h5ad / .h5seurat / .h5）
    """
    settings = get_settings()

    if len(files) < 1:
        raise HTTPException(status_code=400, detail="请至少提供 1 个样本文件")
    if len(files) != len(sample_names):
        raise HTTPException(
            status_code=400,
            detail="样本名称和文件数量不一致",
        )

    # 读取所有文件内容
    file_contents = []
    file_extensions = []
    for f in files:
        data = await f.read()
        file_contents.append(data)
        ext = os.path.splitext(f.filename or "")[1].lower()
        file_extensions.append(ext)

    # 判断格式：全部 .zip → 10X MTX 模式，否则 → 单文件合并模式
    all_zip = all(ext == ".zip" for ext in file_extensions)
    is_single_file = all(ext in RDS_EXTENSIONS for ext in file_extensions)

    # 存储目录
    merge_dir = os.path.join(
        settings.projects_root,
        str(current_user.id),
        "_convert",
        f"mtx_merge_{uuid.uuid4().hex[:8]}",
    )
    os.makedirs(merge_dir, exist_ok=True)
    os.chmod(merge_dir, 0o777)

    if all_zip:
        # === 10X MTX ZIP 模式（原有逻辑）===
        sample_dirs = []
        for i, (name, data) in enumerate(zip(sample_names, file_contents)):
            zip_path = os.path.join(merge_dir, f"{name}.zip")
            with open(zip_path, "wb") as fp:
                fp.write(data)

            sample_dir = os.path.join(merge_dir, name)
            os.makedirs(sample_dir, exist_ok=True)
            os.chmod(sample_dir, 0o777)

            with zipfile.ZipFile(zip_path, "r") as zf:
                zf.extractall(sample_dir)

            actual_dir = _find_mtx_dir(sample_dir)
            if actual_dir is None:
                shutil.rmtree(merge_dir, ignore_errors=True)
                raise HTTPException(
                    status_code=400,
                    detail=f"样本 {name} 的 ZIP 中找不到 matrix.mtx 文件",
                )
            sample_dirs.append(actual_dir)

        output_path = os.path.join(merge_dir, "merged.rds")

        import httpx
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(connect=10.0, read=1800.0, write=30.0, pool=10.0)
        ) as client:
            response = await client.post(
                f"{settings.r_engine_url}/convert_mtx_merge",
                json={
                    "sample_dirs": sample_dirs,
                    "sample_names": sample_names,
                    "output_path": output_path,
                },
            )
    else:
        # === 单文件模式（H5AD / RDS / H5Seurat）===
        rds_paths = []
        for i, (name, data, ext) in enumerate(zip(sample_names, file_contents, file_extensions)):
            # 保存原始文件
            orig_path = os.path.join(merge_dir, f"{name}{ext}")
            with open(orig_path, "wb") as fp:
                fp.write(data)

            # 非 RDS 格式需要先转换为 RDS
            if ext != ".rds":
                import httpx
                input_format_map = {
                    ".h5ad": "h5ad", ".h5seurat": "h5seurat",
                    ".h5": "h5", ".rdata": "rdata", ".loom": "loom",
                }
                input_format = input_format_map.get(ext)
                if not input_format:
                    shutil.rmtree(merge_dir, ignore_errors=True)
                    raise HTTPException(status_code=400, detail=f"不支持的格式: {ext}")

                rds_path = os.path.splitext(orig_path)[0] + ".rds"
                async with httpx.AsyncClient(
                    timeout=httpx.Timeout(connect=10.0, read=600.0, write=30.0, pool=10.0)
                ) as client:
                    convert_resp = await client.post(
                        f"{settings.r_engine_url}/convert",
                        json={
                            "direction": "import",
                            "input_path": orig_path,
                            "input_format": input_format,
                            "output_path": rds_path,
                        },
                    )
                if convert_resp.status_code != 200:
                    detail = convert_resp.json().get("error", convert_resp.text) if convert_resp.headers.get("content-type", "").startswith("application/json") else convert_resp.text
                    shutil.rmtree(merge_dir, ignore_errors=True)
                    raise HTTPException(status_code=500, detail=f"转换 {name} 失败: {detail}")
                rds_paths.append(rds_path)
            else:
                rds_paths.append(orig_path)

        output_path = os.path.join(merge_dir, "merged.rds")

        import httpx
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(connect=10.0, read=1800.0, write=30.0, pool=10.0)
        ) as client:
            response = await client.post(
                f"{settings.r_engine_url}/convert_merge_rds",
                json={
                    "rds_paths": rds_paths,
                    "sample_names": sample_names,
                    "output_path": output_path,
                },
            )

    if response.status_code != 200:
        raise HTTPException(
            status_code=500,
            detail=f"R 引擎整合失败: {response.text}",
        )

    result = response.json()

    # 保存样本分组映射（供后续 QC 步骤使用）
    groups_json_path = output_path + "_groups.json"
    import json
    group_map = {}
    for nm, grp in zip(sample_names, sample_groups):
        group_map[nm] = grp if grp and grp.strip() else nm
    with open(groups_json_path, "w") as gf:
        json.dump(group_map, gf, ensure_ascii=False)
    os.chmod(groups_json_path, 0o666)

    # R jsonlite 将单值包装为数组，需要解包
    def _r(v, default=None):
        if isinstance(v, list) and len(v) == 1:
            return v[0]
        return v if v is not None else default

    return MtxMergeResponse(
        status=_r(result.get("status"), "success"),
        n_samples=_r(result.get("n_samples"), len(files)),
        cells=_r(result.get("cells")),
        genes=_r(result.get("genes")),
        file_size_mb=_r(result.get("file_size_mb")),
        output_path=output_path,
        download_url=f"/api/convert/download?path={output_path}",
    )


# ===== 下载端点 =====

@router.get("/download")
async def download_converted(
    path: str,
    current_user: User = Depends(get_current_user),
):
    """下载转换后的文件。"""
    settings = get_settings()

    # 安全检查: 路径必须在用户目录下
    user_root = os.path.join(settings.projects_root, str(current_user.id))
    abs_path = os.path.abspath(path)
    if not abs_path.startswith(os.path.abspath(user_root)):
        raise HTTPException(status_code=403, detail="无权访问此文件")

    if not os.path.isfile(abs_path):
        raise HTTPException(status_code=404, detail="文件不存在")

    return FileResponse(
        abs_path,
        filename=os.path.basename(abs_path),
        media_type="application/octet-stream",
    )


# ===== 辅助函数 =====

def _find_mtx_dir(base_dir: str) -> str | None:
    """
    在解压目录中递归查找包含 matrix.mtx(.gz) 的目录。
    10X CellRanger 输出可能嵌套在子目录中。
    """
    import glob

    # 直接在 base_dir 下查找
    patterns = ["matrix.mtx", "matrix.mtx.gz"]
    for pattern in patterns:
        matches = glob.glob(os.path.join(base_dir, "**", pattern), recursive=True)
        if matches:
            return os.path.dirname(matches[0])

    return None
