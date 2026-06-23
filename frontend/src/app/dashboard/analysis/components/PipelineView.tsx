/**
 * Pipeline 全流程执行视图 — 双面板布局
 * 左侧：步骤导航目录（sticky 固定）
 * 右侧：结果展示区（固定高度，内部滚动）
 */
"use client";

import React, { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getPipeline, resumePipeline, type Pipeline, type PipelineTask } from "../../../lib/pipeline-api";
import { submitTask, hasPhase2Access, isGuest } from "../../../lib/api";
import { apiFetch } from "../../../lib/api";
import ProgressTracker from "../../../components/ProgressTracker";
import ResultViewer from "../../../components/ResultViewer";
import Phase2ParamPage from "./Phase2ParamPage";
import type { Task } from "../../../lib/api";
import {
  IconMicroscope, IconBarChart, IconAxis, IconCluster,
  IconTestTube, IconPathway, IconTag, IconBranch, IconNetwork, IconDNA,
} from "../../../components/Icons";

/* ===== Error Boundary — 防止 PipelineView 渲染崩溃 ===== */

interface EBState { hasError: boolean; message: string }
class PipelineErrorBoundary extends Component<{ children: ReactNode; onBack?: () => void }, EBState> {
  constructor(props: { children: ReactNode; onBack?: () => void }) {
    super(props);
    this.state = { hasError: false, message: "" };
  }
  static getDerivedStateFromError(err: Error) {
    return { hasError: true, message: err?.message ?? "未知错误" };
  }
  componentDidCatch() {}
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <div className="w-16 h-16 rounded-full flex items-center justify-center" style={{ background: "var(--clr-gold-soft)" }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--clr-amber)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold" style={{ color: "var(--clr-text)" }}>Pipeline 渲染出错</h2>
          <p className="text-sm" style={{ color: "var(--clr-text-muted)" }}>{this.state.message}</p>
          <div className="flex gap-3 mt-2">
            {this.props.onBack && (
              <button onClick={this.props.onBack} className="px-5 py-2 rounded-lg text-sm font-medium transition-all hover:opacity-90 cursor-pointer" style={{ border: "1px solid var(--clr-border)", background: "var(--clr-bg-alt)", color: "var(--clr-text)" }}>
                返回列表
              </button>
            )}
            <button onClick={() => this.setState({ hasError: false, message: "" })} className="px-5 py-2 rounded-lg text-sm font-medium text-white transition-all hover:opacity-90 cursor-pointer" style={{ background: "var(--clr-amber)" }}>
              重试
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const STEPS = [
  { id: "preprocess", num: 1, label: "数据预处理与标准化", desc: "质控过滤 · SCTransform", Icon: IconMicroscope, subSteps: ["qc", "normalize"] },
  { id: "reduce_cluster", num: 2, label: "降维与聚类", desc: "PCA · Harmony · UMAP", Icon: IconAxis, subSteps: ["reduce", "cluster"] },
  { id: "annotate", num: 3, label: "细胞注释", desc: "SingleR/手动", Icon: IconTag, subSteps: ["annotate"] },
  { id: "markers", num: 4, label: "差异基因", desc: "FindMarkers", Icon: IconTestTube, subSteps: ["markers"] },
  { id: "enrich", num: 5, label: "通路富集分析", desc: "GO / KEGG / GSEA", Icon: IconPathway, subSteps: ["enrich"] },
  { id: "monocle", num: 6, label: "拟时序分析", desc: "Monocle 2", Icon: IconBranch, subSteps: ["monocle"] },
  { id: "cellchat", num: 7, label: "细胞通讯", desc: "CellChat", Icon: IconNetwork, subSteps: ["cellchat"] },
  { id: "wgcna", num: 8, label: "WGCNA分析", desc: "加权基因共表达网络", Icon: IconNetwork, subSteps: ["wgcna"] },
  { id: "infercnv", num: 9, label: "拷贝数变异", desc: "inferCNV", Icon: IconDNA, subSteps: ["infercnv"] },
];

const STATUS_DOT: Record<string, string> = {
  pending: "bg-[#999]",
  running: "bg-[#C86019] animate-pulse",
  completed: "bg-[#2D8A56]",
  failed: "bg-[#B85450]",
  cancelled: "bg-[#B0AAA2]",
};

interface PipelineViewProps {
  pipelineId: string;
  token: string;
  projectName?: string;
}

export default function PipelineView({ pipelineId, token, projectName }: PipelineViewProps) {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState<string>("qc");
  // 用户手动选择步骤后，停止自动跳转到运行中步骤
  const userSelectedRef = useRef(false);

  // 拖拽调整面板宽度
  const startResize = () => { isResizing.current = true; };
  const stopResize = () => { isResizing.current = false; };
  const doResize = (e: MouseEvent) => {
    if (!isResizing.current) return;
    const newWidth = e.clientX - 32; // 减去左边距
    if (newWidth >= 180 && newWidth <= 400) {
      setSidebarWidth(newWidth);
    }
  };
  useEffect(() => {
    window.addEventListener("mousemove", doResize);
    window.addEventListener("mouseup", stopResize);
    const handleAnnotationUpdate = () => { getPipeline(token, pipelineId).then(setPipeline).catch(() => {}); };
    window.addEventListener("annotation-updated", handleAnnotationUpdate as any);
    return () => {
      window.removeEventListener("mousemove", doResize);
      window.removeEventListener("mouseup", stopResize);
    window.removeEventListener("annotation-updated", handleAnnotationUpdate as any);
    };
  }, []);
  // 降维与聚类步骤内的子 tab：默认显示聚类结果
  const [reduceClusterTab, setReduceClusterTab] = useState<"cluster" | "reduce">("reduce");
  // Phase 2 参数页显示状态
  const [showPhase2Param, setShowPhase2Param] = useState(false);
  const [showBackMenu, setShowBackMenu] = useState(false);
  useEffect(() => {
    if (!showBackMenu) return;
    const handler = () => setShowBackMenu(false);
    setTimeout(() => document.addEventListener("click", handler), 0);
    return () => document.removeEventListener("click", handler);
  }, [showBackMenu]);
  const [sidebarWidth, setSidebarWidth] = useState(224); // 左侧导航栏宽度，默认 224px (w-56)
  const isResizing = useRef(false);
  // 步骤失败对话框
  const [showFailDialog, setShowFailDialog] = useState(false);
  // 配额耗尽对话框
  const [showQuotaDialog, setShowQuotaDialog] = useState(false);
  const [showUpgradeDialog, setShowUpgradeDialog] = useState(false);
  const quotaDismissedRef = useRef(false);
  const [failStepInfo, setFailStepInfo] = useState<{ stepId: string; stepLabel: string; errorMsg: string; taskParams: Record<string, unknown> } | null>(null);
  // 避免重复弹出同一个失败对话框
  const dismissedFailsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    const fetch = async () => {
      try {
        const data = await getPipeline(token, pipelineId);
        setPipeline(data);
        setLoading(false);

        // 检测失败步骤，自动弹出对话框（未 dismissed 的）
        if (data.status === "failed" && data.error_step) {
          const failedStep = STEPS.find(s => s.subSteps.includes(data.error_step!));
          if (failedStep && !dismissedFailsRef.current.has(data.error_step)) {
            const failedTask = data.tasks.find(t => t.step === data.error_step);
            setFailStepInfo({
              stepId: data.error_step,
              stepLabel: failedStep.label,
              errorMsg: data.error_msg || failedTask?.error_msg || "未知错误",
              taskParams: failedTask?.params || {},
            });
            setShowFailDialog(true);
          }
        }

        // 检测配额耗尽暂停（只在首次检测到时弹出）
        if (data.status === "paused" && data.error_msg && data.error_msg.includes("操作配额使用结束") && !quotaDismissedRef.current) {
          setShowQuotaDialog(true);
          quotaDismissedRef.current = true;
        }

        // 自动选中：运行中步骤 > 最后一个已完成步骤 > 第一个步骤
        // 用户手动选择后停止自动跳转
        if (!userSelectedRef.current) {
        if (data.status === "running" && data.current_step) {
          const runningStep = STEPS.find(s => s.subSteps.includes(data.current_step!));
          if (runningStep) setActiveStep(runningStep.id);
        } else {
          const lastCompleted = [...STEPS].reverse().find(s => {
            return s.subSteps.some(id => {
              const t = data.tasks.find(tt => tt.step === id);
              return t?.status === "completed";
            });
          });
          if (lastCompleted) setActiveStep(lastCompleted.id);
        }
        }

        if (data.status === "running" || data.status === "pending" || data.status === "paused") {
          timer = setTimeout(fetch, 2000);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
        setLoading(false);
      }
    };

    fetch();
    return () => clearTimeout(timer);
  }, [pipelineId, token]);

  if (loading) {
    return (
      <div className="card p-4" style={{ textAlign: "center", color: "var(--clr-text-muted)" }}>
        <div className="text-xs">加载 Pipeline 状态中...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card p-4 border" style={{ borderColor: "var(--clr-danger)", background: "rgba(220, 53, 69, 0.05)" }}>
        <div className="text-xs font-semibold" style={{ color: "var(--clr-danger)" }}>错误</div>
        <div className="text-xs mt-1" style={{ color: "var(--clr-text-muted)" }}>{error}</div>
      </div>
    );
  }

  if (!pipeline) {
    return <div className="card p-4" style={{ color: "var(--clr-text-muted)" }}><div className="text-xs">Pipeline 未找到</div></div>;
  }

  const statusLabel = { pending: "待执行", running: "运行中", completed: "已完成", failed: "已失败", cancelled: "已取消", paused: "已暂停" }[pipeline.status] || "未知";
  const statusStyle = {
    pending:   { bg: "rgba(128,128,128,0.1)", color: "var(--clr-text-muted)" },
    running:   { bg: "rgba(200, 96, 25, 0.1)", color: "var(--clr-amber)" },
    completed: { bg: "rgba(45,138,86,0.1)", color: "#2D8A56" },
    failed:    { bg: "rgba(220,53,69,0.1)", color: "var(--clr-danger)" },
    cancelled: { bg: "rgba(128,128,128,0.1)", color: "var(--clr-text-muted)" },
    paused:    { bg: "rgba(59,130,246,0.1)", color: "#3b82f6" },
  }[pipeline.status] || {};

  // 构建 taskMap：同步骤多条记录时取最新的一条（按 created_at 时间）
  const taskMap = new Map<string, typeof pipeline.tasks[0]>();
  for (const t of pipeline.tasks) {
    const existing = taskMap.get(t.step);
    if (!existing || (t.created_at ?? "") > (existing.created_at ?? "")) {
      taskMap.set(t.step, t);
    }
  }
  const activeStepDef = STEPS.find(s => s.id === activeStep) ?? STEPS[0];

  // Phase 2 步骤是否已配置/执行
  const enabledPhase2 = (pipeline.params?.enabled_steps as string[]) || [];
  const hasPhase2Tasks = (pipeline.tasks || []).some(t => ["monocle", "cellchat", "infercnv", "wgcna"].includes(t.step));
  // 始终显示所有步骤
  const visibleSteps = STEPS;

  // 组合步骤状态：优先级 running > failed > pending > completed
  const getStepStatus = (stepId: string) => {
    const step = STEPS.find(s => s.id === stepId) ?? STEPS[0];
    const subSteps = step.subSteps;
    const statuses = subSteps.map(id => {
      // 仅当 pipeline 真在运行时 current_step 才算"运行中"; 取消/失败/暂停后取任务真实状态
      if (pipeline.current_step === id && pipeline.status === "running") return "running";
      return taskMap.get(id)?.status || "pending";
    });
    if (statuses.includes("running")) return "running";
    if (statuses.includes("cancelled")) return "cancelled";
    if (statuses.includes("failed")) return "failed";
    if (statuses.includes("pending")) return "pending";
    return "completed";
  };

  // 降维与聚类步骤的子 tab 状态
  const clusterTask = taskMap.get("cluster");
  const reduceTask = taskMap.get("reduce");
  const clusterStatus = (() => {
    if (pipeline.current_step === "cluster" && pipeline.status === "running") return "running";
    return clusterTask?.status || "pending";
  })();
  const reduceStatus = (() => {
    if (pipeline.current_step === "reduce" && pipeline.status === "running") return "running";
    return reduceTask?.status || "pending";
  })();
  const rcCurrentTask = reduceClusterTab === "cluster" ? clusterTask : reduceTask;
  const rcCurrentStatus = reduceClusterTab === "cluster" ? clusterStatus : reduceStatus;

  return (
    <PipelineErrorBoundary>
    <div className="animate-fade-in space-y-3">
      {/* 顶部栏：返回 + 状态 */}
      <div className="flex items-center justify-between">
        <div className="relative">
          <button
            className="px-3 py-1 text-sm rounded inline-flex items-center gap-1"
            style={{ border: "1px solid var(--clr-border)", background: "var(--clr-bg-alt)", cursor: "pointer" }}
            onClick={() => setShowBackMenu(!showBackMenu)}
          >
            ← 返回参数设置
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ transform: showBackMenu ? "rotate(180deg)" : "none" }}><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          {showBackMenu && (
            <div className="absolute top-full left-0 mt-1 w-56 rounded-lg shadow-lg border z-50"
              style={{ borderColor: "var(--clr-border)", background: "var(--clr-bg-card)" }}>
              <button
                className="w-full text-left px-4 py-2.5 text-sm rounded-t-lg hover:bg-[#fdf2e9] transition-colors"
                style={{ borderBottom: "1px solid var(--clr-border)", color: "var(--clr-text)" }}
                onClick={() => {
                  setShowBackMenu(false);
                  window.dispatchEvent(new CustomEvent("pipeline-back"));
                }}
              >
                重新设置 Phase 1
                <div className="text-xs mt-0.5" style={{ color: "var(--clr-text-muted)" }}>回到参数页，重新上传文件并运行全流程</div>
              </button>
              <button
                className="w-full text-left px-4 py-2.5 text-sm rounded-b-lg hover:bg-[#eff6ff] transition-colors"
                style={{ color: "var(--clr-text)" }}
                onClick={async () => {
                  setShowBackMenu(false);
                  if (pipeline.status === "running" || pipeline.status === "pending") {
                    try {
                      await apiFetch(`/api/pipeline/${pipelineId}/cancel`, { method: "POST" });
                      const data = await apiFetch(`/api/pipeline/${pipelineId}`);
                      setPipeline(data);
                    } catch {}
                  }
                  setShowPhase2Param(true);
                }}
              >
                重新设置 Phase 2
                <div className="text-xs mt-0.5" style={{ color: "var(--clr-text-muted)" }}>复用 Phase 1 结果，仅重新配置后续分析步骤</div>
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {(pipeline.status === "running" || pipeline.status === "pending") && (
            <button
              onClick={async () => {
                if (!confirm("确定要停止当前分析吗？已完成的步骤结果将保留。")) return;
                try {
                  await apiFetch(`/api/pipeline/${pipelineId}/cancel`, { method: "POST" });
                  const data = await getPipeline(token, pipelineId);
                  setPipeline(data);
                } catch (e) {
                  alert("停止失败: " + (e instanceof Error ? e.message : "未知错误"));
                }
              }}
              className="px-3 py-1 rounded text-xs font-medium"
              style={{ background: "var(--clr-danger)", color: "#fff", cursor: "pointer", border: "none" }}
            >
              停止分析
            </button>
          )}
          <div
            className="px-4 py-1.5 rounded text-sm font-semibold"
            style={{ background: statusStyle.bg, color: statusStyle.color }}
          >
            任务状态: {statusLabel}
          </div>
        </div>
      </div>

      {/* 运行中提示 */}
      {pipeline.status === "running" && (
        <div className="w-full rounded-lg border px-4 py-3" style={{ borderColor: "#fcd34d", background: "rgba(251,191,36,0.08)" }}>
          <div className="flex items-start gap-3 text-left">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round" className="shrink-0 mt-0.5"><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></svg>
            <span className="text-xs" style={{ color: "#92400e" }}>
              任务正在后台运行，刷新页面不会中断分析。完成后可在此查看结果并下载。
            </span>
          </div>
        </div>
      )}

      {/* 暂停提示 + 参数设置按钮 */}
      {(pipeline.status === "paused" || pipeline.status === "failed" || pipeline.status === "completed" || pipeline.status === "cancelled") && !showPhase2Param && pipeline.tasks.some(function(t) { return t.step === "annotate" && t.status === "completed"; }) && (
        <div className="w-full rounded-lg border px-4 py-3" style={{ borderColor: "#93c5fd", background: "rgba(59,130,246,0.05)" }}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-start gap-3 text-left">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" className="shrink-0 mt-0.5"><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></svg>
              <span className="text-xs" style={{ color: "#1e40af" }}>
                细胞注释已完成，请查看注释结果。确认无误后点击"设置后续分析参数"配置 Phase 2 分析。
              </span>
            </div>
            <button
              onClick={() => { if (!hasPhase2Access()) { setShowUpgradeDialog(true); } else { setShowPhase2Param(true); } }}
              className="px-4 py-1.5 text-sm rounded font-medium shrink-0"
              style={{ background: "#3b82f6", color: "white", cursor: "pointer" }}
            >
              设置后续分析参数
            </button>
          </div>
        </div>
      )}

      {/* Phase 2 参数选择页 */}
      {(pipeline.status === "paused" || pipeline.status === "failed" || pipeline.status === "completed" || pipeline.status === "cancelled") && showPhase2Param && pipeline.tasks.some(function(t) { return t.step === "annotate" && t.status === "completed"; }) && (
        <Phase2ParamPage
          pipeline={pipeline}
          token={token}
          species={pipeline.params?.annotate?.species as string || "Human"}
          onComplete={() => {
            setShowPhase2Param(false);
            getPipeline(token, pipelineId).then(setPipeline).catch(() => {});
          }}
        />
      )}

      {/* 双面板布局 */}
      <div className="flex gap-6">
        {/* ── 左侧导航（sticky 固定） ── */}
        <div className="shrink-0 space-y-1 sticky top-4 self-start" style={{ width: sidebarWidth }}>
          {visibleSteps.map((step) => {
            const st = getStepStatus(step.id);
            const isActive = activeStep === step.id;
            const dotCls = STATUS_DOT[st] || STATUS_DOT.pending;
            // Phase 2 步骤在 pipeline 暂停时也可点击（用于查看配置状态）
            const isPhase2 = ["monocle", "cellchat", "infercnv", "wgcna"].includes(step.subSteps[0]);
            const isClickable = st === "completed" || st === "running" || st === "failed" || (isPhase2 && pipeline.status === "paused");

            return (
              <button
                key={step.id}
                onClick={() => { if (isClickable) { userSelectedRef.current = true; setActiveStep(step.id); } }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded text-sm text-left transition-all duration-200"
                style={
                  isActive
                    ? { borderLeft: "3px solid var(--clr-amber)", color: "var(--clr-amber-dark)", background: "rgba(200,96,25,0.06)", fontWeight: 600 }
                    : { borderLeft: "3px solid transparent", color: isClickable ? "var(--clr-text-muted)" : "var(--clr-text-faint)", opacity: isClickable ? 1 : 0.5, cursor: isClickable ? "pointer" : "default" }
                }
              >
                <step.Icon size={18} className={isActive ? "text-[#C86019]" : "text-[#999]"} />
                <div className="flex-1 min-w-0">
                  <div>{step.num}. {step.label}</div>
                  <div className="text-xs" style={{ color: "var(--clr-text-faint)" }}>
                    {step.desc}
                  </div>
                </div>
                <div className={`w-2 h-2 rounded-full shrink-0 ${dotCls}`} />
              </button>
            );
          })}
        </div>

        {/* 拖拽条 */}
        <div
          onMouseDown={startResize}
          className="w-1 cursor-col-resize shrink-0 self-stretch opacity-0 hover:opacity-100 transition-opacity"
          style={{ background: "var(--clr-border)" }}
          title="拖拽调整面板宽度"
        />

        {/* ── 右侧内容区 ── */}
        <div className="flex-1 min-w-0">
          <div
            className="rounded-lg border overflow-hidden"
            style={{ borderColor: "var(--clr-border)", background: "var(--clr-bg-card)" }}
          >
            {/* 内容区头部 */}
            <div
              className="px-4 py-3 flex items-center justify-between"
              style={{ borderBottom: "1px solid var(--clr-border)", background: "var(--clr-bg-alt)" }}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold" style={{ color: "var(--clr-text)" }}>
                  {activeStepDef.num}. {activeStepDef.label}
                </span>
                {(() => {
                  const st = getStepStatus(activeStep);
                  const label = { completed: "已完成", running: "运行中", failed: "已失败", pending: "待执行", cancelled: "已取消" }[st] || "";
                  const color = { completed: "#2D8A56", running: "var(--clr-amber)", failed: "var(--clr-danger)", pending: "var(--clr-text-muted)", cancelled: "var(--clr-text-muted)" }[st] || "";
                  return <span className="text-xs" style={{ color }}>{label}</span>;
                })()}
              </div>
              {pipeline.error_msg && activeStepDef.subSteps.includes(pipeline.error_step || "") && (
                <span className="text-xs" style={{ color: "var(--clr-danger)" }}>{pipeline.error_msg}</span>
              )}
            </div>

            {/* 内容区主体 */}
            <div className="p-4 space-y-6">
              {/* 降维与聚类步骤：tab 切换 */}
              {activeStep === "reduce_cluster" && (
                <div className="space-y-4">
                  {/* Tab 栏 */}
                  <div className="flex gap-1 p-0.5 rounded" style={{ background: "var(--clr-bg-alt)" }}>
                    {[
                      { key: "reduce" as const, label: "数据降维", status: reduceStatus },
{ key: "cluster" as const, label: "批次聚类", status: clusterStatus },
                    ].map((tab) => (
                      <button
                        key={tab.key}
                        onClick={() => setReduceClusterTab(tab.key)}
                        className="flex-1 flex items-center justify-center gap-2 px-3 py-1.5 rounded text-xs transition-all duration-200"
                        style={reduceClusterTab === tab.key
                          ? { background: "var(--clr-bg-card)", color: "var(--clr-amber-dark)", fontWeight: 600, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }
                          : { color: "var(--clr-text-muted)", cursor: "pointer" }
                        }
                      >
                        {tab.label}
                        <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[tab.status] || STATUS_DOT.pending}`} />
                      </button>
                    ))}
                  </div>

                  {/* Tab 内容 */}
                  {rcCurrentStatus === "running" && rcCurrentTask && (
                    <ProgressTracker
                      taskId={rcCurrentTask.id}
                      onMessage={() => {}}
                      onProgress={() => {}}
                      onComplete={() => { getPipeline(token, pipelineId).then(setPipeline).catch(() => {}); }}
                    />
                  )}

                  {rcCurrentStatus === "completed" && rcCurrentTask && (
                    <ResultViewer
                      projectName={projectName}
                      stepId={reduceClusterTab}
                      task={{
                        id: rcCurrentTask.id,
                        step: rcCurrentTask.step,
                        status: rcCurrentTask.status,
                        params: {},
                        progress: 100,
                        result_path: rcCurrentTask.result_path,
                        result: null,
                        project_id: pipeline.project_id,
                      } as Task}
                      token={token}
                    />
                  )}

                  {rcCurrentStatus === "failed" && rcCurrentTask && (
                    <div className="text-center py-8">
                      <div className="w-10 h-10 mx-auto mb-3 rounded-full flex items-center justify-center" style={{ background: "#FFF3F3", color: "var(--clr-danger)" }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                      </div>
                      <p className="text-xs font-medium mb-1" style={{ color: "var(--clr-danger)" }}>{reduceClusterTab === "cluster" ? "批次聚类" : "数据降维"}执行失败</p>
                      <div className="text-xs" style={{ color: "var(--clr-text-muted)" }}>{rcCurrentTask.error_msg || "未知错误"}</div>
                      <button
                        onClick={async () => {
                          try {
                            await submitTask({
                              project_id: pipeline.project_id,
                              step: reduceClusterTab,
                              params: rcCurrentTask.params || {},
                            });
                            const data = await getPipeline(token, pipelineId);
                            setPipeline(data);
                          } catch (e) {
                            alert("重新运行失败: " + (e instanceof Error ? e.message : "未知错误"));
                          }
                        }}
                        className="mt-3 px-4 py-1.5 rounded text-xs font-medium text-white"
                        style={{ background: "var(--clr-amber)", cursor: "pointer", border: "none" }}
                      >
                        重新运行
                      </button>
                    </div>
                  )}

                  {rcCurrentStatus === "cancelled" && (
                    <div className="text-center py-8" style={{ color: "var(--clr-text-muted)" }}>
                      <p className="text-xs">该步骤已取消</p>
                    </div>
                  )}

                  {rcCurrentStatus === "pending" && (
                    <div className="text-center py-8" style={{ color: "var(--clr-text-faint)" }}>
                      <p className="text-xs">等待执行</p>
                    </div>
                  )}
                </div>
              )}

              {/* 其他步骤：按 subSteps 顺序展示 */}
              {activeStep !== "reduce_cluster" && activeStepDef.subSteps.map((subId) => {
                const subTask = taskMap.get(subId);
                const subLabel = { qc: "数据预处理", normalize: "数据标准化" }[subId] || subId;
                const subStatus = (() => {
                  if (subTask?.status === "failed") return "failed";
                  if (subTask?.status === "completed") return "completed";
                  if (subTask?.status === "cancelled") return "cancelled";
                  if (pipeline.current_step === subId && pipeline.status === "running") return "running";
                  return "pending";
                })();

                return (
                  <div key={subId}>
                    {activeStepDef.subSteps.length > 1 && (
                      <div className="flex items-center gap-2 mb-3">
                        <span className="text-xs font-semibold" style={{ color: "var(--clr-amber-dark)" }}>{subLabel}</span>
                        <span className="text-[10px]" style={{ color: { completed: "#2D8A56", running: "var(--clr-amber)", failed: "var(--clr-danger)", pending: "var(--clr-text-muted)", cancelled: "var(--clr-text-muted)" }[subStatus] || "" }}>
                          {{ completed: "已完成", running: "运行中", failed: "已失败", pending: "待执行", cancelled: "已取消" }[subStatus] || ""}
                        </span>
                      </div>
                    )}

                    {/* 运行中 */}
                    {subStatus === "running" && subTask && (
                      <ProgressTracker
                        taskId={subTask.id}
                        stepLabel={subLabel}
                        onComplete={() => { getPipeline(token, pipelineId).then(setPipeline).catch(() => {}); }}
                        onError={() => { getPipeline(token, pipelineId).then(setPipeline).catch(() => {}); }}
                      />
                    )}

                    {/* 运行中但任务记录尚未创建（如 DB 枚举限制导致写入失败） */}
                    {subStatus === "running" && !subTask && (
                      <div className="space-y-3 animate-fade-in">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-[#C86019] animate-pulse"></div>
                            <span className="text-sm font-medium" style={{ color: "var(--clr-dark)" }}>{subLabel}</span>
                          </div>
                          <span className="text-xs" style={{ fontFamily: "var(--font-mono)", color: "var(--clr-text-muted)" }}>
                            0%
                          </span>
                        </div>
                        <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--clr-border)" }}>
                          <div className="h-full rounded-full bg-gradient-to-r from-[#C86019] to-[#E07828] transition-all duration-500" style={{ width: "2%" }} />
                        </div>
                        <p className="text-xs" style={{ color: "var(--clr-text-muted)" }}>正在初始化...</p>
                      </div>
                    )}

                    {/* 已取消 */}
                    {subStatus === "cancelled" && (
                      <div className="text-center py-8" style={{ color: "var(--clr-text-muted)" }}>
                        <p className="text-xs">该步骤已取消</p>
                      </div>
                    )}

                    {/* 已完成 */}
                    {subStatus === "completed" && subTask && (
                      <ResultViewer
                        projectName={projectName}
                        stepId={subId}
                        task={{
                          id: subTask.id,
                          step: subTask.step,
                          status: subTask.status,
                          params: {},
                          progress: 100,
                          result_path: subTask.result_path,
                          result: null,
                          project_id: pipeline.project_id,
                        } as Task}
                        token={token}
                      />
                    )}

                    {/* 失败 */}
                    {subStatus === "failed" && subTask && (
                      <div className="text-center py-8">
                        <div className="w-10 h-10 mx-auto mb-3 rounded-full flex items-center justify-center" style={{ background: "#FFF3F3", color: "var(--clr-danger)" }}>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                        </div>
                        <p className="text-xs font-medium mb-1" style={{ color: "var(--clr-danger)" }}>{subLabel}执行失败</p>
                        <div className="text-xs" style={{ color: "var(--clr-text-muted)" }}>{subTask.error_msg || "未知错误"}</div>
                        <button
                          onClick={async () => {
                            try {
                              if (!pipeline.project_id) {
                                alert("项目ID不存在，无法重新运行");
                                return;
                              }
                              const result = await submitTask({
                                project_id: pipeline.project_id,
                                step: subId,
                                params: subTask.params || {},
                              });
                              console.log("重新运行成功:", result);
                              const data = await getPipeline(token, pipelineId);
                              setPipeline(data);
                            } catch (e) {
                              console.error("重新运行失败:", e);
                              alert("重新运行失败: " + (e instanceof Error ? e.message : "未知错误"));
                            }
                          }}
                          className="mt-3 px-4 py-1.5 rounded text-xs font-medium text-white"
                          style={{ background: "var(--clr-amber)", cursor: "pointer", border: "none" }}
                        >
                          重新运行
                        </button>
                      </div>
                    )}

                    {/* 待执行 */}
                    {subStatus === "pending" && (
                      <div className="text-center py-8" style={{ color: "var(--clr-text-faint)" }}>
                        <p className="text-xs">等待执行</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      {/* 步骤失败对话框 */}
      {showFailDialog && failStepInfo && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* 背景遮罩 */}
          <div
            className="absolute inset-0"
            style={{ background: "rgba(0,0,0,0.35)" }}
            onClick={() => {
              dismissedFailsRef.current.add(failStepInfo.stepId);
              setShowFailDialog(false);
            }}
          />
          {/* 对话框内容 */}
          <div
            className="relative w-full max-w-md rounded-xl shadow-2xl p-6"
            style={{
              background: "var(--clr-bg-card)",
              border: "1px solid var(--clr-border)",
            }}
          >
            {/* 标题 */}
            <div className="flex items-center gap-3 mb-4"
            >
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
                style={{ background: "#FFF3F3", color: "var(--clr-danger)" }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </div>
              <div>
                <h3
                  className="text-base font-bold"
                  style={{ fontFamily: "var(--font-serif)", color: "var(--clr-dark-deep)" }}
                >
                  步骤执行失败
                </h3>
                <p className="text-xs mt-0.5" style={{ color: "var(--clr-text-muted)" }}
                >
                  {failStepInfo.stepLabel}
                </p>
              </div>
            </div>

            {/* 错误信息 */}
            <div
              className="mb-5 px-3 py-2.5 rounded-lg text-sm break-all"
              style={{
                background: "rgba(220, 53, 69, 0.05)",
                border: "1px solid rgba(220, 53, 69, 0.15)",
                color: "var(--clr-danger)",
              }}
            >
              {failStepInfo.errorMsg}
            </div>

            {/* 按钮 */}
            <div className="flex gap-3"
            >
              <button
                onClick={() => {
                  dismissedFailsRef.current.add(failStepInfo.stepId);
                  setShowFailDialog(false);
                }}
                className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-all"
                style={{
                  border: "1px solid var(--clr-border)",
                  color: "var(--clr-text-muted)",
                  background: "var(--clr-bg-alt)",
                  cursor: "pointer",
                }}
              >
                确定
              </button>
              <button
                onClick={async () => {
                  dismissedFailsRef.current.add(failStepInfo.stepId);
                  setShowFailDialog(false);
                  try {
                    await submitTask({
                      project_id: pipeline!.project_id,
                      step: failStepInfo.stepId,
                      params: failStepInfo.taskParams,
                    });
                    const refreshed = await getPipeline(token, pipelineId);
                    setPipeline(refreshed);
                  } catch (e) {
                    alert("重新运行失败: " + (e instanceof Error ? e.message : "未知错误"));
                  }
                }}
                className="flex-1 px-4 py-2.5 rounded-lg text-sm font-semibold text-white transition-all"
                style={{
                  background: "var(--clr-amber)",
                  cursor: "pointer",
                  border: "none",
                }}
              >
                重新运行
              </button>
              <button
                onClick={() => {
                  dismissedFailsRef.current.add(failStepInfo.stepId);
                  setShowFailDialog(false);
                  setShowPhase2Param(true);
                }}
                className="flex-1 px-4 py-2.5 rounded-lg text-sm font-semibold text-white transition-all"
                style={{
                  background: "#3b82f6",
                  cursor: "pointer",
                  border: "none",
                }}
              >
                重新配置 Phase 2
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {/* 配额耗尽对话框 */}
      {showQuotaDialog && createPortal(
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.35)" }} onClick={() => setShowQuotaDialog(false)} />
          <div className="relative w-full max-w-md rounded-xl shadow-2xl p-6" style={{ background: "var(--clr-bg-card)", border: "1px solid var(--clr-border)" }}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "rgba(220,53,69,0.1)" }}>
                <svg className="w-5 h-5" style={{ color: "var(--clr-danger)" }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold" style={{ color: "var(--clr-text)" }}>操作配额已用完</h3>
            </div>
            <p className="text-sm mb-4" style={{ color: "var(--clr-text-secondary)" }}>
              操作配额使用结束，无法继续进行。如需继续分析，请联系管理员增加配额。
            </p>
            <div className="flex justify-end">
              <button
                onClick={() => setShowQuotaDialog(false)}
                className="px-4 py-2 text-sm font-medium rounded-lg cursor-pointer"
                style={{ background: "var(--clr-amber)", color: "#fff" }}
              >
                知道了
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {/* Phase 2 升级提示对话框 */}
      {showUpgradeDialog && createPortal(
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.35)" }} onClick={() => setShowUpgradeDialog(false)} />
          <div className="relative w-full max-w-md rounded-xl shadow-2xl p-6" style={{ background: "var(--clr-bg-card)", border: "1px solid var(--clr-border)" }}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "rgba(200,96,25,0.1)" }}>
                <svg className="w-5 h-5" style={{ color: "var(--clr-amber)" }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold" style={{ color: "var(--clr-text)" }}>权限不足</h3>
            </div>
            <p className="text-sm mb-4" style={{ color: "var(--clr-text-secondary)" }}>
              Phase 2 分析需更高权限，请联系管理员进行升级。
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowUpgradeDialog(false)}
                className="px-4 py-2 text-sm font-medium rounded-lg cursor-pointer"
                style={{ background: "var(--clr-bg-alt)", color: "var(--clr-text)", border: "1px solid var(--clr-border)" }}
              >
                确定
              </button>
              <button
                onClick={() => { setShowUpgradeDialog(false); }}
                className="px-4 py-2 text-sm font-medium rounded-lg cursor-pointer"
                style={{ background: "var(--clr-amber)", color: "#fff" }}
              >
                退出
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
    </PipelineErrorBoundary>
  );
}
