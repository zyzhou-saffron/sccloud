/**
 * scCloud v2 — Step 8 细胞注释 (Annotate) 结果展示组件
 */
"use client";

import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { submitTask, getTask, apiFetch, updateTaskResult, type Task, getAuthToken} from "../lib/api";
import DeckScatterPlot from "./charts/DeckScatterPlot";
import type { ScatterData } from "./charts/ScatterPlot";
import GeneExpressionPopup from "./GeneExpressionPopup";

function getToken() {
  if (typeof window !== "undefined") {
    return getAuthToken() || "";
  }
  return "";
}

function AuthImg({ src, alt, token, className, style }: {
  src: string | null;
  alt: string;
  token?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [isPdf, setIsPdf] = useState(false);

  useEffect(() => {
    if (!src) return;
    let objectUrl = "";
    setFailed(false);
    setBlobUrl(null);
    const authToken = token || getToken();
    fetch(src, { headers: { Authorization: `Bearer ${authToken}` } })
      .then((r) => { if (!r.ok) throw new Error(`${r.status}`); const ct = r.headers.get("content-type") || ""; return r.blob().then(blob => ({ blob, isPdf: ct.includes("pdf") })); })
      .then(({ blob, isPdf: pdf }) => { objectUrl = URL.createObjectURL(blob); setBlobUrl(objectUrl); setIsPdf(pdf); })
      .catch(() => setFailed(true));
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [src, token]);

  if (failed) return <div className={className} style={style}>Failed to load image</div>;
  if (!blobUrl) return <div className={className} style={style} />;
  if (isPdf) {
    return <embed src={blobUrl} type="application/pdf" className={className} style={{ ...style, width: "100%", minHeight: 600 }} />;
  }

  return <img src={blobUrl} alt={alt} className={className} style={style} />;
}

interface MarkerTableRow {
  cluster_id: string;
  celltype: string;
  markers: string[];
  annotation_result?: string;
  original_celltype?: string;
}

interface AnnotateData {
  status: string;
  result_path?: string;
  plot_path?: string;
  plot_download_path?: string;
  scatter_data?: { x: number[]; y: number[]; cluster: string[]; celltype?: string[] };
  stats?: {
    cells: number;
    cell_types: number;
    anno_type: string;
    species?: string;
    tissue?: string;
  };
  freq_table?: Array<{ CellType: string; Sample?: string; Freq?: number; n?: number; pct?: number }>;
  marker_table?: MarkerTableRow[];
}

function safeScatter(raw: unknown): ScatterData | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const x = (r.x ?? r.X) as number[] | undefined;
  const y = (r.y ?? r.Y) as number[] | undefined;
  const cluster = (r.cluster ?? r.Cluster ?? r.label) as string[] | undefined;
  if (!Array.isArray(x) || !Array.isArray(y)) return undefined;
  return {
    x,
    y,
    cluster: Array.isArray(cluster) ? cluster : x.map(() => "0"),
    celltype: Array.isArray(r.celltype) ? r.celltype as string[] : undefined,
    sample: Array.isArray(r.sample) ? r.sample as string[] : undefined,
    group: Array.isArray(r.group) ? r.group as string[] : undefined,
  };
}

export default function AnnotateResult({
  data,
  task,
  token,
}: {
  data: Record<string, unknown> | null;
  task: Task;
  token?: string;
}) {
  const taskId = task.id;
  const annotateData = data as AnnotateData | null;

  const stats = annotateData?.stats;
  const rawScatter = useMemo(() => safeScatter(annotateData?.scatter_data), [annotateData]);

  // ── 本地状态（合并后可更新） ──
  const [localScatter, setLocalScatter] = useState<ScatterData | undefined>(rawScatter);
  const [markerTable, setMarkerTable] = useState<MarkerTableRow[]>(annotateData?.marker_table ?? []);

  // 当原始数据变化时重置本地状态
  useEffect(() => {
    setLocalScatter(rawScatter);
    setMarkerTable(annotateData?.marker_table ?? []);
  }, [rawScatter, annotateData?.marker_table]);

  // 编辑中的 annotation_result 值
  const [editedResults, setEditedResults] = useState<Record<string, string>>({});

  // ── 基因表达查询 ──
  const [geneQueryInputs, setGeneQueryInputs] = useState<Record<string, string>>({});
  const [showMarkerPanel, setShowMarkerPanel] = useState<Record<string, boolean>>({});
  const [expandedMarkers, setExpandedMarkers] = useState<Record<string, boolean>>({});

  // ── 合并模式状态 ──
  const [mergeMode, setMergeMode] = useState(false);
  const [selectedForMerge, setSelectedForMerge] = useState<Set<string>>(new Set());
  const [mergeTargetName, setMergeTargetName] = useState("");
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [currentColorBy, setCurrentColorBy] = useState("celltype");
  // 表格点击的高亮类型："cluster" | "celltype" | null
  const [tableHighlightType, setTableHighlightType] = useState<"cluster" | "celltype" | null>(null);

  // ── 手动注释文件上传 ──
  const [uploadAnnotating, setUploadAnnotating] = useState(false);
  const [uploadAnnotateMsg, setUploadAnnotateMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const displayScatter = localScatter ?? rawScatter;

  const handleAnnotateFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadAnnotating(true);
    setUploadAnnotateMsg(null);
    try {
      const text = await file.text();
      const lines = text.trim().split(/\r?\n/);
      if (lines.length < 2) throw new Error("文件至少需要包含表头和数据行");
      const sep = lines[0].includes("\t") ? "\t" : ",";
      const headers = lines[0].split(sep).map((h: string) => h.trim().toLowerCase());
      const clusterIdx = headers.indexOf("cluster_id") >= 0 ? headers.indexOf("cluster_id") : headers.indexOf("cluster");
      const celltypeIdx = headers.indexOf("celltype");
      if (clusterIdx < 0) throw new Error("缺少 cluster 列（需含 cluster 或 cluster_id, celltype 列）");
      const mapping: Record<string, string> = {};
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(sep);
        const cid = cols[clusterIdx]?.trim();
        const ct = celltypeIdx >= 0 ? cols[celltypeIdx]?.trim() : "";
        if (cid && ct) mapping[cid] = ct;
      }
      const count = Object.keys(mapping).length;
      if (count === 0) throw new Error("未解析到有效的注释数据");
      // 更新 markerTable
      const newTable = markerTable.map((row: MarkerTableRow) =>
        mapping[row.cluster_id] ? { ...row, celltype: mapping[row.cluster_id] } : row
      );
      setMarkerTable(newTable);
      // 更新 scatter_data celltype
      let updatedCelltype: string[] | undefined;
      const scatter = displayScatter;
      if (scatter?.celltype && scatter?.cluster) {
        updatedCelltype = scatter.celltype.map((ct: string, i: number) => {
          const cid = scatter.cluster[i];
          return mapping[cid] || ct;
        });
        setLocalScatter({ ...scatter, celltype: updatedCelltype });
      }
      // 持久化
      const updatePayload: Record<string, unknown> = { marker_table: newTable };
      if (updatedCelltype && annotateData?.scatter_data) {
        updatePayload.scatter_data = { ...(annotateData.scatter_data as Record<string, unknown>), celltype: updatedCelltype };
      }
      await updateTaskResult(taskId, updatePayload);
      window.dispatchEvent(new CustomEvent("annotation-updated"));
      setUploadAnnotateMsg(`成功更新 ${count} 个聚类的注释`);
    } catch (err) {
      setUploadAnnotateMsg(err instanceof Error ? err.message : "上传失败");
    } finally {
      setUploadAnnotating(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [markerTable, displayScatter, taskId, annotateData?.scatter_data]);

  // ── 基因表达弹窗状态（hover 触发，跟随鼠标） ──
  const [activeGene, setActiveGene] = useState<string | null>(null);
  const [activeCellType, setActiveCellType] = useState<string | null>(null);
  const [geneMousePos, setGeneMousePos] = useState<{ x: number; y: number } | null>(null);
  const geneCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const genePopupHovered = useRef(false);

  const openGenePopup = (gene: string, celltype: string, e: React.MouseEvent) => {
    if (geneCloseTimer.current) { clearTimeout(geneCloseTimer.current); geneCloseTimer.current = null; }
    setActiveGene(gene);
    setActiveCellType(celltype);
    setGeneMousePos({ x: e.clientX, y: e.clientY });
  };
  const scheduleCloseGenePopup = () => {
    geneCloseTimer.current = setTimeout(() => {
      if (!genePopupHovered.current) {
        setActiveGene(null);
        setActiveCellType(null);
        setGeneMousePos(null);
      }
    }, 200);
  };

  // 图例维度：表格选中 cluster → 显示 cluster，表格选中 celltype → 显示 celltype
  const deckColorBy = tableHighlightType ?? (mergeMode ? "cluster" : undefined);
  const deckMergeIdKey = tableHighlightType ?? "celltype";

  // 切换分类维度时清空合并选区
  useEffect(() => {
    setSelectedForMerge(new Set());
    setMergeTargetName("");
  }, [currentColorBy]);

  // ── 图片 URL 构建 ──
  const extractName = (val: unknown) => {
    if (typeof val === "string") return val.split("/").pop();
    if (Array.isArray(val) && typeof val[0] === "string")
      return (val[0] as string).split("/").pop();
    return null;
  };
  const plotName = extractName(annotateData?.plot_path) ?? "plot_annotate.png";
  const plotDownloadName = extractName(annotateData?.plot_download_path) ?? plotName;
  const plotSrc = taskId ? `/api/tasks/${taskId}/plot?name=${encodeURIComponent(plotName)}` : null;
  const plotDownloadSrc = taskId ? `/api/tasks/${taskId}/plot?name=${encodeURIComponent(plotDownloadName)}` : null;

  // ── Marker 表格分页 ──
  const [markerPage, setMarkerPage] = useState(0);
  const pageSize = 10;
  const markerPageData = markerTable.slice(markerPage * pageSize, (markerPage + 1) * pageSize);
  const markerTotalPages = Math.ceil(markerTable.length / pageSize);

  // ── 细胞类型占比表（CellType × Sample pivot） ──
  const freqRaw = annotateData?.freq_table ?? [];
  const [freqPage, setFreqPage] = useState(0);
  const freqPageSize = 15;
  const { freqHeaders, freqRows } = useMemo(() => {
    if (!freqRaw.length) return { freqHeaders: [] as string[], freqRows: [] as { celltype: string; [k: string]: string | number }[] };
    const samples = Array.from(new Set(freqRaw.map(r => r.Sample ?? "").filter(Boolean)));
    const ctMap: Record<string, Record<string, number>> = {};
    for (const r of freqRaw) {
      const ct = r.CellType ?? "";
      const s = r.Sample ?? "";
      const f = r.Freq ?? 0;
      if (!ctMap[ct]) ctMap[ct] = {};
      ctMap[ct][s] = f;
    }
    const rows = Object.entries(ctMap).map(([ct, sMap]) => {
      const row: { celltype: string; [k: string]: string | number } = { celltype: ct };
      for (const s of samples) {
        row[s] = sMap[s] !== undefined ? (sMap[s] * 100).toFixed(2) + "%" : "—";
      }
      return row;
    });
    return { freqHeaders: samples, freqRows: rows };
  }, [freqRaw]);
  const freqTotalPages = Math.ceil(freqRows.length / freqPageSize);
  const freqPageData = freqRows.slice(freqPage * freqPageSize, (freqPage + 1) * freqPageSize);

  // 重置编辑状态（合并模式退出时）
  useEffect(() => {
    if (!mergeMode) {
      setEditedResults({});
      setTableHighlightType(null);
      setSelectedForMerge(new Set());
    }
  }, [mergeMode]);

  // ── 合并处理（直接更新本地状态 + 持久化到后端，不经过 R engine） ──
  const handleMerge = useCallback(async () => {
    if (selectedForMerge.size < 2 || !mergeTargetName.trim()) return;
    setMerging(true);
    setMergeError(null);

    // 构建 merge_map: celltype -> target
    const merge_map: Record<string, string> = {};
    const target = mergeTargetName.trim();

    // tableHighlightType 为 null 时(点 UMAP 图例/点选择), selectedForMerge 里是 celltype 名
    // (deckMergeIdKey 默认 "celltype"), 应走 celltype 分支; 只有显式 "cluster" 才按簇 id 映射。
    // 用显式 allowlist(celltype/null) 而非 !== "cluster", 防日后新增第三种类型时误落 celltype 分支。
    if (tableHighlightType === "celltype" || tableHighlightType === null) {
      for (const ct of selectedForMerge) {
        merge_map[ct] = target;
      }
    } else {
      for (const cid of selectedForMerge) {
        const row = markerTable.find(r => r.cluster_id === cid);
        if (row) merge_map[row.celltype] = target;
      }
    }

    try {
      // 1. 更新 scatter_data.celltype 数组
      const scatter = displayScatter;
      let newScatter: ScatterData | undefined;
      if (scatter) {
        const newCelltype = [...(scatter.celltype ?? [])];
        for (let i = 0; i < newCelltype.length; i++) {
          if (merge_map[newCelltype[i]]) {
            newCelltype[i] = merge_map[newCelltype[i]];
          }
        }
        newScatter = { ...scatter, celltype: newCelltype };
        setLocalScatter(newScatter);
      }

      // 2. 更新 markerTable（只更新 celltype，保留 original_celltype 不变）
      const newMarkerTable = markerTable.map(row =>
        merge_map[row.celltype]
          ? { ...row, celltype: merge_map[row.celltype] }
          : row
      );
      setMarkerTable(newMarkerTable);

      // 3. 持久化到后端
      const updatePayload: Record<string, unknown> = {
        marker_table: newMarkerTable,
      };
      if (newScatter) {
        updatePayload.scatter_data = {
          ...annotateData?.scatter_data,
          celltype: newScatter.celltype,
        };
      }
      await updateTaskResult(taskId, updatePayload);
      window.dispatchEvent(new CustomEvent("annotation-updated"));

      // 4. 重置合并状态
      setSelectedForMerge(new Set());
      setMergeTargetName("");
      setMergeMode(false);
    } catch (e) {
      setMergeError(e instanceof Error ? e.message : "合并失败");
    } finally {
      setMerging(false);
    }
  }, [selectedForMerge, mergeTargetName, tableHighlightType, markerTable, displayScatter, taskId, annotateData?.scatter_data]);

  const toggleMergeSelection = useCallback((id: string, type?: "cluster" | "celltype") => {
    if (type) {
      if (mergeMode) {
        // 调整模式：多选，但只能选同一列
        const switchColumn = tableHighlightType && tableHighlightType !== type;
        if (switchColumn) {
          // 切换列：清空旧选区，选中新项
          setTableHighlightType(type);
          setSelectedForMerge(new Set([id]));
        } else {
          // 同列：累加 toggle
          setTableHighlightType(type);
          setSelectedForMerge(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            if (next.size === 0) setTableHighlightType(null);
            return next;
          });
        }
      } else {
        // 非调整模式：单选（替换）
        const isDeselect = selectedForMerge.has(id) && selectedForMerge.size === 1;
        if (isDeselect) {
          setTableHighlightType(null);
          setSelectedForMerge(new Set());
        } else {
          setTableHighlightType(type);
          setSelectedForMerge(new Set([id]));
        }
      }
    } else {
      // 从 UMAP 图例点击：正常 toggle
      setSelectedForMerge(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        if (next.size === 0) setTableHighlightType(null);
        return next;
      });
    }
  }, [mergeMode, tableHighlightType, selectedForMerge]);

  // 保存编辑后的注释结果（更新本地状态 + 持久化到后端）
  const [savingResults, setSavingResultsState] = useState(false);
  const handleSaveResults = useCallback(async () => {
    if (Object.keys(editedResults).length === 0) return;

    // 构建 merge_map: cluster_id -> new_celltype
    const clusterRename: Record<string, string> = {};
    for (const [cid, newName] of Object.entries(editedResults)) {
      if (newName.trim()) clusterRename[cid] = newName.trim();
    }

    if (Object.keys(clusterRename).length === 0) return;

    // 更新 scatter_data.celltype 数组
    let newScatter: ScatterData | undefined;
    const scatter = displayScatter;
    if (scatter) {
      const newCelltype = [...(scatter.celltype ?? [])];
      for (let i = 0; i < newCelltype.length; i++) {
        const cid = scatter.cluster[i];
        if (clusterRename[cid]) {
          newCelltype[i] = clusterRename[cid];
        }
      }
      newScatter = { ...scatter, celltype: newCelltype };
      setLocalScatter(newScatter);
    }

    // 更新 markerTable（只更新 celltype，保留 original_celltype 不变）
    const newMarkerTable = markerTable.map(row =>
      clusterRename[row.cluster_id]
        ? { ...row, celltype: clusterRename[row.cluster_id] }
        : row
    );
    setMarkerTable(newMarkerTable);

    setEditedResults({});
    setMergeMode(false);

    // 持久化到后端
    setSavingResultsState(true);
    try {
      const updatePayload: Record<string, unknown> = {
        marker_table: newMarkerTable,
      };
      if (newScatter) {
        updatePayload.scatter_data = {
          ...annotateData?.scatter_data,
          celltype: newScatter.celltype,
        };
      }
      await updateTaskResult(taskId, updatePayload);
      window.dispatchEvent(new CustomEvent("annotation-updated"));
    } catch (e) {
      console.error("保存注释结果失败:", e);
    } finally {
      setSavingResultsState(false);
    }
  }, [editedResults, displayScatter, markerTable, taskId, annotateData?.scatter_data]);

  return (
    <div className="space-y-4">
      {/* ── 顶部统计胶囊 + 编辑按钮 ── */}
      {stats && (
        <div className="flex flex-wrap items-center gap-4 text-xs" style={{ color: "var(--clr-text-muted)" }}>
          <span>
            细胞数：
            <strong style={{ color: "var(--clr-text)" }}>
              {stats.cells?.toLocaleString()}
            </strong>
          </span>
          <span>
            细胞类型数：
            <strong style={{ color: "var(--clr-amber)", fontSize: "1rem" }}>
              {markerTable.length || (stats.cell_types ?? "—")}
            </strong>
          </span>
          <span>
            注释方法：
            <strong style={{ color: "var(--clr-text)" }}>
              {stats.anno_type ?? "—"}
            </strong>
          </span>
          {/* 合并按钮 */}
          <button
            onClick={() => {
              setMergeMode(!mergeMode);
              if (mergeMode) {
                setSelectedForMerge(new Set());
                setMergeTargetName("");
                setMergeError(null);
              }
            }}
            className="ml-auto px-5 py-2 rounded-lg text-sm font-bold transition-colors"
            style={mergeMode
              ? { background: "var(--clr-amber)", color: "#fff", cursor: "pointer", boxShadow: "0 2px 8px rgba(200,96,25,0.3)" }
              : { background: "var(--clr-amber)", color: "#fff", cursor: "pointer", boxShadow: "0 2px 8px rgba(200,96,25,0.2)" }
            }
          >
            {mergeMode ? "退出调整" : "调整注释结果"}
          </button>
        </div>
      )}

      {/* ── 手动注释文件上传 (暂时隐藏) ── */}
      {false && (<>
      <div
        className="flex items-center gap-3 p-3 rounded-lg"
        style={{
          background: "rgba(200,96,25,0.04)",
          border: "2px dashed rgba(200,96,25,0.3)",
        }}
      >
        <div className="flex-1">
          <p className="text-xs font-semibold" style={{ color: "var(--clr-amber-dark)" }}>
            手工注释上传
          </p>
          <p className="text-[11px] mt-0.5" style={{ color: "var(--clr-text-muted)" }}>
            上传 CSV/TSV 文件（需含 cluster_id, celltype 列），替换自动注释结果
          </p>
        </div>
        <label
          className="px-4 py-2 rounded-lg text-xs font-bold text-white cursor-pointer transition-all hover:opacity-90 flex items-center gap-1.5"
          style={{
            background: "linear-gradient(135deg, var(--clr-amber-dark), var(--clr-amber))",
            boxShadow: "0 2px 8px rgba(200,96,25,0.2)",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          {uploadAnnotating ? "上传中..." : "上传注释文件"}
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.tsv,.txt"
            className="hidden"
            onChange={handleAnnotateFileUpload}
            disabled={uploadAnnotating}
          />
        </label>
      </div>
      {uploadAnnotateMsg && (
        <div
          className="text-xs px-3 py-2 rounded"
          style={{
            background: uploadAnnotateMsg.startsWith("成功") ? "rgba(22,163,74,0.06)" : "rgba(220,38,38,0.06)",
            border: `1px solid ${uploadAnnotateMsg.startsWith("成功") ? "rgba(22,163,74,0.2)" : "rgba(220,38,38,0.2)"}`,
            color: uploadAnnotateMsg.startsWith("成功") ? "#15803d" : "#b91c1c",
          }}
        >
          {uploadAnnotateMsg}
        </div>
      )}
      </>)}

      {/* ── 合并模式提示 ── */}
      {mergeMode && (
        <div
          className="flex items-center gap-2 px-3 py-2 rounded text-xs"
          style={{ background: "rgba(200,96,25,0.06)", border: "1px solid rgba(200,96,25,0.2)", color: "var(--clr-amber-dark)" }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" />
          </svg>
          点击图例或 UMAP 图上的点进行多选，然后输入合并后的名称
        </div>
      )}

      {/* ── UMAP 注释图 ── */}
      {displayScatter ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold" style={{ color: "var(--clr-amber-dark)" }}>
              细胞类型 UMAP 标注图
            </p>
            {plotDownloadSrc && (
              <button
                onClick={async () => {
                  try {
                    const resp = await fetch(`/api/tasks/${taskId}/plot?name=${encodeURIComponent(plotDownloadName)}`, {
                      headers: { Authorization: `Bearer ${token}` }
                    });
                    if (!resp.ok) throw new Error("下载失败");
                    const blob = await resp.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = plotDownloadName;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                  } catch(e) { alert("下载失败"); }
                }}
                className="inline-flex items-center px-1.5 py-1 rounded text-[11px] font-medium transition-all hover:shadow-sm"
                style={{ border: "1px solid var(--clr-border)", color: "var(--clr-amber-dark)", background: "rgba(200,96,25,0.04)" }}
                title="下载原版 UMAP (R ggplot2)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </button>
            )}
          </div>
          <DeckScatterPlot
            data={displayScatter}
            method="UMAP"
            height={520}
            mergeMode={mergeMode}
            selectedForMerge={selectedForMerge}
            onToggleMerge={toggleMergeSelection}
            onColorByChange={setCurrentColorBy}
            mergeIdKey={deckMergeIdKey}
            colorBy={deckColorBy}
            
          />
        </div>
      ) : plotSrc && (
        <div className="space-y-2">
          <p className="text-xs font-semibold" style={{ color: "var(--clr-amber-dark)" }}>
            细胞类型 UMAP 标注图
            <span className="font-normal ml-1" style={{ color: "var(--clr-text-muted)" }}>
              — R ggplot2 原版输出
            </span>
          </p>
          <div className="relative rounded-lg overflow-hidden border" style={{ borderColor: "var(--clr-border)" }}>
            <AuthImg src={plotSrc} alt="Annotation UMAP" token={token} />
            <button
              onClick={async () => {
                try {
                  const resp = await fetch(`/api/tasks/${taskId}/plot?name=${encodeURIComponent(plotDownloadName)}`, {
                    headers: { Authorization: `Bearer ${token}` }
                  });
                  if (!resp.ok) throw new Error("下载失败");
                  const blob = await resp.blob();
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = plotDownloadName;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                } catch(e) { alert("下载失败: " + e); }
              }}
              className="absolute bottom-3 right-3 inline-flex items-center justify-center w-9 h-9 rounded-lg transition-all hover:scale-110"
              style={{ background: "rgba(255,255,255,0.92)", boxShadow: "0 2px 8px rgba(0,0,0,0.10)", color: "var(--clr-amber)" }}
              title="下载 UMAP 图"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </button>
          </div>
        </div>
      )}

      {/* ── 合并操作栏 ── */}
      {mergeMode && selectedForMerge.size >= 2 && (
        <div
          className="flex flex-wrap items-center gap-3 p-3 rounded"
          style={{ background: "rgba(200,96,25,0.06)", border: "1px solid var(--clr-amber)" }}
        >
          <span className="text-xs" style={{ color: "var(--clr-text)" }}>
            已选择 <strong>{selectedForMerge.size}</strong> 项：
            {Array.from(selectedForMerge).join(" + ")}
          </span>
          <span className="text-xs" style={{ color: "var(--clr-text-muted)" }}>=</span>
          <input
            type="text"
            value={mergeTargetName}
            onChange={e => setMergeTargetName(e.target.value)}
            placeholder="合并后的名称..."
            className="px-2 py-1 rounded text-xs"
            style={{ border: "1px solid var(--clr-border)", width: 180, background: "var(--clr-bg-alt)", color: "var(--clr-text)" }}
          />
          <button
            disabled={!mergeTargetName.trim() || merging}
            onClick={handleMerge}
            className="px-4 py-1.5 rounded text-xs font-medium text-white disabled:opacity-50"
            style={{ background: "var(--clr-amber)", cursor: !mergeTargetName.trim() || merging ? "default" : "pointer" }}
          >
            {merging ? "合并中..." : "合并"}
          </button>
          {mergeError && <span className="text-xs" style={{ color: "var(--clr-danger)" }}>{mergeError}</span>}
        </div>
      )}

      {mergeMode && selectedForMerge.size === 1 && (
        <div className="text-xs" style={{ color: "var(--clr-text-faint)" }}>
          请继续选择至少 2 项
        </div>
      )}

      {/* ── 保存编辑后的注释结果 ── */}
      {mergeMode && Object.keys(editedResults).length > 0 && (
        <div
          className="flex flex-wrap items-center gap-3 p-3 rounded"
          style={{ background: "rgba(200,96,25,0.06)", border: "1px solid var(--clr-amber)" }}
        >
          <span className="text-xs" style={{ color: "var(--clr-text)" }}>
            已修改 <strong>{Object.keys(editedResults).length}</strong> 个聚类的 CellType
          </span>
          <button
            disabled={savingResults}
            onClick={handleSaveResults}
            className="px-4 py-1.5 rounded text-xs font-medium text-white disabled:opacity-50"
            style={{ background: "var(--clr-amber)", cursor: savingResults ? "default" : "pointer" }}
          >
            {savingResults ? "保存中..." : "保存注释结果"}
          </button>
          {mergeError && <span className="text-xs" style={{ color: "var(--clr-danger)" }}>{mergeError}</span>}
        </div>
      )}

      {/* ── Marker 基因注释表 ── */}
      {markerTable.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold" style={{ color: "var(--clr-amber-dark)" }}>
            细胞类型注释
            <span className="font-normal ml-1" style={{ color: "var(--clr-text-muted)" }}>
              — {markerTable.length} 个聚类
            </span>
          </p>
          <div className="overflow-x-auto rounded-lg border" style={{ borderColor: "var(--clr-border)" }}>
            <table className="w-full text-xs" style={{ background: "var(--clr-bg-alt)" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--clr-border)", background: "var(--clr-bg)" }}>
                  <th className="px-3 py-2 text-left font-semibold" style={{ color: "var(--clr-amber-dark)" }}>
                    ClusterID
                  </th>
                  <th className="px-3 py-2 text-left font-semibold" style={{ color: "var(--clr-amber-dark)" }}>
                    原始注释
                  </th>
                  <th className="px-3 py-2 text-left font-semibold" style={{ color: "var(--clr-amber-dark)" }}>
                    CellType
                  </th>
                  <th className="px-3 py-2 text-left font-semibold" style={{ color: "var(--clr-amber-dark)" }}>
                    Marker Genes
                  </th>
                  <th className="px-3 py-2 text-left font-semibold" style={{ color: "var(--clr-amber-dark)", width: 140 }}>
                    基因表达查询
                  </th>
                </tr>
              </thead>
              <tbody>
                {markerPageData.map((row, idx) => {
                  const isSelected = selectedForMerge.has(row.cluster_id) || selectedForMerge.has(row.celltype);
                  const rowBg = isSelected
                    ? "rgba(200,96,25,0.1)"
                    : idx % 2 === 0 ? "transparent" : "rgba(255,255,255,0.4)";
                  const displayCelltype = editedResults[row.cluster_id] ?? row.celltype;
                  return (
                    <tr
                      key={row.cluster_id}
                      style={{
                        borderBottom: "1px solid var(--clr-border)",
                        background: rowBg,
                        transition: "background 0.15s",
                      }}
                    >
                      <td className="px-2 py-1.5">
                        <button
                          onClick={() => toggleMergeSelection(row.cluster_id, "cluster")}
                          className="px-2 py-0.5 rounded text-xs font-mono transition-all"
                          style={{
                            background: isSelected && tableHighlightType === "cluster" ? "var(--clr-amber)" : "var(--clr-bg-alt)",
                            color: isSelected && tableHighlightType === "cluster" ? "#fff" : "var(--clr-text)",
                            border: `1px solid ${isSelected && tableHighlightType === "cluster" ? "var(--clr-amber)" : "var(--clr-border)"}`,
                            cursor: "pointer",
                          }}
                        >
                          {row.cluster_id}
                        </button>
                      </td>
                      <td className="px-3 py-2" style={{ color: "var(--clr-text-muted)" }}>
                        {row.original_celltype ?? row.celltype}
                      </td>
                      <td className="px-2 py-1.5">
                        {mergeMode ? (
                          <input
                            type="text"
                            value={displayCelltype}
                            onChange={e => {
                              setEditedResults(prev => ({ ...prev, [row.cluster_id]: e.target.value }));
                            }}
                            className="w-full px-1.5 py-0.5 rounded text-xs"
                            style={{
                              border: "1px solid var(--clr-border)",
                              background: "var(--clr-bg)",
                              color: "var(--clr-text)",
                            }}
                          />
                        ) : (
                          <button
                            onClick={() => toggleMergeSelection(row.celltype, "celltype")}
                            className="px-2 py-0.5 rounded text-xs transition-all"
                            style={{
                              background: isSelected && tableHighlightType === "celltype" ? "var(--clr-amber)" : "var(--clr-bg-alt)",
                              color: isSelected && tableHighlightType === "celltype" ? "#fff" : "var(--clr-text)",
                              border: `1px solid ${isSelected && tableHighlightType === "celltype" ? "var(--clr-amber)" : "var(--clr-border)"}`,
                              cursor: "pointer",
                            }}
                          >
                            {row.celltype}
                          </button>
                        )}
                      </td>
                      <td className="px-3 py-2" style={{ color: "var(--clr-text)", maxWidth: 260 }}>
                        {row.markers.length > 0 ? (
                          <>
                            {row.markers.slice(0, 5).map((g, gi) => (
                              <React.Fragment key={g}>
                                <button
                                  onMouseEnter={(e) => openGenePopup(g, row.celltype, e)}
                                  onMouseLeave={scheduleCloseGenePopup}
                                  style={{
                                    background: "none",
                                    border: "none",
                                    padding: 0,
                                    color: activeGene === g ? "#60a5fa" : "var(--clr-text)",
                                    cursor: "pointer",
                                    textDecoration: activeGene === g ? "underline" : "none",
                                    fontSize: "inherit",
                                    fontFamily: "inherit",
                                  }}
                                >
                                  {g}
                                </button>
                                {gi < Math.min(4, row.markers.length - 1) && (
                                  <span style={{ color: "var(--clr-text-muted)" }}>, </span>
                                )}
                              </React.Fragment>
                            ))}
                            {row.markers.length > 5 && (
                              <span style={{ color: "var(--clr-text-muted)" }}> +{row.markers.length - 5}</span>
                            )}
                          </>
                        ) : (
                          <span style={{ color: "var(--clr-text-faint)" }}>—</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5" style={{ position: "relative" }}>
                        <div style={{ position: "relative" }}>
                          <div className="flex items-center gap-1">
                            <input
                              type="text"
                              value={geneQueryInputs[row.cluster_id] || ""}
                              onChange={(e) => setGeneQueryInputs(prev => ({ ...prev, [row.cluster_id]: e.target.value }))}
                              onFocus={() => setShowMarkerPanel(prev => ({ ...prev, [row.cluster_id]: true }))}
                              onBlur={() => setTimeout(() => setShowMarkerPanel(prev => ({ ...prev, [row.cluster_id]: false })), 180)}
                              placeholder="基因名"
                              className="px-1.5 py-0.5 rounded text-xs"
                              style={{
                                border: "1px solid var(--clr-border)",
                                background: "var(--clr-bg)",
                                color: "var(--clr-text)",
                                width: 80,
                              }}
                            />
                            <button
                              onClick={(e) => {
                                const gene = geneQueryInputs[row.cluster_id]?.trim();
                                if (gene) {
                                  const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                                  setActiveGene(gene);
                                  setActiveCellType(row.celltype);
                                  setGeneMousePos({ x: rect.left, y: rect.bottom + 4 });
                                }
                              }}
                              className="px-1.5 py-0.5 rounded text-xs"
                              style={{
                                background: "var(--clr-amber)",
                                color: "#fff",
                                cursor: "pointer",
                                border: "none",
                              }}
                            >
                              查询
                            </button>
                          </div>

                          {/* Marker genes 下拉面板 */}
                          {showMarkerPanel[row.cluster_id] && row.markers.length > 0 && (
                            <div
                              style={{
                                position: "absolute",
                                right: "calc(100% + 8px)",
                                top: 0,
                                zIndex: 100,
                                background: "var(--clr-bg-card)",
                                border: "1px solid var(--clr-border)",
                                borderRadius: 6,
                                padding: "8px 12px",
                                boxShadow: "0 4px 20px rgba(0,0,0,0.12)",
                                width: 320,
                              }}
                              onMouseDown={(e) => e.preventDefault()}
                            >
                              <div className="text-[10px] mb-1" style={{ color: "var(--clr-text-muted)" }}>
                                该细胞类型的标记基因：
                              </div>
                              <div className="flex flex-wrap gap-1.5" style={{ maxHeight: 200, overflowY: "auto" }}>
                                {row.markers.slice(0, expandedMarkers[row.cluster_id] ? row.markers.length : Math.min(6, row.markers.length)).map((g) => (
                                  <button
                                    key={g}
                                    onMouseDown={() => {
                                      setGeneQueryInputs(prev => ({ ...prev, [row.cluster_id]: g }));
                                      setShowMarkerPanel(prev => ({ ...prev, [row.cluster_id]: false }));
                                      setTimeout(() => {
                                        setActiveGene(g);
                                        setActiveCellType(row.celltype);
                                        const inputEl = document.querySelector(`input[data-cluster="${row.cluster_id}"]`) as HTMLInputElement;
                                        if (inputEl) {
                                          const rect = inputEl.getBoundingClientRect();
                                          setGeneMousePos({ x: rect.left, y: rect.bottom + 4 });
                                        }
                                      }, 50);
                                    }}
                                    className="px-1.5 py-0.5 rounded text-[10px] transition-colors hover:opacity-80"
                                    style={{
                                      background: "rgba(200,96,25,0.08)",
                                      color: "var(--clr-amber-dark)",
                                      border: "1px solid rgba(200,96,25,0.2)",
                                      cursor: "pointer",
                                    }}
                                  >
                                    {g}
                                  </button>
                                ))}
                              </div>
                              {row.markers.length > 6 && (
                                <button
                                  onMouseDown={() => setExpandedMarkers(prev => ({ ...prev, [row.cluster_id]: !prev[row.cluster_id] }))}
                                  className="mt-1 text-[10px]"
                                  style={{
                                    background: "transparent",
                                    color: "var(--clr-amber)",
                                    border: "none",
                                    cursor: "pointer",
                                    padding: 0,
                                  }}
                                >
                                  {expandedMarkers[row.cluster_id] ? "收起 ▲" : `展开 (+${row.markers.length - 6}) ▼`}
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ── 分页控制 ── */}
          {markerTotalPages > 1 && (
            <div className="flex justify-center gap-2 text-xs">
              <button
                disabled={markerPage === 0}
                onClick={() => setMarkerPage(Math.max(0, markerPage - 1))}
                className="px-2 py-1 rounded disabled:opacity-50"
                style={{
                  border: "1px solid var(--clr-border)",
                  background: markerPage === 0 ? "transparent" : "var(--clr-bg-alt)",
                  cursor: markerPage === 0 ? "default" : "pointer",
                }}
              >
                上一页
              </button>
              <span style={{ color: "var(--clr-text-muted)" }}>
                第 {markerPage + 1} / {markerTotalPages} 页
              </span>
              <button
                disabled={markerPage >= markerTotalPages - 1}
                onClick={() => setMarkerPage(Math.min(markerTotalPages - 1, markerPage + 1))}
                className="px-2 py-1 rounded disabled:opacity-50"
                style={{
                  border: "1px solid var(--clr-border)",
                  background: markerPage >= markerTotalPages - 1 ? "transparent" : "var(--clr-bg-alt)",
                  cursor: markerPage >= markerTotalPages - 1 ? "default" : "pointer",
                }}
              >
                下一页
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── 细胞类型占比表 ── */}
      {freqRows.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold" style={{ color: "var(--clr-amber-dark)" }}>
            每个样本的细胞类型占比
            <span className="font-normal ml-1" style={{ color: "var(--clr-text-muted)" }}>
              — {freqRows.length} 种细胞类型 × {freqHeaders.length} 个样本
            </span>
          </p>
          <button
            onClick={() => {
              const header = ["CellType", ...freqHeaders];
              const csvRows = freqRows.map(r => [r.celltype, ...freqHeaders.map(s => r[s])]);
              const csv = [header.join(","), ...csvRows.map(r => r.join(","))].join("\n");
              const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              const baseFromPlot = plotName.replace(/_umap\.(png|pdf)$/i, "") || "annotate";
              a.download = `${baseFromPlot}_celltype_proportion.csv`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs"
            style={{ border: "1px solid var(--clr-border)", background: "var(--clr-bg-alt)", color: "var(--clr-amber-dark)", cursor: "pointer" }}
            title="下载细胞类型占比表 CSV"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" style={{ width: 14, height: 14 }}>
              <path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614L6.295 8.235a.75.75 0 10-1.09 1.03l4.25 4.5a.75.75 0 001.09 0l4.25-4.5a.75.75 0 00-1.09-1.03l-2.955 3.129V2.75z" />
              <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" />
            </svg>
            下载占比表
          </button>
          <div className="overflow-x-auto rounded-lg border" style={{ borderColor: "var(--clr-border)" }}>
            <table className="w-full text-xs" style={{ background: "var(--clr-bg-alt)" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--clr-border)", background: "var(--clr-bg)" }}>
                  <th className="px-3 py-2 text-left font-semibold sticky left-0" style={{ color: "var(--clr-amber-dark)", background: "var(--clr-bg)", zIndex: 1 }}>
                    CellType
                  </th>
                  {freqHeaders.map(s => (
                    <th key={s} className="px-3 py-2 text-right font-semibold" style={{ color: "var(--clr-amber-dark)" }}>
                      {s}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {freqPageData.map((row, idx) => (
                  <tr
                    key={row.celltype}
                    style={{
                      borderBottom: "1px solid var(--clr-border)",
                      background: idx % 2 === 0 ? "transparent" : "rgba(255,255,255,0.4)",
                    }}
                  >
                    <td className="px-3 py-1.5 font-medium sticky left-0" style={{ color: "var(--clr-text)", background: idx % 2 === 0 ? "var(--clr-bg-alt)" : "rgba(255,255,255,0.4)", zIndex: 1 }}>
                      {row.celltype}
                    </td>
                    {freqHeaders.map(s => (
                      <td key={s} className="px-3 py-1.5 text-right" style={{ color: "var(--clr-text-muted)", fontVariantNumeric: "tabular-nums" }}>
                        {row[s]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {freqTotalPages > 1 && (
            <div className="flex justify-center gap-2 text-xs">
              <button
                disabled={freqPage === 0}
                onClick={() => setFreqPage(Math.max(0, freqPage - 1))}
                className="px-2 py-1 rounded disabled:opacity-50"
                style={{ border: "1px solid var(--clr-border)", background: freqPage === 0 ? "transparent" : "var(--clr-bg-alt)", cursor: freqPage === 0 ? "default" : "pointer" }}
              >
                上一页
              </button>
              <span style={{ color: "var(--clr-text-muted)" }}>
                第 {freqPage + 1} / {freqTotalPages} 页
              </span>
              <button
                disabled={freqPage >= freqTotalPages - 1}
                onClick={() => setFreqPage(Math.min(freqTotalPages - 1, freqPage + 1))}
                className="px-2 py-1 rounded disabled:opacity-50"
                style={{ border: "1px solid var(--clr-border)", background: freqPage >= freqTotalPages - 1 ? "transparent" : "var(--clr-bg-alt)", cursor: freqPage >= freqTotalPages - 1 ? "default" : "pointer" }}
              >
                下一页
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── 无数据状态 ── */}
      {!annotateData && (
        <div className="text-xs px-3 py-2 rounded" style={{ background: "rgba(255,215,0,0.08)", borderLeft: "3px solid var(--clr-gold)", color: "var(--clr-text-muted)" }}>
          注释结果加载中或暂未返回...
        </div>
      )}

      {/* ── 基因表达弹窗（hover 触发） ── */}
      {activeGene && geneMousePos && typeof window !== "undefined" && createPortal(
        <GeneExpressionPopup
          gene={activeGene}
          celltype={activeCellType}
          projectId={task.project_id}
          mousePos={geneMousePos}
          onMouseEnter={() => {
            genePopupHovered.current = true;
            if (geneCloseTimer.current) { clearTimeout(geneCloseTimer.current); geneCloseTimer.current = null; }
          }}
          onMouseLeave={() => {
            genePopupHovered.current = false;
            scheduleCloseGenePopup();
          }}
          token={token}
        />,
        document.body
      )}
    </div>
  );
}
