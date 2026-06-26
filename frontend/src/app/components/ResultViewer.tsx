/**
 * scCloud v2 — 分析结果可视化组件
 * 实时从后端 API (/api/tasks/{id}/result) 获取真实数据并渲染。
 * 各步骤均使用 R 引擎运算后返回的结构化 JSON，不再依赖 Demo 数据。
 *
 * 懒加载策略：
 *  - qc       → QCResultTabs 自管理（文字统计，无大图）
 *  - normalize → 自动加载（只有统计数字，无大图表，无需按钮）
 *  - 其他     → 用户点击"加载可视化结果"后再 fetch（防止大数据崩溃）
 */
"use client";

import React, { Component, type ComponentType, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { type Task, submitTask, getTask, apiFetch, tryRefresh, getAuthToken} from "../lib/api";
import ProgressTracker from "./ProgressTracker";

import QCResultTabs from "./QCResultTabs";
import MultiSelectDropdown from "./MultiSelectDropdown";
import GeneAutocomplete from "./GeneAutocomplete";
import AnnotateResult from "./AnnotateResult";
import {
  ScatterPlot,
  DeckScatterPlot,
  ViolinPlot,
  EnrichBubble,
  type ScatterData,
  type EnrichData,
  VolcanoPlot,
  type VolcanoPoint,
} from "./charts";

/* ===== Error Boundary — 防止图表报错崩溃整页 ===== */

interface EBState { hasError: boolean; message: string }
class ResultErrorBoundary extends Component<{ children: ReactNode }, EBState> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, message: "" };
  }
  static getDerivedStateFromError(err: Error) {
    return { hasError: true, message: err?.message ?? "未知错误" };
  }
  componentDidCatch() { /* 可接入 Sentry */ }
  render() {
    if (this.state.hasError) {
      return (
        <div className="callout callout-danger text-xs p-4 space-y-1">
          <p className="font-semibold">⚠ 可视化渲染出错</p>
          <p style={{ fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{this.state.message}</p>
          <button
            className="mt-2 px-3 py-1 text-xs rounded text-white"
            style={{ background: "var(--clr-amber)" }}
            onClick={() => this.setState({ hasError: false, message: "" })}
          >重新加载</button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** 安全提取散点数据（兼容 R 返回的大小写 x/X，以及 jsonlite 数组格式） */
function safeScatter(raw: unknown): ScatterData | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const x = (r.x ?? r.X) as number[] | undefined;
  const y = (r.y ?? r.Y) as number[] | undefined;
  const cluster = (r.cluster ?? r.Cluster ?? r.label) as string[] | undefined;
  if (!Array.isArray(x) || !Array.isArray(y)) return undefined;
  const result: ScatterData = { x, y, cluster: Array.isArray(cluster) ? cluster : x.map(() => "0") };
  if (Array.isArray(r.celltype)) result.celltype = r.celltype as string[];
  if (Array.isArray(r.sample)) result.sample = r.sample as string[];
  if (Array.isArray(r.group)) result.group = r.group as string[];
  return result;
}

/**
 * 安全提取字符串字段 —— R jsonlite 可能把单元素向量序列化为 ["path"] 数组。
 * 统一取第一个元素或直接返回字符串。
 */
function safeString(val: unknown): string | undefined {
  if (typeof val === "string") return val;
  if (Array.isArray(val) && typeof val[0] === "string") return val[0] as string;
  return undefined;
}

/** 随机降采样散点数据到 maxN 个点，防止大数据集导致渲染崩溃 */
function downsampleScatter(data: ScatterData, maxN = 3000): ScatterData {
  if (data.x.length <= maxN) return data;
  const step = Math.ceil(data.x.length / maxN);
  const x: number[] = [];
  const y: number[] = [];
  const cluster: string[] = [];
  const celltype: string[] = [];
  const sample: string[] = [];
  const group: string[] = [];
  for (let i = 0; i < data.x.length; i += step) {
    x.push(data.x[i]);
    y.push(data.y[i]);
    cluster.push(data.cluster[i]);
    if (data.celltype) celltype.push(data.celltype[i]);
    if (data.sample) sample.push(data.sample[i]);
    if (data.group) group.push(data.group[i]);
  }
  const result: ScatterData = { x, y, cluster };
  if (data.celltype) result.celltype = celltype;
  if (data.sample) result.sample = sample;
  if (data.group) result.group = group;
  return result;
}

/**
 * 带 Bearer token 认证的图片组件。
 * 浏览器 <img> 标签无法传 Authorization header，
 * 改用 fetch 拉取 blob 后转为对象 URL 注入 <img>。
 */
function AuthImg({ src, alt, className, style }: {
  src: string | null;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failed, setFailed]   = useState(false);
  const [isPdf, setIsPdf] = useState(false);

  useEffect(() => {
    if (!src) return;
    let objectUrl = "";
    setFailed(false);
    setBlobUrl(null);
    fetchWithAuth(src)
      .then((r) => { if (!r.ok) throw new Error(`${r.status}`); const ct = r.headers.get("content-type") || ""; return r.blob().then(blob => ({ blob, isPdf: ct.includes("pdf") })); })
      .then(({ blob, isPdf: pdf }) => { objectUrl = URL.createObjectURL(blob); setBlobUrl(objectUrl); setIsPdf(pdf); })
      .catch(() => setFailed(true));
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [src]);

  if (!src || failed) return <div className="callout text-xs py-6 text-center" style={{ color: "var(--clr-text-faint)" }}>图片暂不可用（请重新运行该步骤）</div>;
  if (!blobUrl) return <div className="flex justify-center py-8"><div className="w-5 h-5 border-2 rounded-full border-t-transparent animate-spin" style={{ borderColor: "var(--clr-amber)", borderTopColor: "transparent" }} /></div>;
  if (isPdf) {
    return <embed src={blobUrl} type="application/pdf" className={className} style={{ ...style, width: "100%", minHeight: 600 }} />;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={blobUrl} alt={alt} className={className} style={style} />;
}

/** 
 * 带 Bearer token 的文件下载按钮组件。
 */
function AuthDownloadLink({ url, filename, className, style, children }: { url: string, filename: string, className?: string, style?: React.CSSProperties, children: React.ReactNode }) {
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (downloading) return;
    setDownloading(true);
    try {
      const res = await fetchWithAuth(url);
      if (!res.ok) throw new Error("下载失败");
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      alert("文件获取失败，可能是不存在或已经过期");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <button onClick={handleDownload} disabled={downloading} className={className} style={style}>
      {downloading ? <span className="opacity-70 flex items-center gap-1"><span className="w-3 h-3 border-2 border-t-transparent rounded-full animate-spin"></span> 下载中...</span> : children}
    </button>
  );
}

interface ResultViewerProps {
  task: Task | null;
  stepId: string;
  stepLabel: string;
  StepIcon: ComponentType<{ className?: string; size?: number }>;
  taskCache?: Record<string, Task>;
  clusterLevels?: string[];
  projectName?: string;
}

/** 从 localStorage 读取 token */
function getToken(): string {
  if (typeof window === "undefined") return "";
  return getAuthToken() || "";
}

/**
 * 带 401 自动续期的 fetch 封装（用于 blob/非 JSON 响应）。
 * apiFetch 只处理 JSON，图片/blob 下载需要单独处理。
 */
async function fetchWithAuth(url: string, init?: RequestInit): Promise<Response> {
  const token = getToken();
  const headers = { ...(init?.headers as Record<string, string>), Authorization: `Bearer ${token}` };
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) {
    // 先尝试 refresh token 续期
    const newToken = await tryRefresh();
    if (newToken) {
      const retry = await fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), Authorization: `Bearer ${newToken}` } });
      if (retry.ok) return retry;
    }
    // refresh 失败（guest token 过期等），重新 guest 登录
    try {
      const guestRes = await fetch("/api/auth/guest", { method: "POST" });
      if (guestRes.ok) {
        const data = await guestRes.json();
        sessionStorage.setItem("access_token", data.access_token);
        if (data.refresh_token) sessionStorage.setItem("refresh_token", data.refresh_token);
        if (data.username) sessionStorage.setItem("username", data.username);
        const retry2 = await fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), Authorization: `Bearer ${data.access_token}` } });
        if (retry2.ok) return retry2;
      }
    } catch { /* ignore */ }
  }
  return res;
}

/** 获取任务结果 JSON — 使用 apiFetch 自动处理 401 token 续期 */
async function fetchTaskResult(taskId: string): Promise<Record<string, unknown> | null> {
  try {
    return await apiFetch<Record<string, unknown>>(`/api/tasks/${taskId}/result`);
  } catch {
    return null;
  }
}

// 由于 WebGL 重构提升了性能，现在所有有步骤均自动加载结果数据
// 不再需要显式点击加载图表按钮。

// 切走再切回来时, 这些"按需子任务"(亚类提取 / 单簇特征分布图 / 双簇对比表)的结果只存在本地
// state, 组件卸载即丢。下面两个辅助函数 + 既有的 fetchTaskResult 用于挂载时从后端恢复:
//   listCompletedTasks 一次拉全部已完成任务(每个组件只请求一次), latestOfStep 客户端挑最近一条。
async function listCompletedTasks(projectId: number): Promise<Task[]> {
  try {
    const list = await apiFetch<{ tasks: Task[] }>(
      `/api/tasks?project_id=${projectId}&status=completed`,
    );
    return list.tasks || [];
  } catch (e) {
    console.warn("[ResultViewer] 拉取已完成任务列表失败, 跳过结果恢复:", e);
    return [];
  }
}

function latestOfStep(tasks: Task[], step: string): Task | undefined {
  return tasks
    .filter((t) => t.step === step)
    .sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )[0];
}

// 把后端存的逗号分隔/数组形式的簇参数还原成字符串数组(用于恢复选择项)
function paramToList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "number" && !Number.isNaN(v)) return [String(v)];
  if (typeof v === "string" && v) return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

export default function ResultViewer({ task, stepId, stepLabel, StepIcon, taskCache, clusterLevels, projectName }: ResultViewerProps) {
  const [resultData, setResultData] = useState<Record<string, unknown> | null>(null);
  const [loadingResult, setLoadingResult] = useState(false);
  // 自动加载：任务完成后触发
  const [resultRequested, setResultRequested] = useState(false);

  useEffect(() => {
    // task 变化时重置（切换步骤 / 新任务提交时清空）
    setResultData(null);
    setResultRequested(false);
  }, [task?.id]);

  // 所有完成的任务自动加载结果数据
  useEffect(() => {
    if (task?.status === "completed") {
      setResultRequested(true);
    }
  }, [task?.id, task?.status]);

  useEffect(() => {
    if (!resultRequested) return;
    if (!task || task.status !== "completed") return;
    // QC 步骤由 QCResultTabs 自行管理
    if (stepId === "qc") return;
    setLoadingResult(true);
    fetchTaskResult(task.id).then((data) => {
      setResultData(data);
      setLoadingResult(false);
    });
  }, [resultRequested, task?.id, task?.status, stepId]);

  /* ── 没有任务 ── */
  if (!task) {
    return (
      <div className="flex flex-col items-center justify-center py-20" style={{ color: "var(--clr-text-faint)" }}>
        <StepIcon size={48} className="mb-4 opacity-20" />
        <p className="text-sm">选择参数并点击执行按钮开始分析</p>
        <p className="text-xs mt-2" style={{ color: "var(--clr-border)" }}>结果将显示在此区域</p>
      </div>
    );
  }

  /* ── 任务进行中 ── */
  if (task.status === "pending" || task.status === "running") {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <div className="relative w-16 h-16 mb-6">
          <div className="absolute inset-0 border-2 rounded-full" style={{ borderColor: "var(--clr-border)" }} />
          <div
            className="absolute inset-0 border-2 rounded-full border-t-transparent"
            style={{ borderColor: "var(--clr-amber)", borderTopColor: "transparent", animation: "spin 1s linear infinite" }}
          />
        </div>
        <p className="text-sm font-medium" style={{ color: "var(--clr-amber)" }}>正在执行 {stepLabel}...</p>
        <p className="text-xs mt-2" style={{ color: "var(--clr-text-faint)" }}>{task.progress > 0 ? (task.progress_message || `进度: ${task.progress}%`) : "初始化中..."}</p>
      </div>
    );
  }

  /* ── 任务失败 ── */
  if (task.status === "failed") {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <div className="w-12 h-12 mb-4 rounded-full flex items-center justify-center" style={{ background: "#FFF3F3", color: "var(--clr-danger)" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </div>
        <p className="text-sm font-medium mb-2" style={{ color: "var(--clr-danger)" }}>分析失败</p>
        <div className="max-w-md text-center">
          <div className="callout callout-danger text-xs font-mono break-all">{task.error_msg || "未知错误"}</div>
        </div>
        <p className="text-xs mt-4" style={{ color: "var(--clr-text-faint)" }}>请检查参数后重试</p>
      </div>
    );
  }

  /* ── 任务完成 ── */
  const needsResultData = !["qc"].includes(stepId);

  return (
    <ResultErrorBoundary>
      <div className="space-y-4 animate-fade-in">

        {/* QC 步骤直接渲染 tabs，不需要懒加载按钮 */}
        {stepId === "qc" && (
          <QCResultTabs taskId={task.id} token={getToken()} />
        )}

        {needsResultData && resultRequested && loadingResult && (
          <div className="flex items-center gap-2 py-12 justify-center" style={{ color: "var(--clr-text-faint)" }}>
            <div className="w-4 h-4 border-2 rounded-full border-t-transparent animate-spin" style={{ borderColor: "var(--clr-amber)", borderTopColor: "transparent" }} />
            <span className="text-xs">加载可视化数据...</span>
          </div>
        )}

        {/* ── 非 QC 步骤：数据加载后渲染 ── */}
        {needsResultData && resultRequested && !loadingResult && (
          <>
            {stepId === "normalize" && resultData && <NormalizeResult data={resultData} taskId={task.id} />}
            {stepId === "reduce"    && <ReduceResult data={resultData} taskId={task.id} />}
            {stepId === "cluster"   && <ClusterResult data={resultData} task={task} />}
            {stepId === "markers"   && <MarkersResult data={resultData} task={task} taskCache={taskCache} clusterLevels={clusterLevels} projectName={projectName} />}
            {stepId === "enrich"    && <EnrichResult data={resultData} taskId={task.id} />}
            {stepId === "wgcna"     && <WGCNAResult data={resultData} taskId={task.id} />}
            {stepId === "annotate" && <AnnotateResult data={resultData} task={task} token={getToken()} />}
            {stepId === "marker_expr" && <MarkerExprResult data={resultData} taskId={task.id} task={task} />}
            {!["qc","normalize","reduce","cluster","markers","enrich","wgcna","annotate","marker_expr"].includes(stepId) && (
              <GenericStepResult data={resultData} stepId={stepId} taskId={task.id} task={task} />
            )}
          </>
        )}
      </div>
    </ResultErrorBoundary>
  );
}

/* ===================================================
   各步骤专属结果子组件
=================================================== */

/** 标准化结果 */
function NormalizeResult({ data, taskId }: { data: Record<string, unknown>; taskId?: string }) {
  const stats = data.stats as { cells?: number; genes?: number; assays?: string[] } | undefined;
  const resultPath = safeString(data.result_path);
  const resultFileName = resultPath ? resultPath.split("/").pop() : null;

  // meta.data 表格（前 100 行样本）
  const metaSample = data.meta_data_sample as Record<string, unknown>[] | undefined;
  const metaTotalRows = (data.meta_data_total_rows as number) ?? 0;
  const [metaPage, setMetaPage] = useState(0);
  const metaPageSize = 10;
  const metaCols = metaSample && metaSample.length > 0 ? Object.keys(metaSample[0]) : [];
  const metaPageData = metaSample ? metaSample.slice(metaPage * metaPageSize, (metaPage + 1) * metaPageSize) : [];
  const metaTotalPages = metaSample ? Math.ceil(metaSample.length / metaPageSize) : 0;

  // 下载辅助
  const handleDownload = async () => {
    if (!resultFileName || !taskId) return;
    const url = `/api/tasks/${taskId}/plot?name=${encodeURIComponent(resultFileName)}`;
    try {
      const res = await fetchWithAuth(url);
      if (!res.ok) throw new Error(`${res.status}`);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = resultFileName;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch { /* 静默失败 */ }
  };

  return (
    <div className="space-y-4">
      {/* 说明横幅 + 下载 RDS 图标 */}
      <div className="callout text-xs" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
        <span>SCTransform 标准化完成，细胞数 {stats?.cells?.toLocaleString() ?? "—"}，Assays: {(stats?.assays ?? []).join(", ") || "—"}。</span>
        {resultFileName && (
          <button
            style={{ background: "none", border: "none", cursor: "pointer", padding: "4px", flexShrink: 0, color: "var(--clr-amber)", transition: "color 0.2s" }}
            onClick={handleDownload}
            title={`下载 ${resultFileName}`}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--clr-amber-dark)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--clr-amber)")}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
        )}
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "细胞数", value: stats?.cells?.toLocaleString() ?? "—" },
          { label: "基因数", value: stats?.genes?.toLocaleString() ?? "—" },
          { label: "Assays", value: (stats?.assays ?? []).join(", ") || "—" },
        ].map((item) => (
          <div key={item.label} className="p-3 rounded text-center" style={{ background: "var(--clr-bg-alt)", border: "1px solid var(--clr-border)" }}>
            <p className="text-lg font-bold" style={{ color: "var(--clr-amber)" }}>{item.value}</p>
            <p className="text-xs mt-1" style={{ color: "var(--clr-text-faint)" }}>{item.label}</p>
          </div>
        ))}
      </div>

      {/* meta.data 表格 —— 限制宽度防止撑破布局 */}
      {metaSample && metaSample.length > 0 && (
        <div className="space-y-2">
          <div className="card-label">
            meta.data 预览
            <span className="font-normal ml-1" style={{ color: "var(--clr-text-faint)" }}>
              — 显示前 {Math.min(metaSample.length, 100)} / {metaTotalRows.toLocaleString()} 行
            </span>
          </div>
          <div className="table-wrap" style={{ maxWidth: "100%", overflowX: "auto" }}>
            <table style={{ fontSize: "0.7rem" }}>
              <thead>
                <tr>{metaCols.map(c => <th key={c} style={{ whiteSpace: "nowrap" }}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {metaPageData.map((row, i) => (
                  <tr key={i}>
                    {metaCols.map(c => (
                      <td key={c} style={{
                        whiteSpace: "nowrap",
                        maxWidth: "180px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        ...(c === "barcode" ? { fontFamily: "var(--font-mono)", color: "var(--clr-amber-dark)" } : {}),
                      }}>
                        {String(row[c] ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* 分页控件 */}
          {metaTotalPages > 1 && (
            <div className="flex items-center justify-center gap-2 text-xs" style={{ color: "var(--clr-text-muted)" }}>
              <button
                disabled={metaPage === 0}
                onClick={() => setMetaPage(p => p - 1)}
                className="px-2 py-1 rounded"
                style={{ border: "1px solid var(--clr-border)", opacity: metaPage === 0 ? 0.4 : 1 }}
              >
                ‹ 上一页
              </button>
              <span>{metaPage + 1} / {metaTotalPages}</span>
              <button
                disabled={metaPage >= metaTotalPages - 1}
                onClick={() => setMetaPage(p => p + 1)}
                className="px-2 py-1 rounded"
                style={{ border: "1px solid var(--clr-border)", opacity: metaPage >= metaTotalPages - 1 ? 0.4 : 1 }}
              >
                下一页 ›
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 降维结果 — deck.gl 交互式散点图（主），R PNG 可下载 */
function ReduceResult({ data, taskId }: { data: Record<string, unknown> | null; taskId?: string }) {
  const stats   = data?.stats as { method?: string; cells?: number; n_dims?: number } | undefined;
  const method  = (safeString(stats?.method) ?? "UMAP").toUpperCase();

  // R 原版 PNG 预览；下载用用户选择的格式
  const plotPath    = safeString(data?.plot_path);
  const plotDownloadPath = safeString(data?.plot_download_path);
  const plotFileName = plotPath ? plotPath.split("/").pop() : null;
  const plotDownloadFileName = plotDownloadPath ? plotDownloadPath.split("/").pop() : plotFileName;
  const plotSrc     = plotFileName && taskId
    ? `/api/tasks/${taskId}/plot?name=${encodeURIComponent(plotFileName)}`
    : null;
  const plotDownloadSrc = plotDownloadFileName && taskId
    ? `/api/tasks/${taskId}/plot?name=${encodeURIComponent(plotDownloadFileName)}`
    : null;

  // deck.gl 交互式散点图数据（主展示）
  const rawScatter = useMemo(() => safeScatter(data?.scatter_data), [data]);

  return (
    <div className="space-y-3">
      {/* 统计信息 */}
      {stats && (
        <div className="flex flex-wrap gap-4 text-xs" style={{ color: "var(--clr-text-faint)" }}>
          <span>方法：<strong style={{ color: "var(--clr-amber)" }}>{method}</strong></span>
          <span>细胞数：<strong style={{ color: "var(--clr-text)" }}>{stats.cells?.toLocaleString()}</strong></span>
          {stats.n_dims && <span>PCA 维数：<strong style={{ color: "var(--clr-text)" }}>{stats.n_dims}</strong></span>}
        </div>
      )}
      {/* deck.gl 交互式散点图（主展示） */}
      {rawScatter ? (
        <div className="space-y-1">
          <p className="text-xs font-medium" style={{ color: "var(--clr-amber-dark)" }}>
            {method} 可视化
          </p>
          <DeckScatterPlot data={rawScatter} method={method as "UMAP" | "tSNE" | "PCA"} height={520}>
            {plotDownloadSrc && (
              <AuthDownloadLink
                url={plotDownloadSrc}
                filename={plotDownloadFileName || "reduce_plot.png"}
                title="下载 R 原版高清图"
                className="absolute bottom-2 right-2 z-10 inline-flex items-center justify-center w-9 h-9 rounded-lg transition-all hover:scale-110"
                style={{ background: "rgba(255,255,255,0.92)", boxShadow: "0 2px 8px rgba(0,0,0,0.10)", color: "var(--clr-amber)" }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </AuthDownloadLink>
            )}
          </DeckScatterPlot>
        </div>
      ) : plotSrc ? (
        <div className="space-y-1">
          <p className="text-xs font-medium" style={{ color: "var(--clr-amber-dark)" }}>
            {method} 可视化
            <span className="font-normal ml-1" style={{ color: "var(--clr-text-faint)" }}>— R ggplot2 原版输出</span>
          </p>
          <div className="relative w-full">
            <AuthImg
              src={plotSrc}
              alt={`${method} reduction plot`}
              className="w-full rounded border"
              style={{ border: "1px solid var(--clr-border)", background: "#fff" }}
            />
            <AuthDownloadLink
              url={plotDownloadSrc || plotSrc}
              filename={plotDownloadFileName || plotFileName || "reduce_plot.png"}
              className="absolute bottom-3 right-3 inline-flex items-center justify-center w-9 h-9 rounded-lg transition-all hover:scale-110"
              style={{ background: "rgba(255,255,255,0.92)", boxShadow: "0 2px 8px rgba(0,0,0,0.10)", color: "var(--clr-amber)" }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </AuthDownloadLink>
          </div>
        </div>
      ) : (
        <div className="callout text-xs">降维完成，但坐标数据暂未返回</div>
      )}
    </div>
  );
}

/** 聚类结果 — 完整展示原版 R 脚本所有输出 */
function ClusterResult({ data, task }: { data: Record<string, unknown> | null; task: Task }) {
  const taskId = task.id;
  // ── 统计 ──
  const stats = data?.stats as { clusters?: number; cluster_levels?: string[]; cells?: number } | undefined;

  // ── 图片 URL 构建（从 API 响应中动态提取文件名） ──
  // plot_path* 为 PNG 预览；plot_download_path* 为用户选择格式的下载文件
  const mkSrc = (name: string) => taskId ? `/api/tasks/${taskId}/plot?name=${encodeURIComponent(name)}` : null;
  const extractName = (val: unknown) => { const s = safeString(val); return s ? s.split("/").pop()! : null; };
  const umapName   = extractName(data?.plot_path)  ?? "plot_cluster.png";
  const sankeyName = extractName(data?.plot_path2) ?? "plot_cluster_sankey.png";
  const groupName  = extractName(data?.plot_path3) ?? "plot_cluster_group.png";
  const umapDownloadName   = extractName(data?.plot_download_path)  ?? umapName;
  const sankeyDownloadName = extractName(data?.plot_download_path2) ?? sankeyName;
  const groupDownloadName  = extractName(data?.plot_download_path3) ?? groupName;
  // meta.data 下载名对齐其它输出文件: 取聚类输出名里的 <项目名>_cluster_<时间戳>_ 前缀
  // (后端命名规则 <项目>_<步骤>_<时间戳>_<内容>.<后缀>), 拼成 ..._meta_data.csv; 取不到则退回通用名
  const metaCsvName = (() => {
    const m = umapName.match(/^(.*_\d{14}_)/);
    return m ? `${m[1]}meta_data.csv` : "meta_data.csv";
  })();
  const umapSrc   = mkSrc(umapName);         // my_distPlot5: Cluster UMAP
  const sankeySrc = mkSrc(sankeyName);       // my_distPlot4: 样本 Cluster 占比图
  const groupSrc  = mkSrc(groupName);        // my_distPlot6: 分组 UMAP
  const umapDownloadSrc   = mkSrc(umapDownloadName);
  const sankeyDownloadSrc = mkSrc(sankeyDownloadName);
  const groupDownloadSrc  = mkSrc(groupDownloadName);

  // ── 表格数据 ──
  type FreqRow = { Cluster?: string; Sample?: string; CellNumber?: number; Freq?: number };
  const clusterNum = (data?.cluster_num ?? []) as FreqRow[];
  const freqTable  = (data?.freq_table   ?? []) as FreqRow[];

  // meta.data 表格
  const metaSample = data?.meta_data_sample as Record<string, unknown>[] | undefined;
  const metaTotalRows = (data?.meta_data_total_rows as number) ?? 0;
  const [metaPage, setMetaPage] = useState(0);
  const metaPageSize = 10;
  const metaCols = metaSample && metaSample.length > 0 ? Object.keys(metaSample[0]) : [];
  const metaPageData = metaSample ? metaSample.slice(metaPage * metaPageSize, (metaPage + 1) * metaPageSize) : [];
  const metaTotalPages = metaSample ? Math.ceil(metaSample.length / metaPageSize) : 0;

  // ── 新增分页状态 ──
  const [clusterNumPage, setClusterNumPage] = useState(0);
  const [freqTablePage, setFreqTablePage] = useState(0);
  const clusterPageSize = 8;
  const freqPageSize = 8;
  const clusterNumPageData = clusterNum.slice(clusterNumPage * clusterPageSize, (clusterNumPage + 1) * clusterPageSize);
  const clusterNumTotalPages = Math.ceil(clusterNum.length / clusterPageSize);
  const freqTablePageData = freqTable.slice(freqTablePage * freqPageSize, (freqTablePage + 1) * freqPageSize);
  const freqTableTotalPages = Math.ceil(freqTable.length / freqPageSize);

  // 提取亚类状态
  const [selectedClusters, setSelectedClusters] = useState<string[]>([]);
  const [submittingSubset, setSubmittingSubset] = useState(false);
  const [subsetError, setSubsetError] = useState<string | null>(null);
  const [subsetTask, setSubsetTask] = useState<Task | null>(null);
  // 用户本次挂载内已手动提取过 → 不再用历史结果覆盖(remount 后 ref 重置, 会重新恢复最新一条)
  const subsetTouchedRef = useRef(false);
  // 是否已经执行过一次历史结果恢复
  const subsetRestoredRef = useRef(false);

  // task 切换时重置恢复标记，允许新任务重新评估历史结果
  useEffect(() => {
    subsetRestoredRef.current = false;
  }, [task?.id]);

  // 挂载时恢复上次"细胞亚类提取"结果(切走再切回来不丢)。
  // 该功能只展示一个 RDS 下载链接(由 subsetTask.result_path 驱动), 没有结果数据可视化,
  // 故只需最近一条已完成任务, 不必再取 /result。
  // 为避免把之前项目/前一次运行的结果带到当前 cluster 步骤，仅当历史任务的 clusters
  // 全部存在于当前 cluster_levels 中时才恢复；且不再自动回填选中状态。
  useEffect(() => {
    if (!task?.project_id) return;
    if (subsetRestoredRef.current) return;
    if (!stats?.cluster_levels?.length) return;
    let alive = true;
    listCompletedTasks(task.project_id)
      .then((tasks) => {
        if (!alive || subsetTouchedRef.current || subsetRestoredRef.current) return;
        const t = latestOfStep(tasks, "subset_cluster");
        if (!t) return;
        const cls = paramToList(t.params?.clusters);
        const currentLevels = new Set(stats.cluster_levels);
        if (cls.length && cls.every(c => currentLevels.has(c))) {
          setSubsetTask(t);
        }
        subsetRestoredRef.current = true;
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [task?.project_id, stats?.cluster_levels]);

  // ── deck.gl 交互式散点图数据 ──
  const rawScatter = useMemo(() => safeScatter(data?.scatter_data), [data]);

  // ── Tab 状态 ──
  type TabId = "interactive" | "stats" | "sankey" | "group" | "metadata" | "subtype";
  const [activeTab, setActiveTab] = useState<TabId>("interactive");
  const tabs: { id: TabId; label: string }[] = [
    { id: "interactive", label: "Cluster UMAP图" },
    { id: "stats",   label: "结果统计" },
    { id: "sankey",  label: "样本占比图" },
    { id: "group",   label: "分组 UMAP" },
    { id: "metadata", label: "meta.data" },
    { id: "subtype", label: "细胞亚类提取" },
  ];

  // ── 子标题工具 ──
  const SectionTitle = ({ children }: { children: React.ReactNode }) => (
    <p className="text-xs font-semibold mb-2" style={{ color: "var(--clr-amber-dark)" }}>{children}
      <span className="font-normal ml-1" style={{ color: "var(--clr-text-faint)" }}>— R ggplot2 原版输出</span>
    </p>
  );

  return (
    <div className="space-y-4">
      {/* ── 顶部概览胶囊 ── */}
      {stats && (
        <div className="flex flex-wrap items-center gap-4 text-xs" style={{ color: "var(--clr-text-faint)" }}>
          <span>细胞数：<strong style={{ color: "var(--clr-text)" }}>{stats.cells?.toLocaleString()}</strong></span>
          <span>聚类数：<strong style={{ color: "var(--clr-amber)", fontSize: "1rem" }}>{stats.clusters ?? "—"}</strong></span>
          <span className="break-all">聚类标签：<strong style={{ color: "var(--clr-text)" }}>{(stats.cluster_levels ?? []).join(" · ")}</strong></span>
          {/* 聚类后 RDS 下载 */}
          <AuthDownloadLink
            url={`/api/tasks/${taskId}/plot?name=seurat_clustered.rds`}
            filename={(() => { const rp = safeString(data?.result_path); return rp ? rp.split("/").pop()! : "cluster_harmony.rds"; })()}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium transition-all hover:shadow-sm ml-auto"
            style={{ border: "1px solid var(--clr-border)", color: "var(--clr-amber-dark)", background: "rgba(200,96,25,0.04)" }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            .rds
          </AuthDownloadLink>
        </div>
      )}

      {/* ── Tab 导航 ── */}
      <div className="flex gap-2 flex-wrap">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className="px-3 py-1.5 rounded text-xs font-medium transition-all"
            style={activeTab === t.id
              ? { background: "var(--clr-amber)", color: "#fff", boxShadow: "0 0 8px rgba(200,96,25,0.4)" }
              : { background: "transparent", color: "var(--clr-text-muted)", border: "1px solid var(--clr-border)" }
            }
          >{t.label}</button>
        ))}
      </div>

      {/* ── Tab 0: 交互式 UMAP（deck.gl WebGL） ── */}
      {activeTab === "interactive" && (
        <div className="space-y-1 animate-fade-in">
          {rawScatter ? (
            <>
              <p className="text-xs font-medium" style={{ color: "var(--clr-amber-dark)" }}>
                Cluster UMAP 图
              </p>
              <DeckScatterPlot data={rawScatter} method="UMAP" height={560}>
                {umapDownloadSrc && (
                  <AuthDownloadLink
                    url={umapDownloadSrc}
                    filename={umapDownloadName}
                    title="下载 R 原版高清图"
                    className="absolute bottom-2 right-2 z-10 inline-flex items-center justify-center w-9 h-9 rounded-lg transition-all hover:scale-110"
                    style={{ background: "rgba(255,255,255,0.92)", boxShadow: "0 2px 8px rgba(0,0,0,0.10)", color: "var(--clr-amber)" }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  </AuthDownloadLink>
                )}
              </DeckScatterPlot>
            </>
          ) : umapSrc ? (
            <>
              <p className="text-xs font-medium" style={{ color: "var(--clr-amber-dark)" }}>
                Cluster UMAP 图
                <span className="font-normal ml-1" style={{ color: "var(--clr-text-faint)" }}>— R ggplot2 原版输出</span>
              </p>
              <div className="relative w-full">
                <AuthImg
                  src={umapSrc}
                  alt="Cluster UMAP plot"
                  className="w-full rounded border"
                  style={{ border: "1px solid var(--clr-border)", background: "#fff" }}
                />
                <AuthDownloadLink
                  url={umapDownloadSrc || umapSrc}
                  filename={umapDownloadName || umapName}
                  className="absolute bottom-3 right-3 inline-flex items-center justify-center w-9 h-9 rounded-lg transition-all hover:scale-110"
                  style={{ background: "rgba(255,255,255,0.92)", boxShadow: "0 2px 8px rgba(0,0,0,0.10)", color: "var(--clr-amber)", zIndex: 20 }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                </AuthDownloadLink>
              </div>
            </>
          ) : (
            <div className="callout text-xs">聚类 UMAP 结果未返回</div>
          )}
        </div>
      )}

      {/* ── Tab 1: 结果统计 ── */}
      {activeTab === "stats" && (
        <div className="space-y-5">
          <div className="flex gap-3">
            <button
              onClick={() => {
                if (clusterNum.length === 0) { alert("暂无聚类统计数据"); return; }
                try {
                const hdr = Object.keys(clusterNum[0]).join(",");
                const rows = clusterNum.map((r) => Object.values(r).join(","));
                const csv = [hdr, ...rows].join("\n");
                const rp = data?.result_path;
                const now2 = new Date();
                const ts2 = `${now2.getFullYear()}${String(now2.getMonth()+1).padStart(2,"0")}${String(now2.getDate()).padStart(2,"0")}`;
                const baseName = (typeof rp === "string" ? rp.split("/").pop()?.replace(/\.rds$/, "") : "") || "cluster";
                const name = `${baseName}_cluster_num_${ts2}.csv`;
                const blob = new Blob([csv], {type: "text/csv"});
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = name;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                } catch(e) { alert("下载失败: " + (e instanceof Error ? e.message : String(e))); }
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium transition-all hover:shadow-sm"
              style={{ border: "1px solid var(--clr-border)", color: "var(--clr-amber-dark)", background: "rgba(200,96,25,0.04)" }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              聚类统计 .csv
            </button>
            <button
              onClick={() => {
                if (freqTable.length === 0) { alert("暂无频率表数据"); return; }
                try {
                const hdr = Object.keys(freqTable[0]).join(",");
                const rows = freqTable.map((r) => Object.values(r).join(","));
                const csv = [hdr, ...rows].join("\n");
                const rp = data?.result_path;
                const now3 = new Date();
                const ts3 = `${now3.getFullYear()}${String(now3.getMonth()+1).padStart(2,"0")}${String(now3.getDate()).padStart(2,"0")}`;
                const baseName2 = (typeof rp === "string" ? rp.split("/").pop()?.replace(/\.rds$/, "") : "") || "cluster";
                const name = `${baseName2}_freq_table_${ts3}.csv`;
                const blob = new Blob([csv], {type: "text/csv"});
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = name;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                } catch(e) { alert("下载失败: " + (e instanceof Error ? e.message : String(e))); }
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium transition-all hover:shadow-sm"
              style={{ border: "1px solid var(--clr-border)", color: "var(--clr-amber-dark)", background: "rgba(200,96,25,0.04)" }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              频率表 .csv
            </button>
          </div>
          {/* 样本聚类数目统计 */}
          <div>
            <p className="text-xs font-semibold mb-2" style={{ color: "var(--clr-amber-dark)" }}>样本聚类数目统计
              <span className="font-normal ml-1" style={{ color: "var(--clr-text-faint)" }}>— my_cluster_num1()</span>
            </p>
            {clusterNum.length > 0 ? (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Cluster</th><th>Sample</th><th className="text-right">细胞数</th></tr></thead>
                  <tbody>
                    {clusterNumPageData.map((row, i) => (
                      <tr key={i}>
                        <td className="font-mono font-semibold" style={{ color: "var(--clr-amber-dark)" }}>{row.Cluster}</td>
                        <td>{row.Sample}</td>
                        <td className="text-right">{row.CellNumber?.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="callout text-xs">数目统计数据暂未返回</div>}
            
            {clusterNumTotalPages > 1 && (
              <div className="flex items-center justify-center gap-2 mt-3 text-xs" style={{ color: "var(--clr-text-muted)" }}>
                <button
                  disabled={clusterNumPage === 0}
                  onClick={() => setClusterNumPage(p => p - 1)}
                  className="px-2 py-1 rounded"
                  style={{ border: "1px solid var(--clr-border)", opacity: clusterNumPage === 0 ? 0.4 : 1 }}
                >‹ 上一页</button>
                <span>{clusterNumPage + 1} / {clusterNumTotalPages}</span>
                <button
                  disabled={clusterNumPage >= clusterNumTotalPages - 1}
                  onClick={() => setClusterNumPage(p => p + 1)}
                  className="px-2 py-1 rounded"
                  style={{ border: "1px solid var(--clr-border)", opacity: clusterNumPage >= clusterNumTotalPages - 1 ? 0.4 : 1 }}
                >下一页 ›</button>
              </div>
            )}
          </div>

          {/* 样本聚类频率统计 */}
          <div>
            <p className="text-xs font-semibold mb-2" style={{ color: "var(--clr-amber-dark)" }}>样本聚类频率统计
              <span className="font-normal ml-1" style={{ color: "var(--clr-text-faint)" }}>— my_freqTable()</span>
            </p>
            {freqTable.length > 0 ? (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Cluster</th><th>Sample</th><th className="text-right">频率</th></tr></thead>
                  <tbody>
                    {freqTablePageData.map((row, i) => (
                      <tr key={i}>
                        <td className="font-mono font-semibold" style={{ color: "var(--clr-amber-dark)" }}>{row.Cluster}</td>
                        <td>{row.Sample}</td>
                        <td className="text-right font-mono">{row.Freq !== undefined ? (row.Freq * 100).toFixed(2) + "%" : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="callout text-xs">频率统计数据暂未返回</div>}
            
            {freqTableTotalPages > 1 && (
              <div className="flex items-center justify-center gap-2 mt-3 text-xs" style={{ color: "var(--clr-text-muted)" }}>
                <button
                  disabled={freqTablePage === 0}
                  onClick={() => setFreqTablePage(p => p - 1)}
                  className="px-2 py-1 rounded"
                  style={{ border: "1px solid var(--clr-border)", opacity: freqTablePage === 0 ? 0.4 : 1 }}
                >‹ 上一页</button>
                <span>{freqTablePage + 1} / {freqTableTotalPages}</span>
                <button
                  disabled={freqTablePage >= freqTableTotalPages - 1}
                  onClick={() => setFreqTablePage(p => p + 1)}
                  className="px-2 py-1 rounded"
                  style={{ border: "1px solid var(--clr-border)", opacity: freqTablePage >= freqTableTotalPages - 1 ? 0.4 : 1 }}
                >下一页 ›</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Tab 2: 样本 Cluster 占比图（my_distPlot4: Sankey + 堆叠柱） ── */}
      {activeTab === "sankey" && (
        <div className="space-y-1">
          <SectionTitle>样本 Cluster 占比图 — Fraction of cell populations (%)</SectionTitle>
          <div className="relative w-full">
            <AuthImg src={sankeySrc} alt="Sample Cluster Proportion"
              className="w-full rounded border" style={{ border: "1px solid var(--clr-border)", background: "#fff" }} />
            <AuthDownloadLink
              url={sankeyDownloadSrc || sankeySrc}
              filename={sankeyDownloadName || sankeyName}
              className="absolute bottom-3 right-3 inline-flex items-center justify-center w-9 h-9 rounded-lg transition-all hover:scale-110"
              style={{ background: "rgba(255,255,255,0.92)", boxShadow: "0 2px 8px rgba(0,0,0,0.10)", color: "var(--clr-amber)" }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </AuthDownloadLink>
          </div>
        </div>
      )}

      {/* ── Tab 4: 分组 Cluster UMAP 图（my_distPlot6） ── */}
      {activeTab === "group" && (
        <div className="space-y-1">
          <SectionTitle>分组 Cluster UMAP 图</SectionTitle>
          <div className="relative w-full">
            <AuthImg src={groupSrc} alt="Group Cluster UMAP"
              className="w-full rounded border" style={{ border: "1px solid var(--clr-border)", background: "#fff" }} />
            <AuthDownloadLink
              url={groupDownloadSrc || groupSrc}
              filename={groupDownloadName || groupName}
              className="absolute bottom-3 right-3 inline-flex items-center justify-center w-9 h-9 rounded-lg transition-all hover:scale-110"
              style={{ background: "rgba(255,255,255,0.92)", boxShadow: "0 2px 8px rgba(0,0,0,0.10)", color: "var(--clr-amber)" }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </AuthDownloadLink>
          </div>
        </div>
      )}

      {/* ── Tab 4.5: metadata 表格 ── */}
      {activeTab === "metadata" && metaSample && metaSample.length > 0 && (
        <div className="space-y-2">
          <div className="flex gap-3">
            <AuthDownloadLink
              url={`/api/tasks/${taskId}/meta_csv`}
              filename={metaCsvName}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium transition-all hover:shadow-sm"
              style={{ border: "1px solid var(--clr-border)", color: "var(--clr-amber-dark)", background: "rgba(200,96,25,0.04)" }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              全部 meta.data .csv
            </AuthDownloadLink>
          </div>
          <SectionTitle>
            meta.data 预览
            <span className="font-normal ml-1" style={{ color: "var(--clr-text-faint)" }}>
              — 显示前 {Math.min(metaSample.length, 100)} / {metaTotalRows.toLocaleString()} 行
            </span>
          </SectionTitle>
          <div className="table-wrap" style={{ maxWidth: "100%", overflowX: "auto" }}>
            <table style={{ fontSize: "0.7rem" }}>
              <thead>
                <tr>{metaCols.map(c => <th key={c} style={{ whiteSpace: "nowrap" }}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {metaPageData.map((row, i) => (
                  <tr key={i}>
                    {metaCols.map(c => (
                      <td key={c} style={{
                        whiteSpace: "nowrap",
                        maxWidth: "180px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        ...(c === "barcode" ? { fontFamily: "var(--font-mono)", color: "var(--clr-amber-dark)" } : {}),
                      }}>
                        {String(row[c] ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* 分页控件 */}
          {metaTotalPages > 1 && (
            <div className="flex items-center justify-center gap-2 text-xs" style={{ color: "var(--clr-text-muted)" }}>
              <button
                disabled={metaPage === 0}
                onClick={() => setMetaPage(p => p - 1)}
                className="px-2 py-1 rounded"
                style={{ border: "1px solid var(--clr-border)", opacity: metaPage === 0 ? 0.4 : 1 }}
              >
                ‹ 上一页
              </button>
              <span>{metaPage + 1} / {metaTotalPages}</span>
              <button
                disabled={metaPage >= metaTotalPages - 1}
                onClick={() => setMetaPage(p => p + 1)}
                className="px-2 py-1 rounded"
                style={{ border: "1px solid var(--clr-border)", opacity: metaPage >= metaTotalPages - 1 ? 0.4 : 1 }}
              >
                下一页 ›
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Tab 5: 细胞亚类提取 ── */}
      {activeTab === "subtype" && (
        <div className="space-y-4">

          {/* 亚类提取 UI */}
          <div className="card mt-4">
            <div className="card-label mb-3">提取亚群 (Subset)</div>
            <p className="text-xs mb-3" style={{ color: "var(--clr-text-muted)" }}>选择一个或多个亚类提取并保存为新的 RDS 文件。</p>
            {stats?.cluster_levels && (
              <div className="flex flex-wrap gap-3 mb-4">
                {stats.cluster_levels.map(cl => (
                  <label key={cl} className="flex items-center gap-1.5 text-xs cursor-pointer select-none">
                    <input 
                      type="checkbox" 
                      className="accent-[#C86019]"
                      checked={selectedClusters.includes(cl)}
                      onChange={(e) => {
                        subsetTouchedRef.current = true;  // 用户改选 → 不让历史恢复覆盖其选择
                        if (e.target.checked) setSelectedClusters(prev => [...prev, cl]);
                        else setSelectedClusters(prev => prev.filter(c => c !== cl));
                      }}
                    />
                    {cl}
                  </label>
                ))}
              </div>
            )}
            
            {subsetError && <div className="callout callout-danger text-xs mb-3">{subsetError}</div>}
            
            {!subsetTask || subsetTask.status === 'completed' || subsetTask.status === 'failed' ? (
              <button
                disabled={selectedClusters.length === 0 || submittingSubset}
                onClick={async () => {
                  if (selectedClusters.length === 0) return;
                  subsetTouchedRef.current = true;  // 用户手动提取 → 阻止历史结果回填覆盖
                  setSubmittingSubset(true);
                  setSubsetError(null);
                  try {
                    const res = await submitTask({
                      project_id: task.project_id,
                      step: "subset_cluster",
                      params: { clusters: selectedClusters }
                    });
                    setSubsetTask(res);
                  } catch (e) {
                    setSubsetError(e instanceof Error ? e.message : "提交提取任务失败");
                  } finally {
                    setSubmittingSubset(false);
                  }
                }}
                className="px-4 py-2 bg-[#C86019] text-white rounded text-xs transition-colors hover:bg-[#b05214] disabled:opacity-50"
              >
                {submittingSubset ? "提交中..." : "提取选中亚群"}
              </button>
            ) : (
              <div className="w-full">
                <ProgressTracker 
                  taskId={subsetTask.id} 
                  stepLabel="亚类提取" 
                  onComplete={() => {
                    // Refresh subsetTask state to get result path
                    getTask(subsetTask.id).then(t => setSubsetTask(t));
                  }} 
                  onError={(err) => setSubsetError(err)}
                />
              </div>
            )}

            {subsetTask?.status === 'completed' && subsetTask.result_path && (
              <div className="mt-4 p-3 rounded" style={{ background: "rgba(45, 138, 86, 0.05)", border: "1px solid rgba(45, 138, 86, 0.2)" }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2D8A56" strokeWidth="2" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                    <span className="text-xs font-medium" style={{ color: "#2D8A56" }}>提取完成</span>
                  </div>
                  <AuthDownloadLink 
                    url={`/api/tasks/${subsetTask.id}/plot?name=${encodeURIComponent(subsetTask.result_path.split('/').pop()!)}`}
                    filename={subsetTask.result_path.split('/').pop()!}
                    className="flex items-center gap-1 text-xs px-3 py-1.5 rounded transition-colors hover:bg-white"
                    style={{ color: "#2D8A56", border: "1px solid #C3E6D1" }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    下载 {subsetTask.result_path.split('/').pop()!}
                  </AuthDownloadLink>
                </div>
              </div>
            )}
          </div>
        </div>
      )}


    </div>
  );
}

/** 差异基因结果 */
function MarkersResult({ task, data, taskCache, clusterLevels: parentClusterLevels, projectName }: { task: Task; data: Record<string, unknown> | null; taskCache?: Record<string, Task>; clusterLevels?: string[]; projectName?: string }) {
  // 动态列表方式（与 meta.data 一致），兼容 R 返回的任意字段名
  type GeneRow = Record<string, unknown>;
  const topGenes = (data?.top_genes ?? []) as GeneRow[];
  const stats    = data?.stats as { total_deg?: number; clusters_analyzed?: string; group_by?: string } | undefined;
  // groupPrefix 在 analyzedClusters 定义后计算

  // 动态提取列名（优先排序常用列）
  const preferredOrder = ["gene", "Cluster", "CellType", "avg_log2FC", "p_val", "p_val_adj", "pct.1", "pct.2"];
  const geneCols = useMemo(() => {
    if (topGenes.length === 0) return [];
    const allKeys = Array.from(new Set(topGenes.flatMap(row => Object.keys(row))));
    const ordered = preferredOrder.filter(k => allKeys.includes(k));
    const rest = allKeys.filter(k => !preferredOrder.includes(k));
    return [...ordered, ...rest];
  }, [topGenes]);

  // 分页
  const [genePage, setGenePage] = useState(0);
  const genePageSize = 10;
  const genePageData = topGenes.slice(genePage * genePageSize, (genePage + 1) * genePageSize);
  const geneTotalPages = Math.ceil(topGenes.length / genePageSize);

  // 从 API 响应中动态提取图片文件名
  const dotplotPath = safeString(data?.plot_path);
  const dotplotName = dotplotPath ? dotplotPath.split("/").pop()! : "plot_markers_dotplot.png";
  const heatmapPath = safeString(data?.heatmap_path);
  const heatmapName = heatmapPath ? heatmapPath.split("/").pop()! : "plot_markers_heatmap.png";
  const csvPath     = safeString(data?.result_path);
  const csvName     = (() => { const p = typeof csvPath === 'string' ? csvPath : (Array.isArray(csvPath) ? csvPath[0] : null); return typeof p === 'string' ? p.split('/').pop()! : 'diff_genes.csv'; })();

  const dotplotSrc = task ? `/api/tasks/${task.id}/plot?name=${encodeURIComponent(dotplotName)}` : null;
  const heatmapSrc = task ? `/api/tasks/${task.id}/plot?name=${encodeURIComponent(heatmapName)}` : null;

  // ----- 聚类列表 -----
  const analyzedClusters = useMemo(() => {
    const raw = safeString(data?.clusters_analyzed);
    if (!raw || raw === "All" || raw === "所有聚类") {
      // 优先从 markers 结果的 cluster_labels 取
      const allC = safeString(data?.cluster_labels);
      if (allC) return allC.split(/[,·]/).map(s => s.trim()).filter(Boolean);
      // 回退：从父组件传入的聚类步骤 cluster_levels 取
      if (parentClusterLevels && parentClusterLevels.length > 0) return parentClusterLevels;
      // 最终回退：从 top_genes 数据的 Cluster 列提取唯一值
      if (topGenes.length > 0) {
        const unique = [...new Set(topGenes.map(r => String(r.Cluster ?? "")).filter(Boolean))];
        if (unique.length > 0) return unique;
      }
      return [];
    }
    return raw.split(",").map(s => s.trim()).filter(Boolean);
  }, [data, topGenes, parentClusterLevels]);

  // 根据 group_by 决定前缀：CellType 时不加前缀（细胞类型名自带含义），否则显示"Cluster"
  // 对于没有 group_by 字段的旧结果，从 analyzedClusters 内容推断
  const groupPrefix = stats?.group_by === "CellType" ||
    (analyzedClusters.length > 0 && analyzedClusters[0] && !/^C\d+$/.test(analyzedClusters[0]))
    ? "" : "Cluster ";

  // getToken 便捷函数
  const getToken = () => {
    if (typeof window === "undefined") return "";
    return getAuthToken() || "";
  };

  // Tab 定义
  const TABS = ["全局差异表", "大盘基因图", "单簇特征分布图", "双簇对比表"];
  const [activeTab, setActiveTab] = useState(0);

  // Tab 3 State — 多选
  const [tab3Selected, setTab3Selected] = useState<string[]>([]);
  const [tab3TaskId, setTab3TaskId] = useState<string | null>(null);
  const [tab3Task, setTab3Task] = useState<Task | null>(null);
  const [tab3Data, setTab3Data] = useState<Record<string, unknown> | null>(null);
  const [tab3Loading, setTab3Loading] = useState(false);
  const [tab3Error, setTab3Error] = useState<string | null>(null);
  const [tab3PlotMode, setTab3PlotMode] = useState<'feature' | 'vln'>('feature');

  // 自定义基因 — 基因自动补全
  const [customGenes, setCustomGenes] = useState<string[]>([]);
  const [allGenes, setAllGenes] = useState<string[]>([]);
  const [genesLoading, setGenesLoading] = useState(false);
  const [genesFetched, setGenesFetched] = useState(false);

  // 当用户切换到 Tab 3 时，自动加载基因列表（仅首次）
  useEffect(() => {
    if (activeTab === 2 && !genesFetched && task?.project_id) {
      setGenesLoading(true);
      fetchWithAuth(`/api/projects/${task.project_id}/genes`)
        .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
        .then((data) => {
          setAllGenes(data.genes || []);
          setGenesFetched(true);
        })
        .catch(() => { /* 静默失败，用户仍可使用 top N 功能 */ })
        .finally(() => setGenesLoading(false));
    }
  }, [activeTab, genesFetched, task?.project_id]);

  // Tab 4 State — 多选
  const [tab4G1, setTab4G1] = useState<string[]>([]);
  const [tab4G2, setTab4G2] = useState<string[]>([]);
  const [tab4TaskId, setTab4TaskId] = useState<string | null>(null);
  const [tab4Task, setTab4Task] = useState<Task | null>(null);
  const [tab4Data, setTab4Data] = useState<GeneRow[] | null>(null);
  const [tab4Loading, setTab4Loading] = useState(false);
  const [tab4Error, setTab4Error] = useState<string | null>(null);
  const [tab4Volcano, setTab4Volcano] = useState<VolcanoPoint[] | null>(null);
  // 用户本次挂载内已手动计算过 → 不再用历史结果覆盖(remount 后 ref 重置, 会重新恢复最新一条)。
  // tab3/tab4 各一把: 只算了单簇图不应连带挡住双簇表的历史恢复, 反之亦然。
  const tab3TouchedRef = useRef(false);
  const tab4TouchedRef = useRef(false);

  useEffect(() => {
    if (analyzedClusters.length > 0) {
       if (tab3Selected.length === 0) setTab3Selected([analyzedClusters[0]]);
       if (tab4G1.length === 0) setTab4G1([analyzedClusters[0]]);
       if (tab4G2.length === 0) setTab4G2(analyzedClusters.length > 1 ? [analyzedClusters[1]] : [analyzedClusters[0]]);
    }
  }, [analyzedClusters]);

  // 挂载时恢复上次"单簇特征分布图"(plot_markers) / "双簇对比表"(markers_pairwise) 的计算结果,
  // 切走再切回来不丢。只拉一次已完成任务列表, 再分别取两个 step 的结果。
  // tab3/tab4TouchedRef: 对应 tab 本次挂载内已手动计算则该 tab 恢复跳过(数据 + 选择项一致);
  // 每次 await 后都重新检查 alive/ref, 避免卸载或抢跑后仍 setState。
  useEffect(() => {
    if (!task?.project_id) return;
    let alive = true;
    listCompletedTasks(task.project_id)
      .then(async (tasks) => {
        if (!alive) return;
        const pm = latestOfStep(tasks, "plot_markers");
        if (pm && !tab3TouchedRef.current) {
          // 各 tab 独立 try: 一个 tab 恢复失败不应阻断另一个(fetchTaskResult 现已内部吞错,
          // 此处再包一层防御, 万一日后改了其签名也不会连带挂掉另一 tab)
          try {
            const res = await fetchTaskResult(pm.id);
            if (alive && !tab3TouchedRef.current && res) {
              setTab3Data(res);
              setTab3Task(pm);
              setTab3TaskId(pm.id);
              const cl = paramToList(pm.params?.cluster);
              if (cl.length) setTab3Selected(cl);
            }
          } catch { /* best-effort: 跳过单簇图恢复 */ }
        }
        if (!alive) return;
        const mp = latestOfStep(tasks, "markers_pairwise");
        if (mp && !tab4TouchedRef.current) {
          try {
            const res = await fetchTaskResult(mp.id);
            if (alive && !tab4TouchedRef.current && res) {
              setTab4Data((res.top_genes ?? []) as GeneRow[]);
              setTab4Task(mp);
              setTab4TaskId(mp.id);
              const vd = res.volcano_data;
              setTab4Volcano(Array.isArray(vd) && vd.length > 0 ? (vd as VolcanoPoint[]) : null);
              const c1 = paramToList(mp.params?.cluster_1);
              const c2 = paramToList(mp.params?.cluster_2);
              if (c1.length) setTab4G1(c1);
              if (c2.length) setTab4G2(c2);
            }
          } catch { /* best-effort: 跳过双簇表恢复 */ }
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [task?.project_id]);

  // 格式化单元格值
  const fmtCell = (val: unknown): string => {
    if (val === null || val === undefined) return "";
    if (typeof val === "number") {
      if (Math.abs(val) < 0.001 && val !== 0) return val.toExponential(2);
      return Number.isInteger(val) ? String(val) : val.toFixed(3);
    }
    return String(val);
  };

  /* ========== Sub-task runner ========== */
  const runSubTask = async (
    step: string,
    params: Record<string, unknown>,
    setLoader: (v: boolean) => void,
    setError: (v: string | null) => void,
    onSuccess: (taskId: string, result: any, completedTask: Task) => void,
  ) => {
    // 用户手动计算 → 按 step 阻止对应 tab 的历史结果回填覆盖
    if (step === "plot_markers") tab3TouchedRef.current = true;
    else if (step === "markers_pairwise") tab4TouchedRef.current = true;
    setLoader(true);
    setError(null);
    try {
      const res = await fetchWithAuth("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: task.project_id, step, params })
      });
      if (!res.ok) throw new Error(`提交失败: ${res.statusText}`);
      const t = await res.json();

      const pollTask = async (id: string): Promise<Task> => {
        const r = await fetchWithAuth(`/api/tasks/${id}`);
        const fresh = await r.json();
        if (fresh.status === "failed") throw new Error(fresh.error_msg || "任务失败");
        if (fresh.status === "completed") return fresh;
        await new Promise(r => setTimeout(r, 2000));
        return pollTask(id);
      };

      const completedTask = await pollTask(t.id);

      const rRes = await fetchWithAuth(`/api/tasks/${t.id}/result`);
      const finalResult = await rRes.json();
      onSuccess(t.id, finalResult, completedTask);
    } catch(err: any) {
      setError(err.message);
    } finally {
      setLoader(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex border-b" style={{ borderColor: 'var(--clr-border)' }}>
        {TABS.map((t, i) => (
          <button
            key={i}
            onClick={() => setActiveTab(i)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2`}
            style={{ 
              borderColor: activeTab === i ? 'var(--clr-amber)' : 'transparent',
              color: activeTab === i ? 'var(--clr-amber-dark)' : 'var(--clr-text-muted)'
            }}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="pt-2">
        {/* Tab 1: 全局差异表（动态列 + 分页，同 meta.data 样式） */}
        {activeTab === 0 && (
          <div className="space-y-3 animate-fade-in">
             {stats && (
              <div className="flex gap-4 text-xs" style={{ color: "var(--clr-text-faint)" }}>
                <span>共 <strong style={{ color: "var(--clr-amber)" }}>{stats.total_deg}</strong> 个差异基因</span>
                <span>分析聚类：<strong style={{ color: "var(--clr-text)" }}>{stats.clusters_analyzed}</strong></span>
              </div>
            )}
            {topGenes.length > 0 ? (
              <div className="space-y-2">
                <div className="card-label">
                  差异基因预览
                  <span className="font-normal ml-1" style={{ color: "var(--clr-text-faint)" }}>
                    — 显示前 {topGenes.length} 行
                  </span>
                </div>
                <div className="table-wrap" style={{ maxWidth: "100%", overflowX: "auto" }}>
                  <table style={{ fontSize: "0.7rem" }}>
                    <thead>
                      <tr>{geneCols.map(c => <th key={c} style={{ whiteSpace: "nowrap" }}>{c.toUpperCase()}</th>)}</tr>
                    </thead>
                    <tbody>
                      {genePageData.map((row, i) => (
                        <tr key={i}>
                          {geneCols.map(c => (
                            <td key={c} style={{
                              whiteSpace: "nowrap",
                              maxWidth: "180px",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              ...(c === "gene_id" ? { fontFamily: "var(--font-mono)", color: "var(--clr-amber-dark)" } : {}),
                            }}>
                              {fmtCell(row[c])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* 分页控件 */}
                {geneTotalPages > 1 && (
                  <div className="flex items-center justify-center gap-2 text-xs" style={{ color: "var(--clr-text-muted)" }}>
                    <button
                      disabled={genePage === 0}
                      onClick={() => setGenePage(p => p - 1)}
                      className="px-2 py-1 rounded"
                      style={{ border: "1px solid var(--clr-border)", opacity: genePage === 0 ? 0.4 : 1 }}
                    >
                      ‹ 上一页
                    </button>
                    <span>{genePage + 1} / {geneTotalPages}</span>
                    <button
                      disabled={genePage >= geneTotalPages - 1}
                      onClick={() => setGenePage(p => p + 1)}
                      className="px-2 py-1 rounded"
                      style={{ border: "1px solid var(--clr-border)", opacity: genePage >= geneTotalPages - 1 ? 0.4 : 1 }}
                    >
                      下一页 ›
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="callout text-xs">差异基因表数据暂未返回</div>
            )}
            <div className="mt-4">
              <AuthDownloadLink 
                url={`/api/tasks/${task.id}/plot?name=${encodeURIComponent(csvName)}`} 
                filename={csvName}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors text-white"
                style={{ background: "var(--clr-amber)" }}
              >
                下载完整差异基因表 (.csv)
              </AuthDownloadLink>
            </div>
          </div>
        )}

        {/* Tab 2: 大盘基因图 */}
        {activeTab === 1 && (
          <div className="space-y-6 animate-fade-in flex flex-col items-center">
            <div className="w-full flex-col flex items-center">
              <p className="text-sm font-semibold mb-2 self-start" style={{ color: 'var(--clr-text)' }}>各聚类显著差异基因点图 (DotPlot)</p>
              {dotplotSrc && (
                <div className="relative w-full max-w-4xl">
                  <AuthImg src={dotplotSrc} alt="DotPlot" className="w-full border rounded shadow-sm" style={{ borderColor: 'var(--clr-border)' }} />
                  <AuthDownloadLink
                    url={dotplotSrc}
                    filename={dotplotName}
                    className="absolute bottom-3 right-3 inline-flex items-center justify-center w-9 h-9 rounded-lg transition-all hover:scale-110"
                    style={{ background: "rgba(255,255,255,0.92)", boxShadow: "0 2px 8px rgba(0,0,0,0.10)", color: "var(--clr-amber)" }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  </AuthDownloadLink>
                </div>
              )}
            </div>
            <div className="w-full h-px" style={{ background: 'var(--clr-border)' }}></div>
            <div className="w-full flex-col flex items-center">
              <p className="text-sm font-semibold mb-2 self-start" style={{ color: 'var(--clr-text)' }}>各聚类显著差异基因热图 (Heatmap) (需要 ntop 增加才有明显表现)</p>
              {heatmapSrc && (
                <div className="relative w-full max-w-4xl">
                  <AuthImg src={heatmapSrc} alt="Heatmap" className="w-full border rounded shadow-sm" style={{ borderColor: 'var(--clr-border)' }} />
                  <AuthDownloadLink
                    url={heatmapSrc}
                    filename={heatmapName}
                    className="absolute bottom-3 right-3 inline-flex items-center justify-center w-9 h-9 rounded-lg transition-all hover:scale-110"
                    style={{ background: "rgba(255,255,255,0.92)", boxShadow: "0 2px 8px rgba(0,0,0,0.10)", color: "var(--clr-amber)" }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  </AuthDownloadLink>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tab 3: 聚类特征分布图（多选下拉 + 自定义基因） */}
        {activeTab === 2 && (
          <div className="space-y-4 animate-fade-in">
             <div className="bg-stone-50 p-4 rounded border flex flex-col items-center space-y-4" style={{ borderColor: 'var(--clr-border)' }}>
               {/* 第一行：聚类选择 */}
               <div className="w-full max-w-2xl">
                 <label className="text-xs font-medium mb-1.5 block" style={{ color: "var(--clr-text-muted)" }}>
                   选择{groupPrefix ? "聚类群" : "细胞类型"}
                 </label>
                 <MultiSelectDropdown
                   options={analyzedClusters}
                   selected={tab3Selected}
                   onChange={setTab3Selected}
                   renderLabel={c => `${groupPrefix}${c}`}
                   placeholder={`点击选择${groupPrefix ? "聚类" : "细胞类型"}…`}
                 />
               </div>
               
               {/* 第二行：自定义基因输入 */}
               <div className="w-full max-w-2xl">
                 <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--clr-text-muted)' }}>
                   自定义关注基因 <span className="font-normal">（可选，会追加到 Top N 结果中）</span>
                 </label>
                 <GeneAutocomplete
                   allGenes={allGenes}
                   selected={customGenes}
                   onChange={setCustomGenes}
                   loading={genesLoading}
                   placeholder="输入基因名搜索，如 FOXP3, CD4…"
                 />
               </div>

               {/* 按钮 */}
               <button 
                 onClick={() => {
                   const clusterStr = tab3Selected.join(',');
                   const customStr = customGenes.join(',');
                   runSubTask("plot_markers", { ...task.params, cluster: clusterStr, custom_genes: customStr, group_by: !groupPrefix ? "CellType" : (task.params?.group_by ?? "Cluster") }, setTab3Loading, setTab3Error, (tid: string, res: any, completedTask: Task) => {
                     setTab3TaskId(tid);
                     setTab3Task(completedTask);
                     setTab3Data(res);
                   });
                 }}
                 disabled={tab3Loading || tab3Selected.length === 0}
                 className="px-6 py-2 text-white text-sm rounded shadow-sm hover:opacity-90 transition-opacity disabled:opacity-50 mt-2"
                 style={{ background: 'var(--clr-amber)' }}
               >
                 {tab3Loading ? "计算中..." : "生成表达特征图"}
               </button>
             </div>
             
             {tab3Error && <div className="callout callout-danger text-xs">{tab3Error}</div>}
             
             {tab3TaskId && tab3Task && !tab3Loading && !tab3Error && (
               <div className="mt-4 w-full animate-fade-in">
                 <div className="flex gap-2 mb-4">
                   {([['feature', 'FeaturePlot 特征图 (UMAP)'], ['vln', 'VlnPlot 小提琴图 (Expression)']] as const).map(([mode, label]) => (
                     <button
                       key={mode}
                       onClick={() => setTab3PlotMode(mode)}
                       className="px-3 py-1.5 text-xs font-medium rounded-full transition-all"
                       style={tab3PlotMode === mode
                         ? { background: 'var(--clr-amber)', color: '#fff', boxShadow: '0 2px 8px rgba(200,96,25,0.3)' }
                         : { background: 'rgba(200,96,25,0.06)', color: 'var(--clr-text-muted)', border: '1px solid var(--clr-border)' }
                       }
                     >{label}</button>
                   ))}
                 </div>
                 {/* 为每个选中的 cluster 渲染图片 */}
                 {tab3Selected.map(cl => {
                   // 这里的 featureName 和 vlnName 是用于请求图片 src 的 canonical 名称
                   const fmt = (task.params?.plot_format as string) || "png";
                   const featureName = `plot_markers_feature_${cl}.${fmt}`;
                   const vlnName = `plot_markers_vln_${cl}.${fmt}`;
                   const featureSrc = `/api/tasks/${tab3TaskId}/plot?name=${encodeURIComponent(featureName)}`;
                   const vlnSrc = `/api/tasks/${tab3TaskId}/plot?name=${encodeURIComponent(vlnName)}`;
                   
                   // 优先用 R 引擎返回的归档文件名（处理 jsonlite 单值数组包装）
                   const pps = tab3Data?.plot_paths as Record<string, {feature: string | string[]; vln: string | string[]}> | undefined;
                   const fRaw: string | string[] | undefined = pps?.[cl]?.feature;
                   const vRaw: string | string[] | undefined = pps?.[cl]?.vln;
                   const fp = Array.isArray(fRaw) ? fRaw[0] : fRaw;
                   const vp = Array.isArray(vRaw) ? vRaw[0] : vRaw;
                   const downloadFeatureName = (typeof fp === 'string' ? fp.split('/').pop()! : `plot_markers_feature_${cl}.${fmt}`);
                   const downloadVlnName = (typeof vp === 'string' ? vp.split('/').pop()! : `plot_markers_vln_${cl}.${fmt}`);
                   
                   return (
                   <div key={cl} className="mb-6">
                     <h4 className="text-xs font-semibold mb-2 px-1" style={{ color: 'var(--clr-text-muted)' }}>Cluster {cl}</h4>
                     {tab3PlotMode === 'feature' && (
                       <>
                         <div className="relative w-full max-w-4xl mx-auto">
                           <AuthImg src={featureSrc} alt={`Feature Plot ${cl}`} className="w-full border rounded shadow-sm bg-white block" />
                           <AuthDownloadLink url={featureSrc} filename={downloadFeatureName}
                             className="absolute bottom-3 right-3 inline-flex items-center justify-center w-9 h-9 rounded-lg transition-all hover:scale-110"
                             style={{ background: 'rgba(255,255,255,0.92)', boxShadow: '0 2px 8px rgba(0,0,0,0.10)', color: 'var(--clr-amber)' }}
                           >
                             <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                           </AuthDownloadLink>
                         </div>
                       </>
                     )}
                     {tab3PlotMode === 'vln' && (
                       <>
                         <div className="relative w-full max-w-4xl mx-auto">
                           <AuthImg src={vlnSrc} alt={`Vln Plot ${cl}`} className="w-full border rounded shadow-sm bg-white block" />
                           <AuthDownloadLink url={vlnSrc} filename={downloadVlnName}
                             className="absolute bottom-3 right-3 inline-flex items-center justify-center w-9 h-9 rounded-lg transition-all hover:scale-110"
                             style={{ background: 'rgba(255,255,255,0.92)', boxShadow: '0 2px 8px rgba(0,0,0,0.10)', color: 'var(--clr-amber)' }}
                           >
                             <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                           </AuthDownloadLink>
                         </div>
                       </>
                     )}
                   </div>);
                   })}
               </div>
             )}
          </div>
        )}

        {/* Tab 4: 分组对比（多选下拉） */}
        {activeTab === 3 && (
          <div className="space-y-4 animate-fade-in">
             <div className="bg-stone-50 p-4 rounded border flex flex-col items-center space-y-4" style={{ borderColor: 'var(--clr-border)' }}>
               <div className="w-full max-w-3xl grid grid-cols-[1fr_auto_1fr] gap-3 items-end">
                 {/* Group 1 */}
                 <div>
                   <label className="text-xs font-medium flex items-baseline gap-1.5 mb-1.5" style={{ color: 'var(--clr-text-muted)' }}>
                     <span className="shrink-0">组一 (Group 1)</span>
                     {tab4G1.length > 0 && (
                       <span>{tab4G1.map(c => `${groupPrefix}${c}`).join(', ')}</span>
                     )}
                   </label>
                   <MultiSelectDropdown
                     options={analyzedClusters}
                     selected={tab4G1}
                     onChange={setTab4G1}
                     renderLabel={c => `${groupPrefix}${c}`}
                     placeholder={`选择组一${groupPrefix ? "聚类" : "细胞类型"}…`}
                   />
                 </div>
                 <span className="text-stone-400 font-bold text-lg mb-1.5">vs</span>
                 {/* Group 2 */}
                 <div>
                   <label className="text-xs font-medium flex items-baseline gap-1.5 mb-1.5" style={{ color: 'var(--clr-text-muted)' }}>
                     <span className="shrink-0">组二 (Group 2)</span>
                     {tab4G2.length > 0 && (
                       <span>{tab4G2.map(c => `${groupPrefix}${c}`).join(', ')}</span>
                     )}
                   </label>
                   <MultiSelectDropdown
                     options={analyzedClusters}
                     selected={tab4G2}
                     onChange={setTab4G2}
                     renderLabel={c => `${groupPrefix}${c}`}
                     placeholder={`选择组二${groupPrefix ? "聚类" : "细胞类型"}…`}
                   />
                 </div>
               </div>

               <button 
                 onClick={() => {
                   const g1Str = tab4G1.join(',');
                   const g2Str = tab4G2.join(',');
                   runSubTask("markers_pairwise", { ...task.params, cluster_1: g1Str, cluster_2: g2Str, group_by: !groupPrefix ? "CellType" : (task.params?.group_by ?? "Cluster") }, setTab4Loading, setTab4Error, (tid: string, res: any, completedTask: Task) => {
                       setTab4TaskId(tid);
                       setTab4Task(completedTask);
                       setTab4Data((res.top_genes ?? []) as GeneRow[]);
                       // 火山图数据
                       const vd = res.volcano_data;
                       if (Array.isArray(vd) && vd.length > 0) {
                         setTab4Volcano(vd as VolcanoPoint[]);
                       } else {
                         setTab4Volcano(null);
                       }
                   });
                 }}
                 disabled={tab4Loading || tab4G1.length === 0 || tab4G2.length === 0 || (tab4G1.length === 1 && tab4G2.length === 1 && tab4G1[0] === tab4G2[0])}
                 className="px-6 py-2 text-white text-sm rounded shadow-sm hover:opacity-90 transition-opacity disabled:opacity-50 mt-2"
                 style={{ background: 'var(--clr-amber)' }}
               >
                 {tab4Loading ? "对比计算中..." : "进行分组差异分析"}
               </button>
             </div>
             
             {tab4Error && <div className="callout callout-danger text-xs">{tab4Error}</div>}
             
             {tab4TaskId && !tab4Loading && !tab4Error && tab4Data && (() => {
                const tab4Cols = tab4Data.length > 0
                  ? (() => {
                      const allKeys = Array.from(new Set(tab4Data.flatMap(row => Object.keys(row))));
                      const pref = ["gene_id", "avg_log2FC", "p_val", "p_val_adj", "pct.1", "pct.2"];
                      const ordered = pref.filter(k => allKeys.includes(k));
                      const rest = allKeys.filter(k => !pref.includes(k));
                      return [...ordered, ...rest];
                    })()
                  : [];
                return (
                <div className="animate-fade-in">
                  <div className="flex gap-4 text-xs mb-3" style={{ color: "var(--clr-text-faint)" }}>
                    <span>分析对：<strong style={{ color: "var(--clr-text)" }}>{tab4G1.join('+')} vs {tab4G2.join('+')}</strong></span>
                  </div>
                  {/* 火山图 */}
                  {tab4Volcano && tab4Volcano.length > 0 && (
                    <div className="mb-4">
                      <VolcanoPlot
                        data={tab4Volcano}
                        title={`${tab4G1.join('+')} vs ${tab4G2.join('+')}`}
                        height={550}
                        plotFormat={(task.params?.plot_format as string) || "png"}
                        projectName={projectName}
                        completedAt={tab4Task?.completed_at}
                      />
                    </div>
                  )}
                  <div className="space-y-2 mb-4">
                    <div className="card-label">
                      分组差异基因预览
                      <span className="font-normal ml-1" style={{ color: "var(--clr-text-faint)" }}>— 显示前 {tab4Data.length} 行</span>
                    </div>
                    <div className="table-wrap" style={{ maxWidth: "100%", overflowX: "auto" }}>
                      <table style={{ fontSize: "0.7rem" }}>
                        <thead>
                          <tr>{tab4Cols.map(c => <th key={c} style={{ whiteSpace: "nowrap" }}>{c.toUpperCase()}</th>)}</tr>
                        </thead>
                        <tbody>
                          {tab4Data.map((row, i) => (
                            <tr key={i}>
                              {tab4Cols.map(c => (
                                <td key={c} style={{
                                  whiteSpace: "nowrap",
                                  maxWidth: "180px",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  ...(c === "gene_id" ? { fontFamily: "var(--font-mono)", color: "var(--clr-amber-dark)" } : {}),
                                }}>
                                  {fmtCell(row[c])}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  {(() => {
                    const fmt4 = (task.params?.plot_format as string) || "png";
                    const ts = tab4Task?.completed_at ? tab4Task.completed_at.replace(/[-:T]/g, '').slice(0, 14) : "";
                    const g1Label = tab4G1.join('_');
                    const g2Label = tab4G2.join('_');
                    // 使用 task result_path 中的实际文件名（而非硬编码名）
                    const actualCsvName = tab4Task?.result_path
                      ? tab4Task.result_path.split('/').pop()!
                      : `markers_pairwise_${g1Label}_vs_${g2Label}.csv`;
                    const downloadCsvName = actualCsvName;

                    return (
                      <AuthDownloadLink 
                        url={`/api/tasks/${tab4TaskId}/plot?name=${encodeURIComponent(actualCsvName)}`} 
                        filename={downloadCsvName}
                        className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded transition-colors text-white hover:opacity-90"
                        style={{ background: "var(--clr-amber)", boxShadow: "0 2px 4px rgba(200,96,25,0.2)" }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                        下载分组差异基因表 (.csv)
                      </AuthDownloadLink>
                    );
                  })()}
                </div>);
              })()}
          </div>
        )}

      </div>
    </div>
  );
}

/** 富集分析结果 — 严格依赖 R 原版脚本输出，展示 ggplot2 图 */
function EnrichResult({ data, taskId }: { data: Record<string, unknown> | null; taskId?: string }) {
  const enrichData = data?.enrich_data as EnrichData | undefined;
  const stats      = data?.stats as { pathway?: string; direction?: string; significant_terms?: number } | undefined;

  // 安全提取 plot_path：R jsonlite 有时将单元素向量序列化为 ["path"] 数组
  const plotPath    = safeString(data?.plot_path);
  const plotFileName = plotPath ? plotPath.split("/").pop() : null;
  const plotSrc = plotFileName && taskId
    ? `/api/tasks/${taskId}/plot?name=${encodeURIComponent(plotFileName)}`
    : null;

  const csvFileName = plotFileName
    ? plotFileName.replace("plot_enrich_", "enrich_").replace(".png", ".csv")
    : null;
  const csvSrc = csvFileName && taskId
    ? `/api/tasks/${taskId}/plot?name=${encodeURIComponent(csvFileName)}`
    : null;

  return (
    <div className="space-y-4">
      {/* 摘要 stats */}
      {stats && (
        <div className="flex flex-wrap gap-3 text-xs" style={{ color: "var(--clr-text-faint)" }}>
          <span>通路数据库：<strong style={{ color: "var(--clr-amber)" }}>{stats.pathway}</strong></span>
          {typeof stats.direction === "string" && <span>基因方向：<strong style={{ color: "var(--clr-text)" }}>{stats.direction}</strong></span>}
          <span>显著通路：<strong style={{ color: stats.significant_terms ? "var(--clr-amber)" : "var(--clr-text-faint)" }}>
            {stats.significant_terms ?? 0} 条
          </strong></span>
        </div>
      )}

      {/* R 原版 ggplot2 图（主展示） */}
      {plotSrc ? (
        <div className="space-y-2">
          <p className="text-xs font-medium" style={{ color: "var(--clr-amber-dark)" }}>
            富集分析图
            <span className="font-normal ml-1" style={{ color: "var(--clr-text-faint)" }}>
              — R ggplot2 原版输出（{stats?.pathway} {stats?.direction}）
            </span>
          </p>
          <div className="relative w-full">
            <AuthImg
              src={plotSrc}
              alt={`${stats?.pathway} ${stats?.direction} enrichment plot`}
              className="w-full rounded border"
              style={{ border: "1px solid var(--clr-border)", background: "#fff" }}
            />
            <div className="absolute bottom-3 right-3 flex gap-2">
              {csvSrc && (
                <AuthDownloadLink
                  url={csvSrc}
                  filename={csvFileName ?? "enrich_result.csv"}
                  className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg text-xs font-medium transition-all hover:scale-105"
                  style={{ background: "rgba(255,255,255,0.92)", boxShadow: "0 2px 8px rgba(0,0,0,0.10)", color: "var(--clr-amber-dark)" }}
                  title="下载表格数据 (CSV)"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                </AuthDownloadLink>
              )}
              <AuthDownloadLink
                url={plotSrc}
                filename={plotFileName ?? "enrich_plot.png"}
                className="inline-flex items-center justify-center w-9 h-9 rounded-lg transition-all hover:scale-105"
                style={{ background: "rgba(255,255,255,0.92)", boxShadow: "0 2px 8px rgba(0,0,0,0.10)", color: "var(--clr-amber)" }}
                title="下载图片"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </AuthDownloadLink>
            </div>
          </div>
        </div>
      ) : enrichData ? (
        /* PNG 不可用时 fallback 到 Plotly 气泡图 */
        <div>
          <p className="text-xs mb-2 font-medium" style={{ color: "var(--clr-amber-dark)" }}>
            富集气泡图
            <span className="font-normal ml-1" style={{ color: "var(--clr-text-faint)" }}>
              — {enrichData.terms.length} 个通路
            </span>
          </p>
          <EnrichBubble data={enrichData} title={`${stats?.pathway ?? "GO"} Enrichment (${stats?.direction ?? ""})`} />
        </div>
      ) : (
        <div className="callout text-xs">
          富集数据暂未返回（可能无显著通路，或需重新运行富集步骤以生成新格式数据）
        </div>
      )}
    </div>
  );
}


/** Marker 基因表达结果组件 (Step 7) */
/**
 * R/jsonlite 标量安全提取 —— plumber 默认将标量序列化为单元素数组
 * 例如 ["plot"] → "plot"，同时保留真正的数组。
 */
function unboxScalar<T>(v: unknown): T {
  return (Array.isArray(v) && v.length === 1 ? v[0] : v) as T;
}

function MarkerExprResult({ data, taskId, task }: { data: Record<string, unknown> | null; taskId?: string; task: Task }) {
  const phase     = unboxScalar<string | undefined>(data?.phase);
  const cellType  = unboxScalar<string | undefined>(data?.cell_type);
  const cellTypes = data?.cell_types as string[] | undefined;
  const markerTable = data?.marker_table as Array<{ CellType: string; Markers: string }> | undefined;
  const plotPath  = unboxScalar<string | undefined>(data?.plot_path);
  const archiveName = unboxScalar<string | undefined>(data?.archive_name);
  const nMarkers  = unboxScalar<number | undefined>(data?.n_markers);

  // Phase B 子 Tab 状态
  const [activeTab, setActiveTab] = useState<"plot" | "table">("plot");

  // 表格分页
  const ITEMS_PER_PAGE = 8;
  const [tablePage, setTablePage] = useState(0);
  const totalPages = markerTable ? Math.ceil(markerTable.length / ITEMS_PER_PAGE) : 0;
  const pagedRows  = markerTable
    ? markerTable.slice(tablePage * ITEMS_PER_PAGE, (tablePage + 1) * ITEMS_PER_PAGE)
    : [];

  // 图片 URL
  const plotFileName = plotPath ? plotPath.split("/").pop() : null;
  const plotSrc = plotFileName && taskId
    ? `/api/tasks/${taskId}/plot?name=${encodeURIComponent(plotFileName)}`
    : null;

  if (!data) {
    return <div className="callout text-xs">无结果数据</div>;
  }

  /* ── 通用表格渲染 ── */
  const renderTable = () => (
    markerTable && markerTable.length > 0 ? (
      <div>
        <p className="text-xs font-medium mb-2" style={{ color: "var(--clr-amber-dark)" }}>
          Marker 基因列表
          <span className="font-normal ml-1" style={{ color: "var(--clr-text-faint)" }}>
            — 共 {markerTable.length} 种细胞类型
          </span>
        </p>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", fontSize: "12px", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "6px 8px", background: "var(--clr-bg)", borderBottom: "1px solid var(--clr-border)", fontWeight: 600, color: "var(--clr-text-muted)" }}>
                  CellType
                </th>
                <th style={{ textAlign: "left", padding: "6px 8px", background: "var(--clr-bg)", borderBottom: "1px solid var(--clr-border)", fontWeight: 600, color: "var(--clr-text-muted)" }}>
                  Markers
                </th>
              </tr>
            </thead>
            <tbody>
              {pagedRows.map((row, i) => (
                <tr key={i} style={{ borderBottom: "1px solid var(--clr-border)" }}>
                  <td style={{ padding: "5px 8px", fontWeight: 500, color: "var(--clr-text)", whiteSpace: "nowrap" }}>
                    {row.CellType}
                  </td>
                  <td style={{ padding: "5px 8px", color: "var(--clr-text-faint)", wordBreak: "break-word" }}>
                    {row.Markers}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-2" style={{ fontSize: "11px", color: "var(--clr-text-faint)" }}>
            <span>第 {tablePage + 1} / {totalPages} 页</span>
            <div className="flex gap-2">
              <button
                disabled={tablePage === 0}
                onClick={() => setTablePage(p => p - 1)}
                className="px-2 py-0.5 rounded"
                style={{ border: "1px solid var(--clr-border)", opacity: tablePage === 0 ? 0.4 : 1 }}
              >
                上一页
              </button>
              <button
                disabled={tablePage >= totalPages - 1}
                onClick={() => setTablePage(p => p + 1)}
                className="px-2 py-0.5 rounded"
                style={{ border: "1px solid var(--clr-border)", opacity: tablePage >= totalPages - 1 ? 0.4 : 1 }}
              >
                下一页
              </button>
            </div>
          </div>
        )}
      </div>
    ) : null
  );

  return (
    <div className="space-y-4">
      {/* Phase A: 解析完成 — 直接显示表格 */}
      {phase === "parse" && (
        <>
          <div className="callout text-xs" style={{
            background: "rgba(22,163,74,0.05)",
            border: "1px solid rgba(22,163,74,0.15)",
          }}>
            <p style={{ color: "#15803d" }}>
              Marker 文件解析完成：共 <strong>{cellTypes?.length || 0}</strong> 种细胞类型。
              请在左侧选择细胞类型后点击「执行 Marker 表达」生成图片。
            </p>
          </div>
          {renderTable()}
        </>
      )}

      {/* Phase B: 绘图完成 — Tab 切换 */}
      {phase === "plot" && (
        <>
          {/* 状态提示 */}
          {cellType && (
            <div className="callout text-xs" style={{
              background: "rgba(22,163,74,0.05)",
              border: "1px solid rgba(22,163,74,0.15)",
            }}>
              <p style={{ color: "#15803d" }}>
                当前细胞类型: <strong>{cellType}</strong>，
                匹配到 <strong>{nMarkers}</strong> 个有效 Marker 基因
              </p>
            </div>
          )}

          {/* Tab 导航 */}
          <div className="flex gap-2">
            {([
              { id: "plot" as const, label: "表达图" },
              { id: "table" as const, label: "Marker 列表" },
            ]).map(t => (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className="px-3 py-1.5 rounded text-xs font-medium transition-all"
                style={activeTab === t.id
                  ? { background: "var(--clr-amber)", color: "#fff", boxShadow: "0 0 8px rgba(200,96,25,0.4)" }
                  : { background: "transparent", color: "var(--clr-text-muted)", border: "1px solid var(--clr-border)" }
                }
              >{t.label}</button>
            ))}
          </div>

          {/* Tab 内容 */}
          {activeTab === "plot" && plotSrc && taskId && (
            <div style={{
              position: "relative",
              maxWidth: (nMarkers ?? 4) <= 1 ? "50%" : (nMarkers ?? 4) <= 2 ? "65%" : (nMarkers ?? 4) <= 3 ? "80%" : "100%",
            }}>
              <p className="text-xs font-medium mb-2" style={{ color: "var(--clr-amber-dark)" }}>
                {cellType} — FeaturePlot + VlnPlot
              </p>
              <AuthImg
                src={plotSrc}
                alt={`Marker expression: ${cellType}`}
                style={{ width: "100%", borderRadius: 8, border: "1px solid var(--clr-border)" }}
              />
              {/* 下载按钮 */}
              <div style={{ position: "absolute", bottom: 8, right: 8, display: "flex", gap: 4 }}>
                <AuthDownloadLink
                  url={`/api/tasks/${taskId}/plot?name=${encodeURIComponent(plotFileName!)}`}
                  filename={archiveName ? archiveName.split('/').pop()! : (plotFileName || `marker_expr_${cellType}.png`)}
                  className="inline-flex items-center justify-center w-9 h-9 rounded-lg transition-all hover:scale-110"
                  style={{ background: "rgba(255,255,255,0.92)", boxShadow: "0 2px 8px rgba(0,0,0,0.10)", color: "var(--clr-amber)" }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                </AuthDownloadLink>
              </div>
            </div>
          )}

          {activeTab === "table" && renderTable()}
        </>
      )}
    </div>
  );
}


/* ===================================================
   通用步骤结果组件（Monocle / CellChat / inferCNV）
=================================================== */

/** WGCNA 结果组件 */
function WGCNAResult({ data, taskId }: { data: Record<string, unknown> | null; taskId?: string }) {
  if (!data) {
    return (
      <div className="text-center py-8" style={{ color: "var(--clr-text-faint)" }}>
        <p className="text-xs">结果数据为空</p>
      </div>
    );
  }

  const rawPlotPaths = data.plot_paths as Record<string, unknown> | undefined;
  const rawDataPaths = data.data_paths as Record<string, unknown> | undefined;
  const stats = data.stats as { cell_type?: string; soft_power?: number; n_modules?: number; n_hub_genes?: number } | undefined;

  const plotPaths = rawPlotPaths
    ? Object.fromEntries(Object.entries(rawPlotPaths).map(([k, v]) => [k, Array.isArray(v) ? String(v[0]) : String(v ?? '')]).filter(([, v]) => !!v))
    : undefined;
  const dataPaths = rawDataPaths
    ? Object.fromEntries(Object.entries(rawDataPaths).map(([k, v]) => [k, Array.isArray(v) ? String(v[0]) : String(v ?? '')]).filter(([, v]) => !!v))
    : undefined;

  const getFileName = (path: string) => path.split('/').pop() || path;
  const getDownloadUrl = (filePath: string) => {
    const fileName = getFileName(filePath);
    return `/api/tasks/${taskId}/plot?name=${encodeURIComponent(fileName)}`;
  };

  // 图表友好名称映射
  const formatPlotLabel = (filename: string) => {
    const labels: Record<string, string> = {
      'SoftPower': '软阈值选择',
      'Dendrogram': '模块树状图',
      'modules_kME': '模块 kME 排名',
      'modules_hMEs': '模块特征图',
      'modules_hMEs_DotPlot': '模块表达点图',
      'modules_cor': '模块相关性热图',
    };
    // 从 make_output_name 格式提取: proj_wgcna_时间戳_CellType_PlotType.ext
    // 或旧格式: CellType_PlotType.ext
    const nameOnly = filename.replace(/\.[^.]+$/, '');
    for (const [key, label] of Object.entries(labels)) {
      if (nameOnly.includes(key)) {
        // 提取 key 之前的部分作为细胞类型（跳过 proj_wgcna_ 时间戳前缀）
        const beforeKey = nameOnly.split(key)[0].replace(/_$/, '');
        // 去掉 proj_wgcna_YYYYMMDDHHMMSS_ 前缀，保留细胞类型
        const ct = beforeKey.replace(/^.*?_wgcna_\d{14}_/, '');
        return ct ? ct + ' — ' + label : label;
      }
    }
    // Fallback: 去掉所有前缀，保留可读名称
    const cleaned = nameOnly.replace(/^.*?_wgcna_\d{14}_/, '').replace(/_/g, ' ');
    return cleaned || nameOnly.replace(/_/g, ' ');
  };

  const plotEntries = plotPaths ? Object.entries(plotPaths) : [];
  const dataEntries = dataPaths ? Object.entries(dataPaths) : [];

  const [activeTab, setActiveTab] = React.useState<'plots' | 'data'>('plots');

  // 解析多细胞类型 stats
  const isMultiCell = stats && typeof Object.values(stats)[0] === 'object';
  const statEntries: { ct: string; soft_power: number; n_modules: number; n_hub_genes: number }[] = isMultiCell
    ? Object.entries(stats).map(([ct, s]) => ({ ct, ...(s as any) }))
    : [{ ct: (stats as any)?.cell_type || '—', soft_power: (stats as any)?.soft_power ?? 0, n_modules: (stats as any)?.n_modules ?? 0, n_hub_genes: (stats as any)?.n_hub_genes ?? 0 }];

  return (
    <div className="space-y-4">
      {/* 统计摘要卡片 — 每个细胞类型一组 */}
      {statEntries.map((s) => (
        <div key={s.ct}>
          <div className="text-xs font-bold mb-2 px-1" style={{ color: 'var(--clr-amber-dark)' }}>{s.ct}</div>
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: '软阈值', value: s.soft_power },
              { label: '基因模块数', value: s.n_modules },
              { label: 'Hub 基因数', value: s.n_hub_genes },
            ].map((item) => (
              <div key={item.label} className="px-3 py-2 rounded-lg border" style={{ borderColor: 'var(--clr-border)', background: 'var(--clr-bg-alt)' }}>
                <div className="text-[10px] font-medium mb-0.5" style={{ color: 'var(--clr-text-faint)' }}>{item.label}</div>
                <div className="text-sm font-bold" style={{ color: 'var(--clr-amber-dark)' }}>{item.value}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
      {statEntries.length > 1 && <div className="border-t" style={{ borderColor: 'var(--clr-border)' }} />}

      {/* Tab 切换 */}
      <div className="flex gap-1 p-0.5 rounded" style={{ background: 'var(--clr-bg-alt)' }}>
        {(['plots', 'data'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className="flex-1 px-3 py-1.5 rounded text-xs font-medium transition-all"
            style={activeTab === tab
              ? { background: 'var(--clr-bg-card)', color: 'var(--clr-amber-dark)', fontWeight: 600, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }
              : { color: 'var(--clr-text-muted)', cursor: 'pointer' }
            }
          >
            {tab === 'plots' ? `图表 (${plotEntries.length})` : `数据文件 (${dataEntries.length})`}
          </button>
        ))}
      </div>

      {/* 图表 Tab */}
      {activeTab === 'plots' && plotEntries.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {plotEntries.map(([name, path]) => (
            <div key={name} className="rounded-lg border overflow-hidden bg-white" style={{ borderColor: 'var(--clr-border)' }}>
              <div className="px-3 py-2 flex items-center justify-between" style={{ background: 'var(--clr-bg-alt)', borderBottom: '1px solid var(--clr-border)' }}>
                <span className="text-xs font-semibold" style={{ color: 'var(--clr-text)' }}>{formatPlotLabel(name)}</span>
                <AuthDownloadLink
                  url={getDownloadUrl(path)}
                  filename={getFileName(path)}
                  className="inline-flex items-center justify-center w-7 h-7 rounded transition-all hover:scale-110"
                  style={{ color: 'var(--clr-amber)' }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                </AuthDownloadLink>
              </div>
              <AuthImg
                src={getDownloadUrl(path)}
                alt={name}
                className="w-full h-auto"
                style={{ maxHeight: 450, objectFit: 'contain', background: 'white' }}
              />
            </div>
          ))}
        </div>
      )}

      {activeTab === 'plots' && plotEntries.length === 0 && (
        <div className="text-center py-8" style={{ color: 'var(--clr-text-faint)' }}>
          <p className="text-xs">暂无图表输出</p>
          <p className="text-[10px] mt-1">请确认 WGCNA 分析是否成功完成</p>
        </div>
      )}

      {/* 数据文件 Tab */}
      {activeTab === 'data' && dataEntries.length > 0 && (
        <div className="space-y-2">
          {dataEntries.map(([name, path]) => (
            <div key={name} className="flex items-center justify-between px-3 py-2.5 rounded-lg border" style={{ borderColor: 'var(--clr-border)', background: 'var(--clr-bg-alt)' }}>
              <div className="flex items-center gap-2 min-w-0">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--clr-text-faint)', flexShrink: 0 }}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                <span className="text-xs truncate" style={{ color: 'var(--clr-text)' }}>{getFileName(name)}</span>
                <span className="text-[10px] shrink-0" style={{ color: 'var(--clr-text-faint)' }}>{name.endsWith('.rds') ? 'RDS' : name.endsWith('.csv') ? 'CSV' : ''}</span>
              </div>
              <AuthDownloadLink
                url={getDownloadUrl(path)}
                filename={getFileName(path)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-all hover:scale-105 shrink-0"
                style={{ color: 'var(--clr-amber)', border: '1px solid var(--clr-border)' }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                下载
              </AuthDownloadLink>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'data' && dataEntries.length === 0 && (
        <div className="text-center py-8" style={{ color: 'var(--clr-text-faint)' }}>
          <p className="text-xs">暂无数据文件</p>
        </div>
      )}
    </div>
  );
}

function GenericStepResult({ data, stepId, taskId, task }: { data: Record<string, unknown> | null; stepId: string; taskId?: string; task?: Task }) {
  if (!data) {
    return (
      <div className="text-center py-8" style={{ color: "var(--clr-text-faint)" }}>
        <p className="text-xs">结果数据为空</p>
      </div>
    );
  }

  // R jsonlite 将单值包装为数组，需要解包
  const unwrap = (val: unknown): unknown => Array.isArray(val) && val.length === 1 ? val[0] : val;
  const unwrapStr = (val: unknown): string | undefined => {
    const v = unwrap(val);
    return typeof v === "string" ? v : undefined;
  };
  const unwrapNum = (val: unknown): number | undefined => {
    const v = unwrap(val);
    return typeof v === "number" ? v : undefined;
  };

  const stats = data.stats as Record<string, unknown> | undefined;
  const rawPlotPaths = data.plot_paths as Record<string, unknown> | undefined;
  const rawDataPaths = data.data_paths as Record<string, unknown> | undefined;
  // 解包每个值（R jsonlite 可能将字符串包装为单元素数组）
  const plotPaths = rawPlotPaths
    ? Object.fromEntries(Object.entries(rawPlotPaths).map(([k, v]) => [k, unwrapStr(v)]).filter(([, v]) => !!v))
    : undefined;
  const dataPaths = rawDataPaths
    ? Object.fromEntries(Object.entries(rawDataPaths).map(([k, v]) => [k, unwrapStr(v)]).filter(([, v]) => !!v))
    : undefined;
  const outdir = unwrapStr(data.outdir);

  const stepLabels: Record<string, string> = {
    wgcna: "WGCNA 分析",
    monocle: "拟时序分析",
    cellchat: "细胞通讯分析",
    infercnv: "拷贝数变异分析",
  };

  const [activeTab, setActiveTab] = useState<"plots" | "data">("plots");

  // ── CellChat 信号通路下拉：复用 cellchat_obj.rds 按需重出 4 张通路特异图 ──
  const pathways: string[] = Array.isArray(data.pathways)
    ? (data.pathways as unknown[]).map(v => (Array.isArray(v) ? v[0] : v)).map(String).filter(Boolean)
    : [];
  // 通路特异图的 key：只在下拉面板里展示，不在下方主网格重复出现
  const isPwSpecificKey = (k: string) => /^(pathway_heatmap|pathway_contribution|gene_vln|gene_dot)(_\d+)?$/.test(k);
  // run 已生成的默认通路(=pathways[0])那套通路特异图，作为下拉面板的初始内容
  const initialPwPlots = (plotPaths
    ? Object.fromEntries(Object.entries(plotPaths).filter(([k]) => isPwSpecificKey(k)))
    : {}) as Record<string, string>;
  const hasInitialPw = Object.keys(initialPwPlots).length > 0;
  const [pwSel, setPwSel] = useState<string>(pathways[0] ?? "");
  const [pwLoading, setPwLoading] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwTaskId, setPwTaskId] = useState<string | null>(hasInitialPw ? (taskId ?? null) : null);
  const [pwName, setPwName] = useState<string>(hasInitialPw ? (pathways[0] ?? "") : "");
  const [pwPlots, setPwPlots] = useState<Record<string, string> | null>(hasInitialPw ? initialPwPlots : null);
  // cellchat 主网格排除通路特异图（避免与上方下拉面板重复）；其它步骤不变
  const mainPlotEntries = plotPaths
    ? Object.entries(plotPaths).filter(([k]) => !(stepId === "cellchat" && pathways.length > 0 && isPwSpecificKey(k)))
    : [];

  const runPathway = async () => {
    if (!pwSel || !task) return;
    setPwLoading(true); setPwError(null);
    try {
      const res = await fetchWithAuth("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: task.project_id,
          step: "cellchat_pathway",
          params: { ...(task.params || {}), pathway: pwSel, cellchat_obj: dataPaths?.cellchat_obj },
        }),
      });
      const t = await res.json();
      if (!res.ok) {
        const d = (t as { detail?: unknown })?.detail;
        const msg = typeof d === "string" ? d
          : Array.isArray(d) ? d.map((x) => (x && typeof x === "object" && "msg" in x ? (x as { msg: string }).msg : JSON.stringify(x))).join("; ")
          : d ? JSON.stringify(d) : "提交失败";
        throw new Error(msg);
      }
      const poll = async (id: string): Promise<Record<string, unknown>> => {
        const r = await fetchWithAuth(`/api/tasks/${id}`);
        const fresh = await r.json();
        if (fresh.status === "failed") throw new Error(fresh.error_msg || "任务失败");
        if (fresh.status === "completed") return fresh;
        await new Promise(rs => setTimeout(rs, 2000));
        return poll(id);
      };
      await poll(t.id);
      const rRes = await fetchWithAuth(`/api/tasks/${t.id}/result`);
      const final = await rRes.json();
      const rawpp = final.plot_paths as Record<string, unknown> | undefined;
      const pp = rawpp
        ? Object.fromEntries(Object.entries(rawpp).map(([k, v]) => [k, unwrapStr(v)]).filter(([, v]) => !!v))
        : {};
      setPwTaskId(t.id);
      setPwName(pwSel);
      setPwPlots(pp as Record<string, string>);
    } catch (e) {
      setPwError(e instanceof Error ? e.message : String(e));
    } finally {
      setPwLoading(false);
    }
  };

  // 提取文件名
  const getFileName = (path: string) => path.split("/").pop() || path;

  // 构建下载 URL
  const getDownloadUrl = (filePath: string) => {
    const fileName = getFileName(filePath);
    return `/api/tasks/${taskId}/plot?name=${encodeURIComponent(fileName)}`;
  };

  return (
    <div className="space-y-4">
      {/* 统计摘要 */}
      {stats && (
        <div className="flex flex-wrap gap-3">
          {Object.entries(stats).map(([key, val]) => {
            const v = unwrap(val);
            return (
              <div key={key} className="px-3 py-2 rounded border" style={{ borderColor: "var(--clr-border)", background: "var(--clr-bg-alt)" }}>
                <div className="text-[10px] font-medium" style={{ color: "var(--clr-text-faint)" }}>{key.replace(/_/g, " ")}</div>
                <div className="text-sm font-semibold" style={{ color: "var(--clr-text)" }}>{String(v)}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* CellChat 信号通路下拉选择（仿差异基因按需出图） */}
      {stepId === "cellchat" && pathways.length > 0 && (
        <div className="rounded-lg border p-3 space-y-3" style={{ borderColor: "var(--clr-border)", background: "var(--clr-bg-alt)" }}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold" style={{ color: "var(--clr-text)" }}>信号通路</span>
            <select
              value={pwSel}
              onChange={e => setPwSel(e.target.value)}
              className="text-xs px-2 py-1.5 rounded border"
              style={{ borderColor: "var(--clr-border)", background: "var(--clr-bg-card)", color: "var(--clr-text)", minWidth: 160 }}
            >
              {pathways.map(pw => <option key={pw} value={pw}>{pw}</option>)}
            </select>
            <button
              onClick={runPathway}
              disabled={pwLoading || !pwSel}
              className="text-xs px-3 py-1.5 rounded font-medium transition-all disabled:opacity-50"
              style={{ background: "var(--clr-amber)", color: "white", cursor: pwLoading ? "default" : "pointer" }}
            >
              {pwLoading ? "生成中…" : "展示该通路"}
            </button>
            <span className="text-[10px]" style={{ color: "var(--clr-text-faint)" }}>
              共 {pathways.length} 条通路
            </span>
          </div>
          {pwError && <div className="text-xs" style={{ color: "#D24B40" }}>出错：{pwError}</div>}
          {pwPlots && Object.keys(pwPlots).length > 0 && (
            <div>
              <div className="text-[11px] mb-2" style={{ color: "var(--clr-text-muted)" }}>当前通路：<b>{pwName}</b></div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {Object.entries(pwPlots).map(([name, path]) => (
                  <div key={name} className="rounded-lg border overflow-hidden" style={{ borderColor: "var(--clr-border)" }}>
                    <div className="px-3 py-2 flex items-center justify-between" style={{ background: "var(--clr-bg-card)", borderBottom: "1px solid var(--clr-border)" }}>
                      <span className="text-xs font-medium" style={{ color: "var(--clr-text)" }}>{name.replace(/_/g, " ")}</span>
                      <AuthDownloadLink
                        url={`/api/tasks/${pwTaskId}/plot?name=${encodeURIComponent(getFileName(path))}`}
                        filename={getFileName(path)}
                        className="inline-flex items-center justify-center w-7 h-7 rounded transition-all hover:scale-110"
                        style={{ color: "var(--clr-amber)" }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                      </AuthDownloadLink>
                    </div>
                    <AuthImg
                      src={`/api/tasks/${pwTaskId}/plot?name=${encodeURIComponent(getFileName(path))}`}
                      alt={name}
                      className="w-full h-auto"
                      style={{ maxHeight: 400, objectFit: "contain", background: "white" }}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab 切换 */}
      <div className="flex gap-1 p-0.5 rounded" style={{ background: "var(--clr-bg-alt)" }}>
        {(["plots", "data"] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className="flex-1 px-3 py-1.5 rounded text-xs transition-all"
            style={activeTab === tab
              ? { background: "var(--clr-bg-card)", color: "var(--clr-amber-dark)", fontWeight: 600, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }
              : { color: "var(--clr-text-muted)", cursor: "pointer" }
            }
          >
            {tab === "plots" ? "图表" : "数据文件"}
          </button>
        ))}
      </div>

      {/* 图表 Tab */}
      {activeTab === "plots" && mainPlotEntries.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {mainPlotEntries.map(([name, path]) => (
            <div key={name} className="rounded-lg border overflow-hidden" style={{ borderColor: "var(--clr-border)" }}>
              <div className="px-3 py-2 flex items-center justify-between" style={{ background: "var(--clr-bg-alt)", borderBottom: "1px solid var(--clr-border)" }}>
                <span className="text-xs font-medium" style={{ color: "var(--clr-text)" }}>{name.replace(/_/g, " ")}</span>
                <AuthDownloadLink
                  url={getDownloadUrl(path)}
                  filename={getFileName(path)}
                  className="inline-flex items-center justify-center w-7 h-7 rounded transition-all hover:scale-110"
                  style={{ color: "var(--clr-amber)" }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                </AuthDownloadLink>
              </div>
              <AuthImg
                src={getDownloadUrl(path)}
                alt={name}
                className="w-full h-auto"
                style={{ maxHeight: 400, objectFit: "contain", background: "white" }}
              />
            </div>
          ))}
        </div>
      )}

      {activeTab === "plots" && mainPlotEntries.length === 0 && (
        <div className="text-center py-6" style={{ color: "var(--clr-text-faint)" }}>
          <p className="text-xs">无图表输出</p>
        </div>
      )}

      {/* 数据文件 Tab */}
      {activeTab === "data" && dataPaths && Object.keys(dataPaths).length > 0 && (
        <div className="space-y-2">
          {Object.entries(dataPaths).map(([name, path]) => (
            <div
              key={name}
              className="flex items-center justify-between px-3 py-2 rounded border"
              style={{ borderColor: "var(--clr-border)", background: "var(--clr-bg-alt)" }}
            >
              <div className="flex items-center gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--clr-text-muted)" strokeWidth="2" strokeLinecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                <span className="text-xs" style={{ color: "var(--clr-text)" }}>{name.replace(/_/g, " ")}</span>
                <span className="text-[10px]" style={{ color: "var(--clr-text-faint)", fontFamily: "var(--font-mono)" }}>{getFileName(path)}</span>
              </div>
              <AuthDownloadLink
                url={getDownloadUrl(path)}
                filename={getFileName(path)}
                className="inline-flex items-center justify-center w-7 h-7 rounded transition-all hover:scale-110"
                style={{ color: "var(--clr-amber)" }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </AuthDownloadLink>
            </div>
          ))}
        </div>
      )}

      {activeTab === "data" && (!dataPaths || Object.keys(dataPaths).length === 0) && (
        <div className="text-center py-6" style={{ color: "var(--clr-text-faint)" }}>
          <p className="text-xs">无数据文件输出</p>
        </div>
      )}

    </div>
  );
}
