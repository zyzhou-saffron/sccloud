/**
 * Pipeline 全流程参数表单
 * 6 个可折叠参数面板，风格与单步分析完全一致
 */
"use client";

import React, { useEffect, useRef, useState } from "react";
import { createPipeline, listPipelines, type Pipeline } from "../../../lib/pipeline-api";
import { IconQuestion } from "../../../components/Icons";
import Tooltip from "../../../components/Tooltip";
import AddSampleDropdown from "../../../components/AddSampleDropdown";
import UploadedFilesTable, { type SampleRow } from "../../../components/UploadedFilesTable";

interface UploadedFile {
  name: string;
  path: string;
  metadata_columns?: string[];
  n_rows?: number;
  n_cols?: number;
  file_size_mb?: number;
  samples?: { name: string; cell_count: number }[];
  ensembl_version?: string;
}

interface PipelineFormProps {
  projectId: number;
  token: string;
  onSubmit: (pipelineId: string) => void;
  uploadedFiles: UploadedFile[];
  onUploadedFilesChange: (files: UploadedFile[]) => void;
  sampleGroups: Record<string, string>;
  onSampleGroupsChange: (groups: Record<string, string>) => void;
}

const DEFAULT_PARAMS: Record<string, Record<string, unknown>> = {
  qc: { max_mt_ratio: 20, min_features: 200, max_features: 5000, umi_min_pct: 0, umi_max_pct: 1, plot_format: "png" },
  normalize: { plot_format: "png" },
  reduce: { method: "umap", n_pcs: 30, group_by: "Sample", plot_format: "png" },
  cluster: { method: "harmony", resolution: 0.5, n_dims: 30, group_by: "Sample", plot_format: "png" },
  markers: { cluster: "All", min_pct: 0.1, logfc_threshold: 0.25, p_val_adj: 0.05, test_use: "wilcox", only_pos: true, ntop: 5, plot_format: "png" },
  annotate: { anno_type: "自动注释", group_by: "Sample", species: "Human", tissue: "Blood", plot_format: "png" },
  cellchat: { species: "Human", db_use: "Secreted", thresh: 0.05, min_cells: 10, prob_method: "triMean", top_pathways: 1, remove_isolate: false, plot_format: "png" },
  wgcna: { interest_type: "", min_fraction: 0.05, sft_threshold: 0.8, module_score: "Seurat", k: 25, max_shared: 10, min_cells: 100, n_hubs: 10, n_genes_score: 25, plot_format: "png" },
};

const STEP_LABELS: Record<string, string> = {
  qc: "数据预处理与标准化", normalize: "数据预处理与标准化", reduce: "降维与聚类",
  cluster: "降维与聚类", markers: "差异基因", annotate: "细胞注释",
  enrich: "通路富集", monocle: "拟时序分析", cellchat: "细胞通讯",
  infercnv: "拷贝数变异", wgcna: "WGCNA",
};

/** 合并后的步骤序号映射 */
const STEP_INDEX: Record<string, number> = {
  qc: 1, normalize: 1, reduce: 2, cluster: 2, annotate: 3,
  markers: 4, enrich: 5, monocle: 6, cellchat: 7, infercnv: 8, wgcna: 9,
};

/** 计算 Pipeline 总步骤数（Phase1 合并后 3 步 + Phase2 步数） */
// Phase1 固定 4 个执行步骤: qc, normalize, reduce, annotate
const PHASE1_COUNT = 4;
const PHASE1_ORDER: Record<string, number> = {
  qc: 1, normalize: 2, reduce: 3, annotate: 4,
};
const PHASE2_STEPS = ["markers", "enrich", "monocle", "cellchat", "infercnv", "wgcna"];

function getTotalSteps(params?: Record<string, unknown>): number {
  const enabled = (params?.enabled_steps as string[] | undefined) || [];
  return enabled.length > 0 ? PHASE1_COUNT + enabled.length : PHASE1_COUNT;
}

function getStepIndex(step: string, params?: Record<string, unknown>): number {
  if (PHASE1_ORDER[step] !== undefined) return PHASE1_ORDER[step];
  const enabled = (params?.enabled_steps as string[] | undefined) || [];
  if (enabled.length === 0) return PHASE2_STEPS.indexOf(step) + PHASE1_COUNT + 1;
  const pos = enabled.indexOf(step);
  return pos >= 0 ? PHASE1_COUNT + pos + 1 : 0;
}

const STATUS_MAP: Record<string, { dot: string; text: string }> = {
  pending:   { dot: "bg-[#999]", text: "text-[#999]" },
  running:   { dot: "bg-[#C86019] animate-pulse", text: "text-[#C86019]" },
  completed: { dot: "bg-[#2D8A56]", text: "text-[#2D8A56]" },
  failed:    { dot: "bg-[#B85450]", text: "text-[#B85450]" },
  cancelled: { dot: "bg-[#E0DCD6]", text: "text-[#999]" },
};

export default function PipelineForm({ projectId, token, onSubmit, uploadedFiles, onUploadedFilesChange, sampleGroups, onSampleGroupsChange }: PipelineFormProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useState<Record<string, Record<string, unknown>>>(
    JSON.parse(JSON.stringify(DEFAULT_PARAMS))
  );
  const historyRef = useRef<HTMLDivElement>(null);
  const [showAddSample, setShowAddSample] = useState(false);
  const [annoFile, setAnnoFile] = useState<{ name: string; data: { Cluster: string; CellType: string; Markers: string }[] } | null>(null);

  // 从所有上传文件的元数据列中聚合分组列
  const metadataColumns = [...new Set(uploadedFiles.flatMap(f => f.metadata_columns ?? []))];
  const GROUP_EXCLUDE = new Set(["nCount_RNA", "nFeature_RNA", "percent.mt", "n_genes", "n_counts", "barcode"]);
  const groupColumns = metadataColumns.filter(c => !GROUP_EXCLUDE.has(c) && !c.startsWith("n_") && !c.startsWith("percent."));
  // 如果用户设定了分组，确保 "Group" 作为可选项
  const hasSampleGroups = Object.values(sampleGroups).some(Boolean);
  const allGroupOptions = hasSampleGroups && !groupColumns.includes("Group")
    ? [...groupColumns, "Group"]
    : groupColumns;
  const effectiveGroupCols = allGroupOptions.length > 0 ? allGroupOptions : ["Sample", "Group"];

  // 将 uploadedFiles 展平为样本行
  const sampleRows: SampleRow[] = uploadedFiles.flatMap(f => {
    if (f.samples && f.samples.length > 0) {
      return f.samples.map(s => ({
        fileName: f.name,
        filePath: f.path,
        sampleName: s.name,
        cellCount: s.cell_count,
        geneCount: f.n_cols ?? 0,
        fileSizeMb: f.file_size_mb ?? 0,
        ensemblVersion: f.ensembl_version ?? "unknown",
      }));
    }
    // 没有样本信息时，整个文件作为一行
    return [{
      fileName: f.name,
      filePath: f.path,
      sampleName: f.name.replace(/\.(rds|h5ad|h5seurat)$/i, ""),
      cellCount: f.n_rows ?? 0,
      geneCount: f.n_cols ?? 0,
      fileSizeMb: f.file_size_mb ?? 0,
      ensemblVersion: f.ensembl_version ?? "unknown",
    }];
  });

  // 当 metadataColumns 变化时，更新默认分组
  useEffect(() => {
    if (effectiveGroupCols.length > 0 && !effectiveGroupCols.includes(params.reduce.group_by as string)) {
      const defaultGroup = effectiveGroupCols[0];
      setParams(prev => ({
        ...prev,
        reduce: { ...prev.reduce, group_by: defaultGroup },
        cluster: { ...prev.cluster, group_by: defaultGroup },
        annotate: { ...prev.annotate, group_by: defaultGroup },
      }));
    }
  }, [metadataColumns, hasSampleGroups]);

  /* ===== Pipeline 历史记录 ===== */
  const [showHistory, setShowHistory] = useState(false);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);

  useEffect(() => {
    if (!showHistory || !projectId) return;
    const fetchPipelines = async () => {
      try {
        const data = await listPipelines(token, projectId, 10);
        setPipelines(data);
      } catch { /* 静默失败 */ }
    };
    fetchPipelines();
    const interval = setInterval(fetchPipelines, 5000);
    return () => clearInterval(interval);
  }, [showHistory, projectId, token]);

  // 点击外部关闭历史面板
  useEffect(() => {
    if (!showHistory) return;
    const handleClick = (e: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setShowHistory(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showHistory]);

  /* ===== 输入样式（与单步分析 page.tsx 保持一致） ===== */
  const inputCls = "w-full px-3 py-2 bg-white border rounded text-sm focus:outline-none focus:ring-2 focus:ring-[#C86019]/30 transition-colors";
  const inputStyle: React.CSSProperties = { borderColor: "var(--clr-border)", color: "var(--clr-text)" };
  const selectCls = inputCls.replace("w-full", "w-auto min-w-[100px]") + " cursor-pointer";
  const numberCls = inputCls.replace("w-full", "w-[100px]");
  const selectStyle: React.CSSProperties = {
    ...inputStyle,
    appearance: "none",
    WebkitAppearance: "none",
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E")`,
    backgroundRepeat: "no-repeat",
    backgroundPosition: "right 10px center",
    paddingRight: "32px",
  };

  const updateStepParam = (stepId: string, key: string, value: unknown) => {
    setParams(prev => ({ ...prev, [stepId]: { ...prev[stepId], [key]: value } }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (uploadedFiles.length === 0) {
      setError("请先上传数据文件");
      return;
    }

    setLoading(true);
    setError(null);
    setShowHistory(false);

    try {
      // 将上传文件路径注入 QC 参数
      const pipelineParams = { ...params };
      if (uploadedFiles.length === 1 && uploadedFiles[0].path) {
        pipelineParams.qc = { ...pipelineParams.qc, rds_file_path: uploadedFiles[0].path };
      } else if (uploadedFiles.length > 1) {
        pipelineParams.qc = { ...pipelineParams.qc, rds_file_paths: uploadedFiles.map(f => f.path) };
      }

      const data: any = {
        project_id: projectId,
        params: pipelineParams,
        sample_groups: sampleGroups,
      };
      if (annoFile && params.annotate.anno_type === "手动注释") {
        data.params.annotate.markers_table = annoFile.data;
      }

      const response = await createPipeline(token, data);
      if (!response || !response.pipeline_id) {
        throw new Error("Server returned invalid response");
      }
      onSubmit(response.pipeline_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create pipeline");
      setLoading(false);
    }
  };

  return (
    <div className="animate-fade-in">
      {/* 标题 + 历史记录下拉 */}
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold" style={{ fontFamily: "var(--font-serif)", color: "var(--clr-dark-deep)" }}>
            全流程一键分析
          </h2>
          <p className="text-xs mt-1" style={{ color: "var(--clr-text-muted)" }}>
            配置参数后依次执行全部 6 步，无需手动干预。
          </p>
        </div>
        <div className="relative shrink-0" ref={historyRef}>
          <button
            onClick={() => setShowHistory(v => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors"
            style={{
              border: "1px solid var(--clr-border)",
              color: showHistory ? "#fff" : "var(--clr-text-muted)",
              background: showHistory ? "var(--clr-amber)" : "var(--clr-bg-alt)",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            历史记录{pipelines.length > 0 && ` (${pipelines.length})`}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ transform: showHistory ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}><polyline points="6 9 12 15 18 9" /></svg>
          </button>

          {/* 浮动下拉面板 */}
          <div
            className="absolute top-full right-0 mt-2 w-80 z-50 rounded-lg overflow-hidden"
            style={{
              background: "var(--clr-bg-card)",
              border: showHistory ? "1px solid var(--clr-border)" : "1px solid transparent",
              boxShadow: showHistory ? "var(--shadow-lg, 0 10px 25px rgba(0,0,0,0.12))" : "none",
              maxHeight: showHistory ? 400 : 0,
              opacity: showHistory ? 1 : 0,
              transform: showHistory ? "translateY(0)" : "translateY(-8px)",
              transition: "max-height 0.3s cubic-bezier(0.4,0,0.2,1), opacity 0.2s ease, transform 0.25s cubic-bezier(0.4,0,0.2,1), border-color 0.2s ease, box-shadow 0.2s ease",
              pointerEvents: showHistory ? "auto" : "none",
            }}
          >
            {/* 标题栏 */}
            <div className="flex items-center justify-between px-3 py-2.5" style={{ borderBottom: "1px solid var(--clr-border)", background: "var(--clr-bg-alt)" }}>
              <span className="text-xs font-semibold" style={{ fontFamily: "var(--font-serif)", color: "var(--clr-dark)" }}>历史流程</span>
              <span className="text-[10px]" style={{ color: "var(--clr-text-faint)" }}>{pipelines.length}/10</span>
            </div>

            {/* 列表 */}
            <div className="max-h-72 overflow-y-auto">
              {pipelines.length === 0 ? (
                <div className="px-3 py-8 text-center">
                  <svg className="mx-auto mb-2 opacity-30" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                  <p className="text-xs" style={{ color: "var(--clr-text-muted)" }}>暂无历史记录</p>
                </div>
              ) : (
                pipelines.map((p) => {
                  const style = STATUS_MAP[p.status] || STATUS_MAP.pending;
                  const stepLabel = p.current_step ? STEP_LABELS[p.current_step] : "";
                  return (
                    <button
                      key={p.id}
                      onClick={() => { setShowHistory(false); onSubmit(p.id); }}
                      className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-white/60"
                      style={{ borderBottom: "1px solid var(--clr-border)" }}
                    >
                      <div className={`w-2 h-2 rounded-full shrink-0 ${style.dot}`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium truncate" style={{ color: "var(--clr-text)" }}>
                          {p.status === "completed" ? "全流程完成" : p.status === "running" ? `运行中 — ${stepLabel}` : p.status === "failed" ? `失败 — ${p.error_step ? STEP_LABELS[p.error_step] || p.error_step : ""}` : "等待中"}
                        </div>
                        <div className="text-[10px] mt-0.5" style={{ color: "var(--clr-text-faint)", fontFamily: "var(--font-mono)" }}>
                          {new Date((p.created_at || "") + (!(p.created_at || "").endsWith("Z") ? "Z" : "")).toLocaleString("zh-CN")}
                        </div>
                      </div>
                      <span className={`text-[10px] font-mono shrink-0 ${style.text}`}>
                        {p.status === "completed" ? "✓" : p.status === "failed" ? "✗" : p.status === "running" ? `${p.current_step ? getStepIndex(p.current_step, p.params) : 0}/${getTotalSteps(p.params)}` : "—"}
                      </span>
                    </button>
                  );
                })
              )}
            </div>

            {pipelines.length > 0 && (
              <div className="px-3 py-1.5 text-[10px] text-center" style={{ borderTop: "1px solid var(--clr-border)", background: "var(--clr-bg-alt)", color: "var(--clr-text-faint)" }}>
                共 {pipelines.length} 条记录
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div
          className="mb-4 px-3 py-2 rounded text-xs border"
          style={{
            borderColor: "var(--clr-danger)",
            background: "rgba(220, 53, 69, 0.05)",
            color: "var(--clr-danger)",
          }}
        >
          {error}
        </div>
      )}

      {/* 样本表格（无文件时显示居中按钮，有文件时表格最后一行显示添加） */}
      <div className="relative">
        <UploadedFilesTable
          samples={sampleRows}
          sampleGroups={sampleGroups}
          onGroupChange={(sampleName, group) => onSampleGroupsChange({ ...sampleGroups, [sampleName]: group })}
          onDelete={(sampleName, filePath) => {
            const newGroups = { ...sampleGroups };
            delete newGroups[sampleName];
            onSampleGroupsChange(newGroups);
            onUploadedFilesChange(uploadedFiles.filter(f => f.path !== filePath));
          }}
          onAddSample={() => setShowAddSample(true)}
        />

        {/* 添加样本下拉菜单 */}
        <AddSampleDropdown
          isOpen={showAddSample}
          onClose={() => setShowAddSample(false)}
          sampleGroups={sampleGroups}
          onFileUploaded={(file) => {
            const exists = uploadedFiles.some(f => f.path === file.path);
            if (!exists) {
              onUploadedFilesChange([...uploadedFiles, file]);
            }
          }}
          onFilesSelected={(files) => {
            const newFiles = files.filter(f => !uploadedFiles.some(ef => ef.path === f.path));
            onUploadedFilesChange([...uploadedFiles, ...newFiles]);
          }}
          projectId={projectId}
          token={token}
          existingPaths={uploadedFiles.map(f => f.path)}
        />
      </div>

      {/* 示例数据下载 */}
      <div className="flex items-center gap-2 mt-2 px-1">
        <a href="/api/tasks/example-sample-rds" download="Samples.filter.rds"
          className="text-[11px] underline" style={{ color: "var(--clr-amber-dark)" }}>
          下载示例数据文件 (Samples.filter.rds)
        </a>
        <span className="text-[10px]" style={{ color: "var(--clr-text-faint)" }}>约 3.4 MB，可用于测试全流程分析</span>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        {/* Steps 1-4: 基础分析参数 */}
        <div className="card p-4" style={{ borderColor: "var(--clr-border)" }}>
          <div className="text-xs font-semibold mb-3" style={{ color: "var(--clr-amber-dark)" }}>
            基础分析参数
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-4">
            {/* Step 1-2 QC + Normalize */}
            <div className="text-xs font-semibold pt-1 whitespace-nowrap" style={{ color: "var(--clr-text-muted)" }}>
              Step 1: 数据预处理与标准化
            </div>
            <div className="space-y-2">
              <div>
                <label className="flex items-center gap-1 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                  <span>最大线粒体基因比例 (%)</span>
                  <Tooltip content="变量: max_mt_ratio\n\n设定细胞内线粒体基因表达占比的最大阈值。\n线粒体占比居高(如>10~20%)通常标志着由于膜破裂导致的胞质转录本大规模流失，细胞处于濒死受损状态。">
                    <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                  </Tooltip>
                </label>
                <input type="range" min="0" max="100" value={params.qc.max_mt_ratio as number} onChange={(e) => updateStepParam("qc", "max_mt_ratio", Number(e.target.value))} className="w-full accent-[#C86019]" />
                <div className="text-[10px] text-right" style={{ color: "var(--clr-text-faint)", fontFamily: "var(--font-mono)" }}>{params.qc.max_mt_ratio as number}%</div>
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-3">
                <div>
                  <label className="flex items-center gap-1 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                    <span>最小基因数</span>
                    <Tooltip content="变量: min_features\n\n细胞必须检测到的最小独特基因数量。基因数过少通常意味着测序深度不足或细胞破裂。">
                      <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                    </Tooltip>
                  </label>
                  <input type="number" value={params.qc.min_features as number} onChange={(e) => updateStepParam("qc", "min_features", Number(e.target.value))} min={1} className={numberCls} style={inputStyle} />
                </div>
                <div>
                  <label className="flex items-center gap-1 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                    <span>最大基因数</span>
                    <Tooltip content="变量: max_features\n\n细胞内检测到的最大独特基因数量。基因数过高往往是因为液滴内包裹了多个细胞。">
                      <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                    </Tooltip>
                  </label>
                  <input type="number" value={params.qc.max_features as number} onChange={(e) => updateStepParam("qc", "max_features", Number(e.target.value))} min={1} className={numberCls} style={inputStyle} />
                </div>
                <div>
                  <label className="flex items-center gap-1 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                    <span>nUMI 底部分位</span>
                    <Tooltip content="变量: umi_min_pct\n\n基于全群细胞UMI总数分布计算下限截取分位。0 意味着不裁选。">
                      <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                    </Tooltip>
                  </label>
                  <input type="number" value={params.qc.umi_min_pct as number} onChange={(e) => updateStepParam("qc", "umi_min_pct", Number(e.target.value))} min={0} max={1} step={0.01} className={numberCls} style={inputStyle} />
                </div>
                <div>
                  <label className="flex items-center gap-1 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                    <span>nUMI 顶部分位</span>
                    <Tooltip content="变量: umi_max_pct\n\n基于全群细胞UMI总数分布计算上限截取分位。1 意味着不裁选。">
                      <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                    </Tooltip>
                  </label>
                  <input type="number" value={params.qc.umi_max_pct as number} onChange={(e) => updateStepParam("qc", "umi_max_pct", Number(e.target.value))} min={0} max={1} step={0.01} className={numberCls} style={inputStyle} />
                </div>
              </div>
              <p className="text-[10px] mt-1" style={{ color: "var(--clr-text-faint)" }}>
                标准化: SCTransform + glmGamPoi
              </p>
            </div>

            {/* 分隔线 */}
            <div className="col-span-2" style={{ borderTop: "1px solid var(--clr-border)" }} />

            {/* Step 2: 降维与聚类 */}
            <div className="text-xs font-semibold pt-1 whitespace-nowrap" style={{ color: "var(--clr-text-muted)" }}>
              Step 2: 降维与聚类
            </div>
            <div className="space-y-3">
              <div className="flex flex-wrap gap-x-6 gap-y-3">
                <div>
                  <label className="flex items-center gap-1 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                    <span>降维方法</span>
                    <Tooltip content="变量: method\n\nUMAP / t-SNE 注重局部近邻结构的非线性拓扑保留，适合可视化；PCA 则是寻找全局方差最大的线性组合。">
                      <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                    </Tooltip>
                  </label>
                  <select value={params.reduce.method as string} onChange={(e) => updateStepParam("reduce", "method", e.target.value)} className={selectCls} style={selectStyle}>
                    <option value="umap">UMAP</option><option value="tsne">t-SNE</option><option value="pca">PCA</option>
                  </select>
                </div>
                <div>
                  <label className="flex items-center gap-1 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                    <span>PCA 维度</span>
                    <Tooltip content="变量: n_pcs\n\n参与下游降维和聚类的主成分数量。">
                      <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                    </Tooltip>
                  </label>
                  <input type="number" value={params.reduce.n_pcs as number} onChange={(e) => updateStepParam("reduce", "n_pcs", Number(e.target.value))} min={2} className={numberCls} style={inputStyle} />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>分组方式</label>
                  <div className="flex flex-wrap gap-1.5">
                    {effectiveGroupCols.map((v) => {
                      const selected = params.reduce.group_by === v;
                      return (
                        <button
                          key={v}
                          type="button"
                          onClick={() => updateStepParam("reduce", "group_by", v)}
                          className="px-3 py-1 rounded-full text-xs font-medium transition-all duration-150 border"
                          style={{
                            background: selected ? "var(--clr-amber)" : "transparent",
                            color: selected ? "#fff" : "var(--clr-text-muted)",
                            borderColor: selected ? "var(--clr-amber)" : "var(--clr-border)",
                            cursor: "pointer",
                          }}
                        >
                          {v}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-3">
                <div>
                  <label className="flex items-center gap-1 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                    <span>校正方法</span>
                    <Tooltip content="变量: method\n\nHarmony 是目前最流行的单细胞批次校正算法。">
                      <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                    </Tooltip>
                  </label>
                  <select value={params.cluster.method as string} onChange={(e) => updateStepParam("cluster", "method", e.target.value)} className={selectCls} style={selectStyle}>
                    <option value="harmony">Harmony</option>
                  </select>
                </div>
                <div>
                  <label className="flex items-center gap-1 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                    <span>降维维度</span>
                    <Tooltip content="变量: n_dims\n\nPCA/Harmony 使用的维度数，通常 20~30 维。">
                      <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                    </Tooltip>
                  </label>
                  <input type="number" value={params.cluster.n_dims as number} onChange={(e) => updateStepParam("cluster", "n_dims", Number(e.target.value))} min={2} max={50} className={numberCls} style={inputStyle} />
                </div>
                <div>
                  <label className="flex items-center gap-1 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                    <span>校正分组</span>
                    <Tooltip content="变量: group_by\n\n指定按哪个元数据字段进行批次校正。">
                      <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                    </Tooltip>
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {effectiveGroupCols.map((v) => {
                      const selected = (params.cluster.group_by ?? "Sample") === v;
                      return (
                        <button
                          key={v}
                          type="button"
                          onClick={() => updateStepParam("cluster", "group_by", v)}
                          className="px-3 py-1 rounded-full text-xs font-medium transition-all duration-150 border"
                          style={{
                            background: selected ? "var(--clr-amber)" : "transparent",
                            color: selected ? "#fff" : "var(--clr-text-muted)",
                            borderColor: selected ? "var(--clr-amber)" : "var(--clr-border)",
                            cursor: "pointer",
                          }}
                        >
                          {v}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <label className="flex items-center gap-1 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                    <span>聚类分辨率</span>
                    <Tooltip content="变量: resolution\n\n决定聚类敏感度。数值越大亚群越细密（0.8+）；越小越粗放（0.2）。">
                      <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                    </Tooltip>
                  </label>
                  <input type="range" min="0" max="2" step="0.01" value={params.cluster.resolution as number} onChange={(e) => updateStepParam("cluster", "resolution", Number(e.target.value))} className="w-full accent-[#C86019]" />
                  <div className="flex justify-between text-[10px]" style={{ color: "var(--clr-text-faint)", fontFamily: "var(--font-mono)" }}>
                    <span>0</span><span style={{ color: "var(--clr-amber)", fontWeight: 600 }}>{params.cluster.resolution as number}</span><span>2</span>
                  </div>
                </div>
              </div>
            </div>

            {/* 分隔线 */}
            <div className="col-span-2" style={{ borderTop: "1px solid var(--clr-border)" }} />

            {/* Step 3 Annotate */}
            <div className="text-xs font-semibold pt-1 whitespace-nowrap" style={{ color: "var(--clr-text-muted)" }}>
              Step 3: 细胞注释
            </div>
            <div className="space-y-3">
              {/* 物种 + 组织选择 */}
              <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
                <div>
                  <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>物种</label>
                  <div className="flex items-center gap-2">
                    <select
                      value={params.annotate.species as string}
                      onChange={(e) => updateStepParam("annotate", "species", e.target.value)}
                      className={selectCls} style={selectStyle}
                    >
                      <option value="Human">Human (人)</option>
                      <option value="Mouse">Mouse (小鼠)</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => {
                        const versions = uploadedFiles.map(f => f.ensembl_version);
                        const detected = versions.some(v => v?.includes("Mouse")) ? "Mouse" : "Human";
                        updateStepParam("annotate", "species", detected);
                      }}
                      className="px-2.5 py-2 text-xs rounded border transition-colors hover:bg-[rgba(200,96,25,0.06)]"
                      style={{ borderColor: "var(--clr-border)", color: "var(--clr-amber-dark)" }}
                    >
                      自动检测
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>组织 / 器官</label>
                  <select
                    value={params.annotate.tissue as string}
                    onChange={(e) => updateStepParam("annotate", "tissue", e.target.value)}
                    className={selectCls} style={selectStyle}
                  >
                    <option value="Blood">血液 (Blood)</option>
                    <option value="Brain">脑 (Brain)</option>
                    <option value="Lung">肺 (Lung)</option>
                    <option value="Liver">肝 (Liver)</option>
                    <option value="Kidney">肾 (Kidney)</option>
                    <option value="Heart">心脏 (Heart)</option>
                    <option value="Pancreas">胰腺 (Pancreas)</option>
                    <option value="Skin">皮肤 (Skin)</option>
                  </select>
                </div>
              </div>
              {/* 注释方式 + 分组 */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>注释方式</label>
                  <div className="flex gap-3">
                    {["自动注释", "手动注释"].map((v) => (
                      <label key={v} className="flex items-center gap-1 text-xs cursor-pointer" style={{ color: "var(--clr-text)" }}>
                        <input type="radio" name="pipeline_anno_type" value={v} checked={params.annotate.anno_type === v} onChange={() => { updateStepParam("annotate", "anno_type", v); if (v === "自动注释") setAnnoFile(null); }} className="accent-[#C86019]" /> {v}
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>分组方式</label>
                  <select value={params.annotate.group_by as string} onChange={(e) => updateStepParam("annotate", "group_by", e.target.value)} className={selectCls} style={selectStyle}>
                    {effectiveGroupCols.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                    <option value="CellType">CellType</option>
                  </select>
                </div>
              </div>
            </div>

            {/* 分隔线 */}
            <div className="col-span-2" style={{ borderTop: "1px solid var(--clr-border)" }} />

          </div>
        </div>




        {/* 手动注释：文件上传 + 示例下载 */}
        {params.annotate.anno_type === "手动注释" && (
          <div className="px-3 py-2.5 rounded-lg" style={{ background: "rgba(200,96,25,0.04)", border: "2px dashed rgba(200,96,25,0.3)" }}>
            <div className="flex items-center justify-between gap-3 mb-1.5">
              <div>
                <p className="text-xs font-semibold" style={{ color: "var(--clr-amber-dark)" }}>上传注释文件</p>
                <p className="text-[11px] mt-0.5" style={{ color: "var(--clr-text-muted)" }}>
                  CSV/TSV，列名: Cluster, CellType, Markers
                </p>
              </div>
              <label className="px-4 py-2 rounded-lg text-xs font-bold text-white cursor-pointer transition-all hover:opacity-90 shrink-0"
                style={{ background: "linear-gradient(135deg, var(--clr-amber-dark), var(--clr-amber))", boxShadow: "0 2px 8px rgba(200,96,25,0.2)" }}>
                {annoFile ? annoFile.name : "选择文件"}
                <input type="file" accept=".csv,.tsv,.txt" className="hidden" onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    const text = await file.text();
                    const lines = text.trim().split("\n").map(function(l) { return l.replace("\r", ""); });
                    if (lines.length < 2) throw new Error("至少需要表头和数据行");
                    const sep = lines[0].indexOf("\t") >= 0 ? "\t" : ",";
                    const headers = lines[0].split(sep).map(function(h) { return h.trim().toLowerCase(); });
                    const cidIdx = headers.indexOf("cluster_id") >= 0 ? headers.indexOf("cluster_id") : headers.indexOf("cluster");
                    const ctIdx = headers.indexOf("celltype");
                    const mkIdx = headers.indexOf("markers");
                    if (cidIdx < 0) throw new Error("缺少 cluster 列");
                    if (ctIdx < 0) throw new Error("缺少 celltype 列");
                    var data = [];
                    for (var i = 1; i < lines.length; i++) {
                      var cols = lines[i].split(sep);
                      var cid = cols[cidIdx] ? cols[cidIdx].trim() : "";
                      var ct = cols[ctIdx] ? cols[ctIdx].trim() : "";
                      var mk = mkIdx >= 0 ? (cols[mkIdx] ? cols[mkIdx].trim() : "") : "";
                      if (cid && ct) data.push({ Cluster: cid, CellType: ct, Markers: mk });
                    }
                    if (data.length === 0) throw new Error("未解析到有效数据");
                    setAnnoFile({ name: file.name, data: data });
                  } catch(err) { setError("注释文件解析失败: " + (err instanceof Error ? err.message : "")); }
                }} />
              </label>
              {annoFile && (
                <button type="button" onClick={() => setAnnoFile(null)}
                  className="text-xs px-2 py-1 rounded hover:bg-red-50 shrink-0"
                  style={{ color: "var(--clr-text-faint)" }}>✕</button>
              )}
            </div>
            <a href="/api/tasks/example-cell-anno" download="example.cellAnno.txt"
              className="text-[10px] underline" style={{ color: "var(--clr-amber-dark)" }}>
              下载示例注释文件 (example.cellAnno.txt)
            </a>
          </div>
        )}

        {/* 图片格式选择 */}
        <div className="flex items-center gap-2 px-3 py-2 rounded text-xs" style={{ background: "rgba(200,96,25,0.04)", border: "1px solid rgba(200,96,25,0.15)" }}>
          <span style={{ color: "var(--clr-text-muted)" }}>图片格式:</span>
          <select value={(params.qc.plot_format as string) || "png"} onChange={(e) => { const v = e.target.value; setParams(prev => { const next = {...prev}; Object.keys(next).forEach(k => { next[k] = {...next[k], plot_format: v}; }); return next; }); }} style={{ border: "1px solid var(--clr-border)", borderRadius: 4, padding: "2px 6px", fontSize: 12, background: "white", color: "var(--clr-text)" }}>
            <option value="png">PNG (默认)</option>
            <option value="pdf">PDF</option>
          </select>
          <span style={{ color: "var(--clr-text-faint)", fontSize: 10 }}>不选默认PNG</span>
        </div>

        {/* 提示 */}
        <div
          className="px-3 py-2 rounded text-xs border border-dashed"
          style={{
            borderColor: "var(--clr-border)",
            color: "var(--clr-text-muted)",
          }}
        >
          将使用以上配置的参数依次执行全部分析步骤。
        </div>

                {/* 提交按钮 */}

        <button
          type="submit"
          disabled={loading}
          className="w-full px-4 py-2.5 rounded font-semibold text-white transition-all duration-200 flex items-center justify-center gap-2"
          style={{
            background: loading ? "var(--clr-text-muted)" : "var(--clr-amber)",
            cursor: loading ? "not-allowed" : "pointer",
            opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? (
            <>
              <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" strokeDasharray="15.7" opacity="0.3" />
                <circle cx="12" cy="12" r="10" strokeDasharray="15.7" />
              </svg>
              启动中...
            </>
          ) : (
            <>
              🚀 开始全流程分析
            </>
          )}
        </button>
      </form>
    </div>
  );
}
