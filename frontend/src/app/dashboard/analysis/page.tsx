/**
 * scCloud v2 — 分析流程向导页面
 *
 * Phase 3 重写: 从静态 UI → 完全 API 对接
 * Phase 5 重构: ComputaBio 暖色学术风格
 * Phase 6: Emoji → SVG line icons (GitHub Octicons style)
 */
"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import ProjectSelector from "../../components/ProjectSelector";
import ProgressTracker from "../../components/ProgressTracker";
import ResultViewer from "../../components/ResultViewer";
import TaskHistory from "../../components/TaskHistory";
import Tooltip from "../../components/Tooltip";
import {
  IconMicroscope, IconBarChart, IconAxis, IconCluster,
  IconTestTube, IconPathway, IconWaveform, IconTag, IconUpload, IconQuestion
} from "../../components/Icons";
import { getTask, submitTask, type Project, type Task, getAuthToken, uploadFileChunked, apiFetch, tryRefresh} from "../../lib/api";
import PipelineForm from "./components/PipelineForm";
import PipelineView from "./components/PipelineView";

/* ===== 步骤定义 ===== */

interface StepDef {
  id: string;
  num: number;
  label: string;
  Icon: ComponentType<{ className?: string; size?: number }>;
  desc: string;
  apiStep: string;
}

const STEPS: StepDef[] = [
  { id: "qc", num: 1, label: "数据预处理", Icon: IconMicroscope, desc: "质控过滤", apiStep: "qc" },
  { id: "normalize", num: 2, label: "数据标准化", Icon: IconBarChart, desc: "SCTransform", apiStep: "normalize" },
  { id: "reduce", num: 3, label: "数据降维", Icon: IconAxis, desc: "PCA/UMAP/tSNE", apiStep: "reduce" },
  { id: "cluster", num: 4, label: "批次聚类", Icon: IconCluster, desc: "Harmony 校正", apiStep: "cluster" },
  { id: "markers", num: 5, label: "差异基因", Icon: IconTestTube, desc: "FindMarkers", apiStep: "markers" },
  { id: "enrich", num: 6, label: "通路富集", Icon: IconPathway, desc: "GO/KEGG/GSEA", apiStep: "enrich" },
  { id: "marker_expr", num: 7, label: "Marker 表达", Icon: IconWaveform, desc: "基因表达可视化", apiStep: "marker_expr" },
  { id: "annotate", num: 8, label: "细胞注释", Icon: IconTag, desc: "SingleR/手动", apiStep: "annotate" },
];

/* ===== 各步骤参数定义 ===== */

const DEFAULT_PARAMS: Record<string, Record<string, unknown>> = {
  qc: { max_mt_ratio: 20, min_features: 200, max_features: 5000, umi_min_pct: 0, umi_max_pct: 1, plot_format: "png" },
  normalize: { plot_format: "png" },
  reduce: { method: "umap", n_pcs: 30, group_by: "Sample", plot_format: "png" },
  cluster: { method: "harmony", resolution: 0.5, n_dims: 30, group_by: "Sample", plot_format: "png" },
  markers: { cluster: "All", min_pct: 0.1, logfc_threshold: 0.25, p_val_adj: 0.05, test_use: "wilcox", only_pos: true, ntop: 5, plot_format: "png" },
  enrich: { pathway: "GO", direction: "Up", p_adjust_method: "BH", pvalue_cutoff: 0.05, qvalue_cutoff: 0.2, n_term: 10, plot_format: "png" },
  marker_expr: { cell_type: "", plot_format: "png" },
  annotate: { anno_type: "自动注释", group_by: "Sample", species: "Human", tissue: "Blood", plot_format: "png" },
};

/* ===== 主组件 ===== */

/** sessionStorage 工具函数 */
const SS_KEY = "sccloud_analysis_state";
function loadSession() {
  if (typeof window === "undefined") return null;
  try { return JSON.parse(sessionStorage.getItem(SS_KEY) || "null"); } catch { return null; }
}
function saveSession(patch: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  try {
    const prev = loadSession() || {};
    sessionStorage.setItem(SS_KEY, JSON.stringify({ ...prev, ...patch }));
  } catch { /* ignore */ }
}

function AnalysisPageContent() {
  const searchParams = useSearchParams();
  const initialProjectId = searchParams.get("project");

  // ── 从 sessionStorage 恢复持久化状态 ──
  const ss = loadSession();

  const [activeStep, _setActiveStep] = useState<number>(ss?.activeStep ?? 0);
  const [project, setProject] = useState<Project | null>(
    // 恢复项目对象（仅保存 id/name/storage_path 等轻量字段）
    ss?.project ?? null
  );
  const [params, setParams] = useState<Record<string, Record<string, unknown>>>(
    ss?.params ?? JSON.parse(JSON.stringify(DEFAULT_PARAMS))
  );
  // 每个步骤单独缓存最近一次 task，切换步骤不会丢失
  const [taskCache, setTaskCache] = useState<Record<string, Task>>(
    ss?.taskCache ?? {}
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 多文件上传状态（每文件可含多样本）
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
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>(
    ss?.uploadedFiles ?? (ss?.uploadedFile ? [ss.uploadedFile] : [])
  );
  // 样本分组映射：sample_name → group_label
  const [sampleGroups, setSampleGroups] = useState<Record<string, string>>(
    ss?.sampleGroups ?? {}
  );
  // 上传进度（0-100）
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [clusterLevels, setClusterLevels] = useState<string[]>([]);

  // Pipeline 模式切换（从 sessionStorage 恢复）
  const [analysisMode, _setAnalysisMode] = useState<"single" | "pipeline">(
    ss?.analysisMode ?? "single"
  );
  const [activePipelineId, setActivePipelineId] = useState<string | null>(
    ss?.activePipelineId ?? null
  );

  /** 持久化 analysisMode */
  const setAnalysisMode = (v: "single" | "pipeline" | ((p: "single" | "pipeline") => "single" | "pipeline")) => {
    _setAnalysisMode((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      saveSession({ analysisMode: next });
      return next;
    });
  };

  /** 持久化 activePipelineId */
  const setActivePipelineIdPersist = (v: string | null | ((p: string | null) => string | null)) => {
    setActivePipelineId((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      saveSession({ activePipelineId: next });
      return next;
    });
  };

  // PipelineView 返回按钮事件监听
  useEffect(() => {
    const handlePipelineBack = () => setActivePipelineIdPersist(null);
    window.addEventListener("pipeline-back", handlePipelineBack);
    return () => window.removeEventListener("pipeline-back", handlePipelineBack);
  }, []);

  // Marker 基因文件上传状态
  const [markerFile, setMarkerFile] = useState<{ name: string; path: string; cellTypes: string[] } | null>(null);
  const [annoFile, setAnnoFile] = useState<{ name: string; data: Record<string,string>[] } | null>(null);
  const markerInputRef = useRef<HTMLInputElement>(null);
  // Phase A 解析完成标记：结果显示在右侧但不折叠参数面板
  const [markerParseOnly, setMarkerParseOnly] = useState(false);
  const [markerUploading, setMarkerUploading] = useState(false);

  const step = STEPS[activeStep];
  // 当前步骤的 task（来自 cache）
  const currentTask = taskCache[step.id] ?? null;
  const currentTaskId = currentTask?.id ?? null;

  /** 持久化包装器 */
  const setActiveStep = (v: number | ((p: number) => number)) => {
    _setActiveStep((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      saveSession({ activeStep: next });
      return next;
    });
  };
  // showResults 现在已废弃，由 currentTask 自动驱动，保留 setter 以兼容历史 sessionStorage
  const setShowResults = (_v: boolean) => { saveSession({ showResults: _v }); };

  /** 更新某步骤的 task 缓存并持久化（只存轻量字段，防止 sessionStorage 溢出） */
  const updateTaskCache = useCallback((stepId: string, task: Task) => {
    setTaskCache((prev) => {
      const next = { ...prev, [stepId]: task };
      // 只持久化轻量元数据，不含 params（可能很大）
      const slim: Record<string, Partial<Task>> = {};
      for (const [k, t] of Object.entries(next)) {
        slim[k] = { id: t.id, step: t.step, status: t.status,
                    result_path: t.result_path, completed_at: t.completed_at,
                    error_msg: t.error_msg, progress: t.progress };
      }
      saveSession({ taskCache: slim });
      return next;
    });
  }, []);

  /** 清除某步骤的 task 缓存（点击"返回参数设置"时使用） */
  const clearTaskCache = useCallback((stepId: string) => {
    setTaskCache((prev) => {
      const next = { ...prev };
      delete next[stepId];
      const slim: Record<string, Partial<Task>> = {};
      for (const [k, t] of Object.entries(next)) {
        slim[k] = { id: t.id, step: t.step, status: t.status,
                    result_path: t.result_path, completed_at: t.completed_at,
                    error_msg: t.error_msg, progress: t.progress };
      }
      saveSession({ taskCache: slim });
      return next;
    });
  }, []);

  /** 刷新后从 API 批量恢复 task 对象 */
  useEffect(() => {
    const savedCache = ss?.taskCache as Record<string, Task> | undefined;
    if (!savedCache || Object.keys(savedCache).length === 0) return;
    // 恢复所有步骤的 task（确保跨步骤依赖如 clusterLevels 可用）
    // 走 getTask → apiFetch：token 过期自动刷新
    for (const [stepId, savedTask] of Object.entries(savedCache)) {
      if (!savedTask?.id) continue;
      getTask(savedTask.id)
        .then((task: Task | null) => {
          if (task) updateTaskCache(stepId, task);
        })
        .catch(() => { /* 找不到就算 */ });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** params / uploadedFiles / sampleGroups 变更时持久化 */
  useEffect(() => { saveSession({ params }); }, [params]);
  useEffect(() => { saveSession({ uploadedFiles, uploadedFile: uploadedFiles[0] ?? null }); }, [uploadedFiles]);
  useEffect(() => { saveSession({ sampleGroups }); }, [sampleGroups]);

  // 当用户定义了样本分组时，自动将各步骤的 group_by 切换为 Group
  useEffect(() => {
    const hasGroups = Object.keys(sampleGroups).length > 0;
    setParams((prev) => ({
      ...prev,
      reduce: { ...prev.reduce, group_by: hasGroups ? "Group" : "Sample" },
      cluster: { ...prev.cluster, group_by: hasGroups ? "Group" : "Sample" },
      annotate: { ...prev.annotate, group_by: hasGroups ? "Group" : "Sample" },
    }));
  }, [sampleGroups]);

  /**
   * 当聚类任务完成后，自动拉取其结果以提取 cluster_levels，
   * 供差异基因步骤的聚类多选器使用。
   */
  useEffect(() => {
    const clusterTask = taskCache.cluster;
    if (!clusterTask?.id || clusterTask.status !== "completed") {
      // 仅在确认不存在聚类任务时清空，避免异步恢复期间误清
      if (clusterTask === undefined && clusterLevels.length > 0) return;
      setClusterLevels([]);
      return;
    }
    // 走 apiFetch：token 过期自动刷新
    apiFetch<Record<string, unknown>>(`/api/tasks/${clusterTask.id}/result`)
      .then((data) => {
        const stats = data?.stats as { cluster_levels?: string[] } | undefined;
        if (stats?.cluster_levels?.length) {
          setClusterLevels(stats.cluster_levels);
        }
      })
      .catch(() => { /* 静默 */ });
  }, [taskCache.cluster?.id, taskCache.cluster?.status]);

  /**
   * 安全回退轮询：同步当前步骤任务的最新状态到 taskCache。
   * 1. 防止 ProgressTracker 回调失败导致 UI 卡死（终态保护）
   * 2. 同步中间进度，让 ResultViewer 的 spinner 也显示真实进度描述
   */
  useEffect(() => {
    if (!currentTask?.id) return;
    if (currentTask.status === "completed" || currentTask.status === "failed" || currentTask.status === "cancelled") return;

    const interval = setInterval(async () => {
      try {
        const fresh = await getTask(currentTask.id);
        // 始终同步最新状态（包括中间进度），让 ResultViewer 也能读到
        updateTaskCache(step.id, fresh);
        if (fresh.status === "completed" || fresh.status === "failed") {
          clearInterval(interval);
        }
      } catch { /* 静默忽略，下次重试 */ }
    }, 3000);

    return () => clearInterval(interval);
  }, [currentTask?.id, currentTask?.status, step.id, updateTaskCache]);

  const stepParams = params[step.id] || {};

  const updateParam = useCallback(
    (key: string, value: unknown) => {
      setParams((prev) => ({
        ...prev,
        [step.id]: { ...prev[step.id], [key]: value },
      }));
    },
    [step.id]
  );

  /** 真实分片上传 RDS 文件到项目目录。
   *  走 uploadFileChunked → apiFetch：每个分片请求在 401 时自动 tryRefresh 续期重试，
   *  解决长会话/大文件(>15min token 过期)时上传报「无法验证凭据」。 */
  const handleFileUpload = async (file: File) => {
    if (!project) { setError("请先选择项目"); return; }
    setUploadProgress(0);
    setError(null);
    try {
      const result = await uploadFileChunked(file, project.id, (p) => {
        setUploadProgress(p.percent);
      });
      setUploadProgress(100);
      setUploadedFiles(prev => [...prev, { name: result.filename || file.name, path: result.path }]);
      setTimeout(() => setUploadProgress(null), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败");
      setUploadProgress(null);
    }
  };

  const handleSubmit = async () => {
    if (!project) { setError("请先选择项目"); return; }
    setError(null); setSubmitting(true);
    setShowResults(true);
    // marker_expr Phase B 手动提交时，清除 Phase A 的「不折叠」标记
    if (step.id === 'marker_expr') setMarkerParseOnly(false);
    try {
      // QC 步骤时把已上传文件路径注入参数
      let finalParams = step.id === "qc" && uploadedFiles.length > 0
        ? { ...stepParams, rds_file_path: uploadedFiles[0].path, sample_groups: sampleGroups }
        : stepParams;

      // marker_expr 步骤注入 marker 文件路径
      if (step.id === "marker_expr" && markerFile) {
        finalParams = { ...finalParams, marker_file_path: markerFile.path };
      }
      // 手动注释：注入 markers_table
      if (step.id === "annotate" && stepParams.anno_type === "手动注释" && annoFile) {
        finalParams = { ...finalParams, markers_table: annoFile.data };
      }
      // GSEA 不使用 direction 参数
      if (step.id === "enrich" && stepParams.pathway === "GSEA") {
        const { direction: _dir, ...rest } = finalParams as Record<string, unknown>;
        finalParams = rest;
      }

      const task = await submitTask({ project_id: project.id, step: step.apiStep, params: finalParams });
      updateTaskCache(step.id, task);
      // 不再立即清除下游缓存 —— 改为导航时懒清除
    } catch (e) {
      setError(e instanceof Error ? e.message : "提交失败");
    } finally { setSubmitting(false); }
  };

  /**
   * 导航到目标步骤，同时懒清除过期的下游缓存。
   * 规则：如果目标步骤有缓存结果，但任何上游步骤在它之后重新完成了，
   *       说明该缓存已失效 → 清除缓存（显示参数面板）。
   * 如果上游步骤仍在运行（未完成），则保留旧缓存（显示旧结果）。
   */
  const navigateToStep = (targetIdx: number) => {
    const targetStepId = STEPS[targetIdx].id;
    const targetTask = taskCache[targetStepId];
    if (targetTask && targetTask.created_at) {
      const targetCreatedAt = new Date(targetTask.created_at).getTime();
      for (let i = 0; i < targetIdx; i++) {
        const upstreamTask = taskCache[STEPS[i].id];
        if (
          upstreamTask?.status === "completed" &&
          upstreamTask.completed_at &&
          new Date(upstreamTask.completed_at).getTime() > targetCreatedAt
        ) {
          // 上游步骤在目标步骤之后重新完成了 → 目标缓存过期
          clearTaskCache(targetStepId);
          break;
        }
      }
    }
    setActiveStep(targetIdx);
    setError(null);
  };

  /**
   * 任务完成回调 — 始终从 API 重新获取完整 Task。
   * ProgressTracker 的 WS 回调可能传入不完整的 mock task（缺少 step/result_path 等），
   * 直接写入 taskCache 会导致 ResultViewer 渲染分支判断失败（空白结果区域）。
   */
  const handleTaskComplete = async (partialTask: Task) => {
    try {
      const fresh = await getTask(partialTask.id);
      updateTaskCache(step.id, fresh);
    } catch {
      // API 不可达时降级使用传入的 task（至少保证状态为 completed）
      updateTaskCache(step.id, partialTask);
    }
  };
  const handleTaskError = () => {};
  const handleSelectHistory = (task: Task) => {
    const idx = STEPS.findIndex((s) => s.apiStep === task.step);
    if (idx >= 0) {
      updateTaskCache(STEPS[idx].id, task);
      setActiveStep(idx);
    }
  };
  const handleProjectSelect = (p: Project | null) => {
    // 切换项目时重置所有与项目绑定的状态，避免旧数据泄漏
    setProject(p);
    setUploadedFiles([]);
    setSampleGroups({});
    setTaskCache({});
    setParams(JSON.parse(JSON.stringify(DEFAULT_PARAMS)));
    _setActiveStep(0);
    setActivePipelineId(null);
    saveSession({
      project: p,
      uploadedFiles: [],
      uploadedFile: null,
      sampleGroups: {},
      taskCache: {},
      params: JSON.parse(JSON.stringify(DEFAULT_PARAMS)),
      activeStep: 0,
      activePipelineId: null,
    });
    setError(null);
  };

  // 参数面板折叠由当前步骤是否有任务自动驱动，不再依赖全局 showResults
  // marker_expr Phase A 解析完成后仅显示结果但不折叠参数面板（仅限该步骤）
  const hasTaskForStep = currentTask !== null && !(step.id === 'marker_expr' && markerParseOnly);

  const inputCls = "w-full px-3 py-2 bg-white border rounded text-sm focus:outline-none focus:ring-2 focus:ring-[#C86019]/30 transition-colors";
  const inputStyle = { borderColor: "var(--clr-border)", color: "var(--clr-text)" };
  /* 跨浏览器统一 select 样式：移除原生箭头，用自定义 SVG chevron */
  const selectCls = inputCls + " cursor-pointer";
  const selectStyle: React.CSSProperties = {
    ...inputStyle,
    appearance: "none",
    WebkitAppearance: "none",
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E")`,
    backgroundRepeat: "no-repeat",
    backgroundPosition: "right 10px center",
    paddingRight: "32px",
  };

  return (
    <div className="animate-fade-in">
      {/* 标题 + 项目选择器 */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold" style={{ fontFamily: "var(--font-serif)", color: "var(--clr-dark-deep)" }}>
          scRNA分析
        </h1>
        <div className="flex items-center gap-3">
          {project && (
            <button
              onClick={async (e) => {
                const btn = e.currentTarget;
                const origHTML = btn.innerHTML;
                btn.innerHTML = '<span class="w-3 h-3 border-2 border-t-transparent rounded-full animate-spin"></span> 打包中...';
                btn.disabled = true;
                try {
                  const dlUrl = `/api/projects/${project.id}/download`;
                  // blob 下载不能走 apiFetch(它只解析 JSON)，手动加一次 401 刷新重试
                  let res = await fetch(dlUrl, { headers: { Authorization: `Bearer ${getAuthToken() || ""}` } });
                  if (res.status === 401) {
                    const nt = await tryRefresh();
                    if (nt) res = await fetch(dlUrl, { headers: { Authorization: `Bearer ${nt}` } });
                  }
                  if (!res.ok) {
                    const errText = await res.text();
                    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 100)}`);
                  }
                  const blob = await res.blob();
                  if (blob.size === 0) throw new Error("打包文件为空，项目可能没有结果文件");
                  const now = new Date();
                  const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}`;
                  const filename = `${project.name}-${ts}.zip`;
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = filename;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                } catch(e) {
                  alert("打包下载失败: " + (e instanceof Error ? e.message : ""));
                } finally {
                  btn.innerHTML = origHTML;
                  btn.disabled = false;
                }
              }}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded text-xs font-medium transition-all hover:shadow-sm shrink-0"
              style={{ border: "1px solid var(--clr-border)", color: "var(--clr-amber-dark)", background: "rgba(200,96,25,0.04)" }}
              title="打包下载全部分析结果"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              导出项目
            </button>
          )}
          <div className="w-72">
            <ProjectSelector
              selectedId={project?.id ?? (initialProjectId ? Number(initialProjectId) : null)}
              onSelect={handleProjectSelect}
            />
          </div>
        </div>
      </div>

      {/* ===== 分析模式 Tab 切换 ===== */}
      <div className="flex gap-2 mb-6 border-b" style={{ borderColor: "var(--clr-border)" }}>
        <button
          className={`px-4 py-2 text-sm font-semibold transition-all ${
            analysisMode === "single"
              ? "border-b-2"
              : "opacity-60 hover:opacity-80"
          }`}
          style={
            analysisMode === "single"
              ? { borderColor: "var(--clr-amber)", color: "var(--clr-amber)" }
              : { color: "var(--clr-text-muted)" }
          }
          onClick={() => {
            setAnalysisMode("single");
            setActivePipelineIdPersist(null);
          }}
        >
          单步分析
        </button>
        <button
          className={`px-4 py-2 text-sm font-semibold transition-all ${
            analysisMode === "pipeline"
              ? "border-b-2"
              : "opacity-60 hover:opacity-80"
          }`}
          style={
            analysisMode === "pipeline"
              ? { borderColor: "var(--clr-amber)", color: "var(--clr-amber)" }
              : { color: "var(--clr-text-muted)" }
          }
          onClick={() => setAnalysisMode("pipeline")}
        >
          全流程分析
        </button>
      </div>

      {/* ===== Pipeline 模式内容 ===== */}
      {analysisMode === "pipeline" && project ? (
        <div className="space-y-6">
          {!activePipelineId ? (
            <PipelineForm
              projectId={project.id}
              token={getAuthToken() || ""}
              onSubmit={(pipelineId) => setActivePipelineIdPersist(pipelineId)}
              uploadedFiles={uploadedFiles}
              onUploadedFilesChange={setUploadedFiles}
              sampleGroups={sampleGroups}
              onSampleGroupsChange={setSampleGroups}
            />
          ) : (
            <PipelineView
              pipelineId={activePipelineId}
              token={getAuthToken() || ""}
              projectName={project?.name}
            />
          )}
        </div>
      ) : analysisMode === "pipeline" ? (
        <div className="p-6 rounded-lg border" style={{ borderColor: "var(--clr-border)", background: "rgba(255,0,0,0.05)" }}>
          <p style={{ color: "var(--clr-warn)" }}>请先选择一个项目</p>
        </div>
      ) : null}

      {/* ===== 单步分析模式内容 ===== */}
      {analysisMode === "single" && (
      <div className="flex gap-6">
        {/* ===== Step Sidebar ===== */}
        <div className="w-56 shrink-0 space-y-1">
          {STEPS.map((s, i) => (
            <button
              key={s.id}
              onClick={() => navigateToStep(i)}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded text-sm text-left transition-all duration-200"
              style={
                activeStep === i
                  ? { borderLeft: "3px solid var(--clr-amber)", color: "var(--clr-amber-dark)", background: "rgba(200,96,25,0.06)", fontWeight: 600 }
                  : { borderLeft: "3px solid transparent", color: "var(--clr-text-muted)" }
              }
            >
              <s.Icon size={18} className={activeStep === i ? "text-[#C86019]" : "text-[#999]"} />
              <div>
                <div>{s.num}. {s.label}</div>
                <div className="text-xs" style={{ color: "var(--clr-text-faint)" }}>{s.desc}</div>
              </div>
            </button>
          ))}

          {project && (
            <div className="mt-6 pt-4" style={{ borderTop: "1px solid var(--clr-border)" }}>
              <TaskHistory
                projectId={project.id}
                onSelect={handleSelectHistory}
                
              />
            </div>
          )}
        </div>




{/* ===== Main Content ===== */}
        <div className="flex-1 flex gap-6 items-stretch" style={{ minWidth: 0 }}>
          {/* Parameters Panel — 动态收缩 */}
          <div
            style={{
              width: hasTaskForStep ? 0 : 288,
              minWidth: hasTaskForStep ? 0 : 288,
              opacity: hasTaskForStep ? 0 : 1,
              overflow: 'hidden',
              transition: 'width 0.45s cubic-bezier(0.4,0,0.2,1), min-width 0.45s cubic-bezier(0.4,0,0.2,1), opacity 0.3s ease',
              flexShrink: 0,
              alignSelf: 'stretch',
            }}
          >
            <div className="card space-y-4" style={{ width: 288 }}>
              <div className="card-label">参数设置</div>
              <h3 className="font-semibold flex items-center gap-2" style={{ fontFamily: "var(--font-serif)", color: "var(--clr-dark)" }}>
                <step.Icon size={18} />
                {step.label}
              </h3>

              {/* 通用输入数据指示器 — 非 QC 步骤显示前置步骤的输出 RDS */}
              {(() => {
                const INPUT_MAP: Record<string, { prereqId: string; loadedLabel: string; rdsFile: string; missingLabel: string }> = {
                  normalize: { prereqId: "qc", loadedLabel: "已加载质控输出", rdsFile: "seurat_qc.rds", missingLabel: "需要先完成 Step 1 数据预处理" },
                  reduce:    { prereqId: "normalize", loadedLabel: "已加载标准化输出", rdsFile: "seurat_normalized.rds", missingLabel: "需要先完成 Step 2 数据标准化" },
                  cluster:   { prereqId: "reduce", loadedLabel: "已加载降维输出", rdsFile: "seurat_reduced.rds", missingLabel: "需要先完成 Step 3 数据降维" },
                  markers:   { prereqId: "cluster", loadedLabel: "已加载聚类输出", rdsFile: "seurat_clustered.rds", missingLabel: "需要先完成 Step 4 批次聚类" },
                  enrich:    { prereqId: "markers", loadedLabel: "已加载差异基因输出", rdsFile: "diff_genes.csv", missingLabel: "需要先完成 Step 5 差异基因" },
                  marker_expr: { prereqId: "cluster", loadedLabel: "已加载聚类输出", rdsFile: "seurat_clustered.rds", missingLabel: "需要先完成 Step 4 批次聚类" },
                  annotate:  { prereqId: "cluster", loadedLabel: "已加载聚类输出", rdsFile: "seurat_clustered.rds", missingLabel: "需要先完成 Step 4 批次聚类" },
                };
                const info = INPUT_MAP[step.id];
                if (!info) return null;
                const ready = taskCache[info.prereqId]?.status === "completed";
                return (
                  <div>
                    <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>输入数据</label>
                    <div
                      className="flex items-center justify-center gap-2 w-full py-2 text-xs border border-dashed rounded mb-1.5"
                      style={{
                        borderColor: ready ? "#C86019" : "var(--clr-border)",
                        color: ready ? "#C86019" : "var(--clr-text-faint)",
                        background: ready ? "rgba(200,96,25,0.04)" : undefined,
                        cursor: "default",
                      }}
                    >
                      <span>{ready ? info.loadedLabel : info.missingLabel}</span>
                    </div>
                    {ready && (
                      <div className="flex items-center gap-2 mt-1">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#2D8A56" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                        <span className="flex-1 truncate text-[11px]" style={{ color: "var(--clr-text-muted)" }}>{info.rdsFile}</span>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* QC 参数 */}
              {step.id === "qc" && (
                <>
                  <div>
                    <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>上传数据文件</label>

                    {/* 上传按钮 */}
                    <div
                      onClick={() => {
                        if (!project) {
                          setError("请先选择项目再上传文件");
                          window.dispatchEvent(new CustomEvent("open-project-selector"));
                          return;
                        }
                        fileInputRef.current?.click();
                      }}
                      className="flex items-center justify-center gap-2 w-full py-2 bg-white hover:shadow-sm transition-all text-xs border border-dashed rounded mb-1.5"
                      style={{
                        cursor: "pointer",
                        borderColor: uploadedFiles.length > 0 ? "#C86019" : "var(--clr-border)",
                        color: uploadedFiles.length > 0 ? "#C86019" : "var(--clr-text-muted)",
                        background: uploadedFiles.length > 0 ? "rgba(200,96,25,0.04)" : undefined,
                        pointerEvents: uploadProgress !== null ? "none" : undefined,
                        opacity: uploadProgress !== null ? 0.6 : 1,
                      }}
                    >
                      <IconUpload size={14} className="text-[#C86019]" />
                      <span>{uploadedFiles.length > 0 ? "重新上传" : "上传数据文件"}</span>
                    </div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".rds,.h5seurat,.h5ad,.h5,.rdata,.loom"
                      className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileUpload(f); e.target.value = ''; }}
                    />

                    {/* 上传进度条 */}
                    {uploadProgress !== null && (
                      <div className="w-full px-1 space-y-1">
                        <div className="flex justify-between text-[10px]" style={{ color: "var(--clr-amber-dark)" }}>
                          <span>上传中...</span><span>{uploadProgress}%</span>
                        </div>
                        <div className="w-full h-1 rounded-full" style={{ background: "var(--clr-border)" }}>
                          <div className="h-full rounded-full transition-all duration-300" style={{ width: `${uploadProgress}%`, background: "var(--clr-amber)" }} />
                        </div>
                      </div>
                    )}

                    {/* 已上传文件名 */}
                    {uploadedFiles.length > 0 && uploadProgress === null && (
                      <>
                        <div className="flex items-center gap-2 mt-1">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#2D8A56" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                          <span className="flex-1 truncate text-[11px]" style={{ color: "var(--clr-text-muted)" }}>{uploadedFiles[0].name}</span>
                          <button
                            type="button"
                            onClick={() => { setUploadedFiles([]); saveSession({ uploadedFiles: [], uploadedFile: null }); }}
                            title="移除文件"
                            className="p-1 rounded hover:bg-red-50 transition-colors shrink-0"
                            style={{ color: "var(--clr-danger)" }}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                          </button>
                        </div>
                        <p className="text-[10px] mt-0.5" style={{ color: "var(--clr-amber-dark)" }}>
                          已上传 {uploadedFiles.length} 个文件
                        </p>
                      </>
                    )}

                    {/* 示例 RDS */}
                    <a
                      href="/api/tasks/example-rds"
                      download="example.Samples.rds"
                      className="text-[10px] mt-1 inline-block underline"
                      style={{ color: "var(--clr-amber-dark)" }}
                    >
                      下载示例 RDS 文件
                    </a>
                  </div>

                  {/* 样本分组定义 */}
                  <div>
                    <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>样本分组定义</label>
                    <p className="text-[10px] mb-2" style={{ color: "var(--clr-text-faint)" }}>每行 "样本名=分组名"，如 Sample1=Control</p>
                    <textarea
                      value={Object.entries(sampleGroups).map(([k,v]) => k + '=' + v).join('\n')}
                      onChange={(e) => {
                        const map: Record<string,string> = {};
                        e.target.value.split('\n').forEach((line: string) => {
                          const [k, v] = line.split('=').map((s: string) => s.trim());
                          if (k && v) map[k] = v;
                        });
                        setSampleGroups(map);
                      }}
                      rows={3}
                      className="w-full px-2 py-1.5 text-xs rounded border"
                      style={{ borderColor: "var(--clr-border)", color: "var(--clr-text)", background: "white", resize: "vertical" }}
                      placeholder="Sample1=Control\nSample2=Treatment"
                    />
                  </div>
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                      <span>最大线粒体基因比例 (%)</span>
                      <Tooltip content="变量: max_mt_ratio\n\n设定细胞内线粒体基因表达占比的最大阈值。\n线粒体占比居高(如>10~20%)通常标志着由于膜破裂导致的胞质转录本大规模流失，细胞处于濒死受损状态。">
                        <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                      </Tooltip>
                    </label>
                    <input type="range" min="0" max="100" value={stepParams.max_mt_ratio as number} onChange={(e) => updateParam("max_mt_ratio", Number(e.target.value))} className="w-full accent-[#C86019]" />
                    <div className="text-xs text-right" style={{ color: "var(--clr-text-faint)", fontFamily: "var(--font-mono)" }}>{stepParams.max_mt_ratio as number}%</div>
                  </div>
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                      <span>最小表达基因数</span>
                      <Tooltip content="变量: min_features\n\n细胞必须检测到的最小独特基因数量(Features)。\n基因数过少通常意味着由于测序深度不足、细胞破裂或该液滴中根本没有包裹有效细胞(空泡液滴)，用于基础质控。">
                        <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                      </Tooltip>
                    </label>
                    <input type="number" value={stepParams.min_features as number} onChange={(e) => updateParam("min_features", Number(e.target.value))} min={1} className={inputCls} style={inputStyle} />
                  </div>
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                      <span>最大表达基因数</span>
                      <Tooltip content="变量: max_features\n\n细胞内检测到的最大独特基因数量。\n基因数过高往往是因为一个液滴内包裹了两个或多个细胞(双细胞/多细胞混合物)，导致检测到的基因种类异常偏多，剔除它们可避免产生混合伪类群。">
                        <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                      </Tooltip>
                    </label>
                    <input type="number" value={stepParams.max_features as number} onChange={(e) => updateParam("max_features", Number(e.target.value))} min={1} className={inputCls} style={inputStyle} />
                  </div>
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                      <span>nUMI 底部过滤分位数</span>
                      <Tooltip content="变量: umi_min_pct\n\n基于全群细胞UMI总数(nCount_RNA)分布计算下限截取分位。0 意味着不裁选，0.05 代表去除总体 UMI 最小的那 5% 的低质量游离碎片。">
                        <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                      </Tooltip>
                    </label>
                    <input type="number" value={stepParams.umi_min_pct as number} onChange={(e) => updateParam("umi_min_pct", Number(e.target.value))} min={0} max={1} step={0.01} className={inputCls} style={inputStyle} />
                  </div>
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                      <span>nUMI 顶部过滤分位数</span>
                      <Tooltip content="变量: umi_max_pct\n\n基于全群细胞UMI总数分布计算上限截取分位。1 意味着不裁选，0.95 代表去除总体 UMI 极高极异常的那 5% 的双细胞复合体。">
                        <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                      </Tooltip>
                    </label>
                    <input type="number" value={stepParams.umi_max_pct as number} onChange={(e) => updateParam("umi_max_pct", Number(e.target.value))} min={0} max={1} step={0.01} className={inputCls} style={inputStyle} />
                  </div>

                </>
              )}

              {step.id === "normalize" && (
                <div>
                  <p className="text-[10px] mt-2" style={{ color: "var(--clr-text-faint)" }}>使用 SCTransform + glmGamPoi 方法进行标准化。</p>
                </div>
              )}

              {step.id === "reduce" && (
                <>
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                      <span>降维方法</span>
                      <Tooltip content="变量: method\n\n在高维基因空间内降维映射的算法。\nUMAP / t-SNE 注重局部近邻结构的非线性拓扑保留，适合可视化；PCA 则是寻找全局方差最大的线性组合，常作为前置步骤计算。">
                        <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                      </Tooltip>
                    </label>
                    <select value={stepParams.method as string} onChange={(e) => updateParam("method", e.target.value)} className={selectCls} style={selectStyle}>
                      <option value="umap">UMAP</option><option value="tsne">t-SNE</option><option value="pca">PCA</option>
                    </select>
                  </div>
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                      <span>PCA 维度</span>
                      <Tooltip content="变量: n_pcs\n\n参与下游降维和聚类的主成分(Principal Components)数量。\n截取前列的主要维度可去除背景技术噪音(Dropout/技术变异)，保留起主要作用的生物学异质性。">
                        <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                      </Tooltip>
                    </label>
                    <input type="number" value={stepParams.n_pcs as number} onChange={(e) => updateParam("n_pcs", Number(e.target.value))} min={2} className={inputCls} style={inputStyle} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>分组方式</label>
                    <div className="flex gap-4">
                      {["Sample", "Group"].map((v) => (
                        <label key={v} className="flex items-center gap-1 text-sm cursor-pointer" style={{ color: "var(--clr-text)" }}>
                          <input type="radio" name="group_by" value={v} checked={stepParams.group_by === v} onChange={() => updateParam("group_by", v)} className="accent-[#C86019]" />
                          {v === "Sample" ? "样本" : "处理组"}
                        </label>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {step.id === "cluster" && (
                <>
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                      <span>校正方法</span>
                      <Tooltip content="变量: method\n\nHarmony 是目前最流行的单细胞批次校正算法，速度快、效果好。">
                        <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                      </Tooltip>
                    </label>
                    <select value={stepParams.method as string} onChange={(e) => updateParam("method", e.target.value)} className={selectCls} style={selectStyle}><option value="harmony">Harmony</option></select>
                  </div>
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                      <span>降维维度</span>
                      <Tooltip content="变量: n_dims\n\nPCA/Harmony 使用的维度数，通常 20~30 维。">
                        <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                      </Tooltip>
                    </label>
                    <input type="number" value={stepParams.n_dims as number} onChange={(e) => updateParam("n_dims", Number(e.target.value))} min={2} max={50} className={inputCls} style={inputStyle} />
                  </div>
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                      <span>批次校正分组</span>
                      <Tooltip content="变量: group_by\n\n指定按哪个元数据字段进行批次校正。通常选 Sample（样本）或 group（处理组）。">
                        <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                      </Tooltip>
                    </label>
                    <div className="flex gap-4">
                      {["Sample", "group"].map((v) => (
                        <label key={v} className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: "var(--clr-text)" }}>
                          <input type="radio" name="cluster_group_by" value={v} checked={(stepParams.group_by ?? "Sample") === v} onChange={() => updateParam("group_by", v)} className="accent-[#C86019]" />
                          {v === "Sample" ? "样本" : "处理组"}
                        </label>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                      <span>聚类分辨率</span>
                      <Tooltip content="变量: resolution\n\n决定 SNN 图聚类敏感度。数值越大细胞亚群越细密（0.8+）；数值越小划分越粗放（0.2）。">
                        <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                      </Tooltip>
                    </label>
                    <input type="range" min="0" max="2" step="0.01" value={stepParams.resolution as number} onChange={(e) => updateParam("resolution", Number(e.target.value))} className="w-full accent-[#C86019]" />
                    <div className="flex justify-between text-[10px]" style={{ color: "var(--clr-text-faint)", fontFamily: "var(--font-mono)" }}>
                      <span>0</span><span style={{ color: "var(--clr-amber)",fontWeight:600 }}>{stepParams.resolution as number}</span><span>2</span>
                    </div>
                  </div>
                </>
              )}

              {step.id === "markers" && (
                <>
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                      <span>最小细胞比例</span>
                      <Tooltip content="变量: min_pct\n\n设定只在各对比组内最少 x% 分数的细胞中表达的基因才会参与统计检验。这极大提高了运算速度，屏蔽了纯属技术噪音的散发基因。">
                        <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                      </Tooltip>
                    </label>
                    <input type="number" value={stepParams.min_pct as number} onChange={(e) => updateParam("min_pct", Number(e.target.value))} min={0} max={1} step={0.01} className={inputCls} style={inputStyle} />
                  </div>
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                      <span>log2FC 阈值</span>
                      <Tooltip content="变量: logfc_threshold\n\n两簇间平均基因表达量差异(以2为底的对数折叠变化)。差异绝对值必须超过此限制才被定性为差异表达基因(DEG)。">
                        <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                      </Tooltip>
                    </label>
                    <input type="number" value={stepParams.logfc_threshold as number} onChange={(e) => updateParam("logfc_threshold", Number(e.target.value))} step={0.05} className={inputCls} style={inputStyle} />
                  </div>
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                      <span>P value 阈值 (p_val_adj)</span>
                      <Tooltip content="变量: p_val_adj\n\n经 Bonferroni 校正后的 P 值阈值。只有 p_val_adj 低于此值的基因才被视为显著差异表达基因 (DEG)，出现在结果表格和图中。默认: 0.05。">
                        <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                      </Tooltip>
                    </label>
                    <input type="number" value={stepParams.p_val_adj as number ?? 0.05} onChange={(e) => updateParam("p_val_adj", Number(e.target.value))} step={0.01} min={0} max={1} className={inputCls} style={inputStyle} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>检验方法</label>
                    <select value={stepParams.test_use as string} onChange={(e) => updateParam("test_use", e.target.value)} className={selectCls} style={selectStyle}>
                      <option value="wilcox">Wilcoxon</option><option value="t">t-test</option><option value="bimod">Bimod</option><option value="roc">ROC</option>
                    </select>
                  </div>
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                      <span>Top 基因数 (ntop)</span>
                      <Tooltip content="变量: ntop\n\n决定在「热图」和「点图」中提取每个簇的前多少个最显著基因进行展示（默认: 5）。">
                        <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                      </Tooltip>
                    </label>
                    <input type="number" value={stepParams.ntop as number ?? 5} onChange={(e) => updateParam("ntop", Number(e.target.value))} min={1} max={50} className={inputCls} style={inputStyle} />
                  </div>
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                      <span>仅正向差异 (only_pos)</span>
                      <Tooltip content="变量: only_pos\n\n若为 TRUE，则只返回上调基因(avg_log2FC > 0)。">
                        <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                      </Tooltip>
                    </label>
                    <select value={String(stepParams.only_pos ?? true)} onChange={(e) => updateParam("only_pos", e.target.value === "true")} className={selectCls} style={selectStyle}>
                      <option value="true">TRUE（仅上调）</option>
                      <option value="false">FALSE（上下调均返回）</option>
                    </select>
                  </div>
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                      <span>分析聚类</span>
                      <Tooltip content="变量: cluster\n\n选择 'All' 则对所有聚类做 FindAllMarkers；选择具体聚类则只对所选聚类做 FindMarkers (1 vs rest)。支持多选。">
                        <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                      </Tooltip>
                    </label>
                    {(() => {
                      // 优先使用聚类结果的 levels，回退到当前参数中已选的 cluster 值
                      const effectiveLevels = clusterLevels.length > 0
                        ? clusterLevels
                        : ((stepParams.cluster as string) && (stepParams.cluster as string) !== "All"
                          ? (stepParams.cluster as string).split(",").filter(Boolean)
                          : []);
                      return effectiveLevels.length === 0;
                    })() ? (
                      /* 聚类尚未完成且无历史选择 —— 仅显示 All */
                      <select value={stepParams.cluster as string ?? "All"} onChange={(e) => updateParam("cluster", e.target.value)} className={selectCls} style={selectStyle}>
                        <option value="All">All（所有聚类）</option>
                      </select>
                    ) : (
                      /* 聚类已完成 —— 多选 checkbox 面板 */
                      <div className="border rounded p-2 space-y-1" style={{ borderColor: "var(--clr-border)", maxHeight: 160, overflowY: "auto" }}>
                        {/* All 选项 */}
                        <label className="flex items-center gap-2 text-xs cursor-pointer px-1 py-0.5 rounded hover:bg-stone-50 transition-colors" style={{ color: "var(--clr-text)" }}>
                          <input
                            type="checkbox"
                            className="accent-[#C86019]"
                            checked={(stepParams.cluster as string) === "All"}
                            onChange={(e) => {
                              if (e.target.checked) {
                                updateParam("cluster", "All");
                              }
                            }}
            />
                          All（所有聚类）
                        </label>
                        <div style={{ borderTop: "1px solid var(--clr-border)", margin: "2px 0" }} />
                        {(clusterLevels.length > 0 ? clusterLevels : ((stepParams.cluster as string) && (stepParams.cluster as string) !== "All" ? (stepParams.cluster as string).split(",").filter(Boolean) : [])).map((cl) => {
                          const currentVal = stepParams.cluster as string ?? "All";
                          const selected = currentVal !== "All" ? currentVal.split(",") : [];
                          const isChecked = selected.includes(cl);
                          return (
                            <label key={cl} className="flex items-center gap-2 text-xs cursor-pointer px-1 py-0.5 rounded hover:bg-stone-50 transition-colors" style={{ color: "var(--clr-text)" }}>
                              <input
                                type="checkbox"
                                className="accent-[#C86019]"
                                checked={isChecked}
                                onChange={(e) => {
                                  let next: string[];
                                  if (e.target.checked) {
                                    next = [...selected, cl];
                                  } else {
                                    next = selected.filter((c) => c !== cl);
                                  }
                                  if (next.length === 0 || next.length === clusterLevels.length) {
                                    updateParam("cluster", "All");
                                  } else {
                                    updateParam("cluster", next.join(","));
                                  }
                                }}
                />
                              Cluster {cl}
                            </label>
                          );
                        })}
                      </div>
                    )}
                    {(stepParams.cluster as string) !== "All" && (stepParams.cluster as string) && (
                      <p className="text-[10px] mt-1" style={{ color: "var(--clr-amber)" }}>
                        已选: {(stepParams.cluster as string).split(",").map(c => `Cluster ${c}`).join(", ")}
                      </p>
                    )}
                  </div>
                </>
              )}

              {step.id === "enrich" && (
                <>
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                      <span>富集通路</span>
                      <Tooltip content="变量: pathway\n\n基因集富集的参考生命网络。\nGO：基因本体论(生物功能注释)；\nKEGG：系统互作的代谢信号通路；\nGSEA：无需过滤直接评估基因阵列在通路的整体偏移程度。">
                        <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                      </Tooltip>
                    </label>
                    <select value={stepParams.pathway as string} onChange={(e) => updateParam("pathway", e.target.value)} className={selectCls} style={selectStyle}>
                      <option value="GO">GO</option><option value="KEGG">KEGG</option><option value="GSEA">GSEA</option>
                    </select>
                  </div>
                  {stepParams.pathway !== "GSEA" && (
                  <div>
                    <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>基因方向</label>
                    <div className="flex gap-4">
                      {["Up", "Down"].map((v) => (
                        <label key={v} className="flex items-center gap-1 text-sm cursor-pointer" style={{ color: "var(--clr-text)" }}>
                          <input type="radio" name="direction" value={v} checked={stepParams.direction === v} onChange={() => updateParam("direction", v)} className="accent-[#C86019]" /> {v}
                        </label>
                      ))}
                    </div>
                  </div>
                  )}
                  {/* P值校正方法 */}
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                      <span>P值校正方法</span>
                      <Tooltip content={"变量: p_adjust_method\n\n多重检验校正方法。\nBH (Benjamini-Hochberg) 是最常用的 FDR 校正。"}>
                        <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                      </Tooltip>
                    </label>
                    <select value={(stepParams.p_adjust_method as string) ?? "BH"} onChange={(e) => updateParam("p_adjust_method", e.target.value)} className={selectCls} style={selectStyle}>
                      <option value="BH">BH</option>
                      <option value="fdr">FDR</option>
                      <option value="none">None</option>
                      <option value="holm">Holm</option>
                      <option value="hochberg">Hochberg</option>
                      <option value="hommel">Hommel</option>
                      <option value="bonferroni">Bonferroni</option>
                      <option value="BY">BY</option>
                    </select>
                  </div>
                  {/* P值阈值 */}
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                      <span>P值阈值</span>
                      <Tooltip content={"变量: pvalue_cutoff\n\n显著性阈值，只保留 p 值小于此值的通路。\n默认 0.05。"}>
                        <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                      </Tooltip>
                    </label>
                    <input type="number" step="0.01" min="0" max="1"
                      value={(stepParams.pvalue_cutoff as number) ?? 0.05}
                      onChange={(e) => updateParam("pvalue_cutoff", parseFloat(e.target.value) || 0.05)}
                      className={selectCls} style={selectStyle} />
                  </div>
                  {/* Q值阈值 */}
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                      <span>Q值阈值</span>
                      <Tooltip content={"变量: qvalue_cutoff\n\nFDR 校正后的显著性阈值。\n默认 0.2。"}>
                        <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                      </Tooltip>
                    </label>
                    <input type="number" step="0.01" min="0" max="1"
                      value={(stepParams.qvalue_cutoff as number) ?? 0.2}
                      onChange={(e) => updateParam("qvalue_cutoff", parseFloat(e.target.value) || 0.2)}
                      className={selectCls} style={selectStyle} />
                  </div>
                  {/* 展示条目数 */}
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>
                      <span>展示条目数</span>
                      <Tooltip content={"变量: n_term\n\n每个富集类型显示的条目数。\n默认 10。"}>
                        <IconQuestion size={14} className="text-stone-400 hover:text-[#C86019] transition-colors" />
                      </Tooltip>
                    </label>
                    <input type="number" step="1" min="1" max="50"
                      value={(stepParams.n_term as number) ?? 10}
                      onChange={(e) => updateParam("n_term", parseInt(e.target.value) || 10)}
                      className={selectCls} style={selectStyle} />
                  </div>
                </>
              )}

              {step.id === "marker_expr" && (
                <>
                  {/* Marker 文件上传 */}
                  <div>
                    <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>Marker 基因文件</label>
                    <div
                      onClick={() => {
                        if (!project) {
                          setError("请先选择项目再上传文件");
                          window.dispatchEvent(new CustomEvent("open-project-selector"));
                          return;
                        }
                        markerInputRef.current?.click();
                      }}
                      className="flex items-center justify-center gap-2 w-full py-2 bg-white hover:shadow-sm transition-all text-xs border border-dashed rounded mb-1.5"
                      style={{
                        cursor: "pointer",
                        borderColor: markerFile ? "#C86019" : "var(--clr-border)",
                        color: markerFile ? "#C86019" : "var(--clr-text-muted)",
                        background: markerFile ? "rgba(200,96,25,0.04)" : undefined,
                      }}
                    >
                      <IconUpload size={14} className="text-[#C86019]" />
                      <span>{markerUploading ? "解析中..." : markerFile ? "重新上传" : "上传 Marker 列表 (.txt)"}</span>
                      {markerUploading && <div className="w-3.5 h-3.5 border-2 border-[#C86019]/30 border-t-[#C86019] rounded-full animate-spin" />}
                    </div>
                    <input ref={markerInputRef} type="file" accept=".txt" className="hidden" onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f || !project) return;
                      e.target.value = '';
                      setMarkerUploading(true);
                      const fd = new FormData();
                      fd.append('file', f);
                      try {
                        // 走 apiFetch：FormData 自动识别、token 过期自动刷新
                        const data = await apiFetch<{ path: string }>(`/api/tasks/marker-file?project_id=${project.id}`, {
                          method: 'POST',
                          body: fd,
                        });
                        // 提交 Phase A 解析任务获取 cell types
                        const taskRes = await submitTask({
                          project_id: project.id,
                          step: 'marker_expr',
                          params: { marker_file_path: data.path },
                        });
                        // 轮询等待完成
                        let resolved = taskRes;
                        for (let i = 0; i < 30; i++) {
                          await new Promise(r => setTimeout(r, 2000));
                          resolved = await getTask(taskRes.id);
                          if (resolved.status === 'completed' || resolved.status === 'failed') break;
                        }
                        if (resolved.status === 'completed') {
                          // 读取结果中的 cell_types
                          const result = await apiFetch<Record<string, unknown>>(`/api/tasks/${resolved.id}/result`).catch(() => ({} as Record<string, unknown>));
                          const rawTypes = result?.cell_types || [];
                          // R jsonlite 可能返回单元素数组，统一 unbox
                          const types = (Array.isArray(rawTypes) ? rawTypes : [rawTypes]).map(
                            (t: unknown) => Array.isArray(t) && t.length === 1 ? t[0] : t
                          ) as string[];
                          setMarkerFile({ name: f.name, path: data.path, cellTypes: types });
                          if (types.length > 0) updateParam('cell_type', types[0]);
                          // Phase A 结果写入缓存以便右侧面板展示，
                          // 但标记为 parseOnly 不触发参数面板折叠。
                          setMarkerParseOnly(true);
                          updateTaskCache(step.id, resolved);
                        }
                      } catch (err) {
                        setError(err instanceof Error ? err.message : 'Marker 文件上传失败');
                      } finally {
                        setMarkerUploading(false);
                      }
                    }} />

                    {/* 上传中提示 */}
                    {markerUploading && (
                      <p className="text-[11px] mt-1 animate-pulse" style={{ color: "var(--clr-amber)" }}>
                        正在上传并解析 Marker 文件，请稍候...
                      </p>
                    )}

                    {/* 已上传文件名 + 删除按钮 */}
                    {markerFile && (
                      <div className="flex items-center gap-2 mt-1">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#2D8A56" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                        <span className="flex-1 truncate text-[11px]" style={{ color: "var(--clr-text-muted)" }}>{markerFile.name}</span>
                        <button
                          type="button"
                          onClick={() => {
                            setMarkerFile(null);
                            updateParam('cell_type', '');
                            updateParam('marker_file_path', '');
                          }}
                          title="移除文件"
                          className="p-1 rounded hover:bg-red-50 transition-colors shrink-0"
                          style={{ color: "var(--clr-danger)" }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                        </button>
                      </div>
                    )}

                    <a
                      href="/api/tasks/example-marker"
                      download="example.marker.txt"
                      className="text-[10px] mt-1 inline-block underline"
                      style={{ color: 'var(--clr-amber-dark)' }}
                    >
                      下载示例 marker.txt
                    </a>
                  </div>

                  {/* 细胞类型选择 */}
                  <div>
                    <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>细胞类型</label>
                    {markerFile && markerFile.cellTypes.length > 0 ? (
                      <select
                        value={stepParams.cell_type as string}
                        onChange={(e) => updateParam('cell_type', e.target.value)}
                        className={selectCls} style={selectStyle}
                      >
                        {markerFile.cellTypes.map(ct => (
                          <option key={ct} value={ct}>{ct}</option>
                        ))}
                      </select>
                    ) : (
                      <div
                        className="text-xs px-2 py-1.5 rounded border"
                        style={{
                          borderColor: "var(--clr-border)",
                          color: "var(--clr-text-faint)",
                          background: "var(--clr-bg-alt)",
                        }}
                      >
                        {markerUploading ? "解析中..." : "请先上传 Marker 基因文件以加载细胞类型列表"}
                      </div>
                    )}
                  </div>
                </>
              )}

              {step.id === "annotate" && (
                <>
                  {/* 物种 + 组织选择 */}
                  <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
                    <div>
                      <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>物种</label>
                      <div className="flex items-center gap-2">
                        <select
                          value={stepParams.species as string}
                          onChange={(e) => updateParam("species", e.target.value)}
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
                            updateParam("species", detected);
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
                        value={stepParams.tissue as string}
                        onChange={(e) => updateParam("tissue", e.target.value)}
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
                  <div>
                    <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>注释方式</label>
                    <div className="flex gap-4">
                      {["自动注释", "手动注释"].map((v) => (
                        <label key={v} className="flex items-center gap-1 text-sm cursor-pointer" style={{ color: "var(--clr-text)" }}>
                          <input type="radio" name="anno_type" value={v} checked={stepParams.anno_type === v} onChange={() => { updateParam("anno_type", v); if (v === "自动注释") setAnnoFile(null); }} className="accent-[#C86019]" /> {v}
                        </label>
                      ))}
                    </div>
                  </div>
                  {/* 手动注释文件上传 */}
                  {stepParams.anno_type === "手动注释" && (
                    <div className="flex items-center gap-3 p-3 rounded-lg" style={{ background: "rgba(200,96,25,0.04)", border: "2px dashed rgba(200,96,25,0.3)" }}>
                      <div className="flex-1">
                        <p className="text-xs font-semibold" style={{ color: "var(--clr-amber-dark)" }}>上传注释文件</p>
                        <p className="text-[11px] mt-0.5" style={{ color: "var(--clr-text-muted)" }}>
                          CSV/TSV，列名: cluster_id, celltype, markers（gene1|gene2|...）
                        </p>
                      </div>
                      <label className="px-4 py-2 rounded-lg text-xs font-bold text-white cursor-pointer transition-all hover:opacity-90" style={{ background: "linear-gradient(135deg, var(--clr-amber-dark), var(--clr-amber))", boxShadow: "0 2px 8px rgba(200,96,25,0.2)" }}>
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
                            if (cidIdx < 0) throw new Error("缺少 cluster_id 列");
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
                        <button type="button" onClick={() => setAnnoFile(null)} className="text-xs px-2 py-1 rounded hover:bg-red-50" style={{ color: "var(--clr-text-faint)" }}>✕</button>
                      )}
                    </div>
                  )}
                  <a href="/api/tasks/example-cell-anno" download="example.cellAnno.txt" className="text-[10px] mt-1 inline-block underline" style={{ color: "var(--clr-amber-dark)" }}>
                    下载示例注释文件 (example.cellAnno.txt)
                  </a>
                  <div>
                    <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>分组方式</label>
                    <select value={stepParams.group_by as string} onChange={(e) => updateParam("group_by", e.target.value)} className={selectCls} style={selectStyle}>
                      <option value="Sample">Sample</option><option value="Group">Group</option><option value="CellType">CellType</option>
                    </select>
                  </div>
                </>
              )}

              {error && <div className="callout callout-danger text-xs">{error}</div>}

              {/* 前置步骤依赖检查 */}
              {(() => {
                const PREREQS: Record<string, { stepId: string; label: string }> = {
                  normalize: { stepId: "qc", label: "数据预处理" },
                  reduce: { stepId: "normalize", label: "数据标准化" },
                  cluster: { stepId: "reduce", label: "数据降维" },
                  markers: { stepId: "cluster", label: "批次聚类" },
                  enrich: { stepId: "markers", label: "差异基因" },
                  marker_expr: { stepId: "cluster", label: "批次聚类" },
                  annotate: { stepId: "cluster", label: "批次聚类" },
                };
                const prereq = PREREQS[step.id];
                const prereqMissing = prereq && taskCache[prereq.stepId]?.status !== "completed";

                const isDisabled = submitting || !project || (step.id === "qc" && uploadedFiles.length === 0) || (step.id === "marker_expr" && !markerFile) || prereqMissing;

                return (
                  <>
                    {/* 图片格式选择 */}
                    <div className="flex items-center gap-2 px-3 py-2 rounded text-xs mb-3" style={{ background: "rgba(200,96,25,0.04)", border: "1px solid rgba(200,96,25,0.15)" }}>
                      <span style={{ color: "var(--clr-text-muted)" }}>图片格式:</span>
                      <select value={stepParams.plot_format as string || "png"} onChange={(e) => updateParam("plot_format", e.target.value)} style={{ border: "1px solid var(--clr-border)", borderRadius: 4, padding: "2px 6px", fontSize: 12, background: "white", color: "var(--clr-text)" }}>
                        <option value="png">PNG (默认)</option>
                        <option value="pdf">PDF</option>
                      </select>
                      <span style={{ color: "var(--clr-text-faint)", fontSize: 10 }}>不选默认PNG</span>
                    </div>
                    <button
                      onClick={handleSubmit}
                      disabled={isDisabled}
                      className="w-full py-2.5 text-white font-semibold rounded text-sm transition-all duration-300 shadow-md flex items-center justify-center gap-2 disabled:opacity-50"
                      style={{ background: isDisabled ? "var(--clr-dark-light)" : "var(--clr-amber)" }}
                    >
                      {submitting ? (
                        <><svg className="w-4 h-4" viewBox="0 0 24 24" style={{ animation: "spin 1s linear infinite" }}><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg> 提交中...</>
                      ) : (
                        <>▶ 执行{step.label}</>
                      )}
                    </button>

                    {!project && <p className="text-[10px] text-center" style={{ color: "var(--clr-text-faint)" }}>请先在顶部选择一个项目</p>}
                    {project && step.id === "qc" && uploadedFiles.length === 0 && <p className="text-[10px] text-center" style={{ color: "var(--clr-warn)" }}>请先上传 .rds 数据文件</p>}
                    {step.id === "marker_expr" && !markerFile && <p className="text-[10px] text-center" style={{ color: "var(--clr-warn)" }}>请先上传 Marker 基因文件</p>}
                    {prereqMissing && <p className="text-[10px] text-center" style={{ color: "var(--clr-warn)" }}>⚠ 请先完成「{prereq.label}」步骤</p>}
                  </>
                );
              })()}
            </div>
          </div>

          {/* Results Panel — 动态扩展 */}
          <div style={{ flex: 1, minWidth: 0, transition: 'flex 0.45s cubic-bezier(0.4,0,0.2,1)' }}>
            <div className="card p-6 min-h-[500px]" style={{ overflow: 'hidden' }}>
              <div className="section-header mb-4" style={{ paddingBottom: "10px" }}>
                <div className="section-num">{step.num}</div>
                <div className="flex-1 flex items-center justify-between">
                  <div className="section-title">{step.label} — 结果</div>
                  {/* 完成胶囊标志 */}
                  {currentTask?.status === 'completed' && (
                    <span
                      className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium"
                      style={{ background: '#E6F6ED', color: '#2D8A56', border: '1px solid #C3E6D1' }}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
                      完成
                      {currentTask.completed_at && (
                        <span style={{ color: '#5BAD82', fontFamily: 'var(--font-mono)', fontSize: '10px' }}>
                          {new Date(currentTask.completed_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                      )}
                    </span>
                  )}
                  {currentTask?.status === 'failed' && (
                    <span
                      className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium"
                      style={{ background: '#FFF3F3', color: '#B85450', border: '1px solid #F5C6C6' }}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                      失败
                    </span>
                  )}
                </div>
              </div>

              {currentTaskId && currentTask?.status !== 'completed' && currentTask?.status !== 'failed' && (
                <div className="mb-6">
                  <ProgressTracker taskId={currentTaskId} stepLabel={step.label} onComplete={handleTaskComplete} onError={handleTaskError} />
                  <div className="mt-3 w-full rounded-lg border px-4 py-3" style={{ borderColor: "#fcd34d", background: "rgba(251,191,36,0.08)" }}>
                    <div className="flex items-start gap-3">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round" className="shrink-0 mt-0.5"><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></svg>
                      <span className="text-xs" style={{ color: "#92400e" }}>
                        任务正在后台运行，刷新页面不会中断分析。完成后可在此查看结果并下载。
                      </span>
                    </div>
                  </div>
                </div>
              )}

              <ResultViewer task={currentTask} stepId={step.id} stepLabel={step.label} StepIcon={step.Icon} taskCache={taskCache} clusterLevels={clusterLevels} projectName={project?.name} />

              {/* 底部导航 — 仅在当前步骤有任务时显示 */}
              {hasTaskForStep && (
                <div className="mt-6 pt-4 flex items-center justify-between" style={{ borderTop: '1px solid var(--clr-border)' }}>
                  <button
                    onClick={() => clearTaskCache(step.id)}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm rounded transition-all duration-200 hover:shadow-sm"
                    style={{ color: 'var(--clr-amber-dark)', border: '1px solid var(--clr-border)', background: 'rgba(200,96,25,0.04)' }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                    返回参数设置
                  </button>

                  {activeStep < STEPS.length - 1 && currentTask?.status === 'completed' && (
                    <button
                      onClick={() => {
                        navigateToStep(activeStep + 1);
                      }}
                      className="flex items-center gap-1.5 px-5 py-2.5 text-sm font-semibold text-white rounded transition-all duration-200 hover:shadow-md"
                      style={{ background: 'var(--clr-amber)' }}
                    >
                      下一步: {STEPS[activeStep + 1].label}
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

export default function AnalysisPage() {
  return (
    <Suspense fallback={<div className="p-8" style={{ color: "var(--clr-text-muted)" }}>加载中...</div>}>
      <AnalysisPageContent />
    </Suspense>
  );
}
