"use client";

import React, { useMemo, useRef, useCallback } from "react";
import dynamic from "next/dynamic";

// react-plotly.js 需要动态导入（SSR 不支持 Plotly）
const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

/* ================================================================
 *  火山图组件 — 用于双簇差异基因的 log2FC vs -log10(p_val_adj) 展示
 *
 *  参考标准：
 *    x 轴 = avg_log2FC（效应量）
 *    y 轴 = -log10(p_val_adj)（统计显著性）
 *    颜色 = 上调(红) / 下调(蓝) / 不显著(灰)
 *
 *  阈值默认：|log2FC| > 1 且 p_adj < 0.05
 *  log2FC clamp 范围：±10（防止 Inf/极端值拉伸坐标轴）
 * ================================================================ */

export interface VolcanoPoint {
  gene_id: string;
  avg_log2FC: number;
  p_val_adj: number;
}

interface VolcanoPlotProps {
  data: VolcanoPoint[];
  /** log2FC 绝对值阈值，默认 1 */
  fcThreshold?: number;
  /** p_val_adj 阈值，默认 0.05 */
  pThreshold?: number;
  height?: number;
  /** 分析对标签 */
  title?: string;
  /** 图片输出格式: "png" | "pdf" */
  plotFormat?: string;
  /** 项目名（用于归档文件名） */
  projectName?: string;
  /** 任务完成时间（用于归档文件名） */
  completedAt?: string | null;
}

/** log2FC clamp 上限（±MAX_FC） */
const MAX_FC = 10;



import { jsPDF } from "jspdf";

export default function VolcanoPlot({
  data,
  fcThreshold = 1,
  pThreshold = 0.05,
  height = 440,
  title,
  plotFormat = "png",
  projectName,
  completedAt,
}: VolcanoPlotProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plotRef = useRef<any>(null);

  const { upGenes, downGenes, nsGenes } = useMemo(() => {
    const up: VolcanoPoint[] = [];
    const down: VolcanoPoint[] = [];
    const ns: VolcanoPoint[] = [];

    for (const pt of data) {
      // 跳过无效值（NaN / Inf）
      if (
        pt.avg_log2FC == null ||
        pt.p_val_adj == null ||
        !isFinite(pt.avg_log2FC) ||
        !isFinite(pt.p_val_adj) ||
        isNaN(pt.avg_log2FC) ||
        isNaN(pt.p_val_adj)
      )
        continue;

      const isSignificant = pt.p_val_adj < pThreshold;
      const isUp = pt.avg_log2FC > fcThreshold;
      const isDown = pt.avg_log2FC < -fcThreshold;

      if (isSignificant && isUp) up.push(pt);
      else if (isSignificant && isDown) down.push(pt);
      else ns.push(pt);
    }

    return { upGenes: up, downGenes: down, nsGenes: ns };
  }, [data, fcThreshold, pThreshold]);

  // 计算 -log10(p_val_adj)，cap 到 100 防止极大值拉伸 Y 轴压缩底层点
  const MAX_Y_CAP = 100;
  const negLog10 = (p: number) => {
    if (p <= 0) return MAX_Y_CAP;
    const val = -Math.log10(p);
    return val > MAX_Y_CAP ? MAX_Y_CAP : val;
  };

  // Clamp log2FC 到 ±MAX_FC，防止极端值拉伸 X 轴
  const clampFC = (fc: number) => Math.max(-MAX_FC, Math.min(MAX_FC, fc));

  const makeTrace = (
    points: VolcanoPoint[],
    name: string,
    color: string,
    symbol: string,
  ): Partial<Plotly.Data> => ({
    x: points.map((p) => clampFC(p.avg_log2FC)),
    y: points.map((p) => negLog10(p.p_val_adj)),
    text: points.map(
      (p) =>
        `<b>${p.gene_id}</b><br>log2FC: ${p.avg_log2FC.toFixed(3)}<br>p_adj: ${p.p_val_adj.toExponential(2)}`,
    ),
    hoverinfo: "text" as const,
    mode: "markers" as const,
    type: "scattergl" as const,
    name: `${name} (${points.length})`,
    marker: {
      color,
      size: 5,
      opacity: 0.7,
      symbol,
    },
  });

  const traces = [
    makeTrace(nsGenes, "不显著", "#BFBFBF", "circle"),
    makeTrace(downGenes, "下调", "#4A90D9", "circle"),
    makeTrace(upGenes, "上调", "#E25B45", "circle"),
  ];

  // 阈值参考线
  const maxY = Math.max(
    ...data
      .filter(
        (p) =>
          p.p_val_adj != null &&
          isFinite(p.p_val_adj) &&
          !isNaN(p.p_val_adj),
      )
      .map((p) => negLog10(p.p_val_adj)),
    5,
  );
  const pLine = negLog10(pThreshold);

  // 动态 X 轴范围（基于 clamp 后 + padding）
  const xPad = MAX_FC + 1;

  // 归档命名: {proj}_markers_{ts}_volcano_{suffix}.{ext}
  const archiveName = useMemo(() => {
    const proj = projectName || "project";
    const ts = completedAt ? completedAt.replace(/[-:T]/g, "").slice(0, 14) : new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const suffix = (title || "plot").replace(/\s+/g, "_");
    return `${proj}_markers_${ts}_volcano_${suffix}`;
  }, [projectName, completedAt, title]);

  const handleDownload = useCallback(async () => {
    const el = plotRef.current?.el;
    if (!el) return;
    try {
      const Plotly = await import("plotly.js-dist-min");
      const imgData = await Plotly.toImage(el, { format: "png", width: 1200, height: 600, scale: 2 });
      if (plotFormat === "pdf") {
        const pdf = new jsPDF({ orientation: "landscape", unit: "px", format: [1200, 600] });
        pdf.addImage(imgData, "PNG", 0, 0, 1200, 600);
        pdf.save(`${archiveName}.pdf`);
      } else {
        const a = document.createElement("a");
        a.href = imgData;
        a.download = `${archiveName}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    } catch (e) {
      console.warn("图片导出失败", e);
    }
  }, [plotFormat, archiveName]);

  return (
    <div style={{ width: "100%", position: "relative" }}>
      {title && (
        <p
          className="text-xs font-medium mb-1"
          style={{ color: "var(--clr-amber-dark)" }}
        >
          火山图 (Volcano Plot)
          <span
            className="font-normal ml-1"
            style={{ color: "var(--clr-text-faint)" }}
          >
            — {title} · {data.length} 个基因
          </span>
        </p>
      )}
      <Plot
        ref={plotRef}
        data={traces as Plotly.Data[]}
        layout={{
          width: undefined,
          height,
          autosize: true,
          margin: { l: 55, r: 20, t: 10, b: 45 },
          xaxis: {
            title: { text: "log₂(Fold Change)", font: { size: 12 } },
            range: [-xPad, xPad],
            zeroline: true,
            zerolinecolor: "#E0E0E0",
            gridcolor: "#F5F5F5",
          },
          yaxis: {
            title: { text: "-log₁₀(p_adj)", font: { size: 12 } },
            gridcolor: "#F5F5F5",
          },
          plot_bgcolor: "#FFFFFF",
          paper_bgcolor: "transparent",
          showlegend: false,
          shapes: [
            // 水平线: -log10(pThreshold)
            {
              type: "line",
              x0: -xPad,
              x1: xPad,
              y0: pLine,
              y1: pLine,
              line: { color: "#C86019", width: 1, dash: "dash" },
            },
            // 垂直线: -fcThreshold
            {
              type: "line",
              x0: -fcThreshold,
              x1: -fcThreshold,
              y0: 0,
              y1: maxY * 1.1,
              line: { color: "#C86019", width: 1, dash: "dash" },
            },
            // 垂直线: +fcThreshold
            {
              type: "line",
              x0: fcThreshold,
              x1: fcThreshold,
              y0: 0,
              y1: maxY * 1.1,
              line: { color: "#C86019", width: 1, dash: "dash" },
            },
          ],
          hovermode: "closest",
        }}
        config={{
          displayModeBar: false,
          displaylogo: false,
          responsive: true,
        }}
        useResizeHandler
        style={{ width: "100%", height }}
      />

      {/* 右下角下载按钮 */}
      <button
        onClick={handleDownload}
        title={`下载火山图 ${plotFormat.toUpperCase()}`}
        className="absolute bottom-2 right-2 z-10 inline-flex items-center justify-center w-9 h-9 rounded-lg transition-all hover:scale-110"
        style={{ background: "rgba(255,255,255,0.92)", boxShadow: "0 2px 8px rgba(0,0,0,0.10)", color: "var(--clr-amber)" }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      </button>

      {/* 统计概要 */}
      <div
        className="flex gap-4 text-xs mt-1"
        style={{ color: "var(--clr-text-faint)" }}
      >
        <span>
          阈值: |log₂FC| &gt; {fcThreshold}, p_adj &lt; {pThreshold}
        </span>
        <span>
          上调:{" "}
          <strong style={{ color: "#E25B45" }}>{upGenes.length}</strong>
        </span>
        <span>
          下调:{" "}
          <strong style={{ color: "#4A90D9" }}>{downGenes.length}</strong>
        </span>
        <span>
          不显著:{" "}
          <strong style={{ color: "#999" }}>{nsGenes.length}</strong>
        </span>
      </div>
    </div>
  );
}
