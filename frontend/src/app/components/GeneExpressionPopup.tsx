/**
 * GeneExpressionPopup — hover marker 基因名后弹出的 UMAP 表达分布图
 *
 * 使用 deck.gl ScatterplotLayer 渲染 per-cell 表达值，
 * viridis 连续色阶映射。跟随鼠标定位。
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OrthographicView } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";
import DeckGL from "@deck.gl/react";
import { getAuthToken } from "../lib/api";

/* ── viridis 色阶（低表达浅灰 → viridis） ── */
function viridisColor(t: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [0.0, [220, 220, 220]],
    [0.05, [200, 200, 200]],
    [0.1, [68, 1, 84]],
    [0.2, [72, 35, 116]],
    [0.35, [52, 94, 141]],
    [0.5, [33, 145, 140]],
    [0.65, [94, 201, 98]],
    [0.8, [170, 220, 50]],
    [1.0, [253, 231, 37]],
  ];
  const clamped = Math.max(0, Math.min(1, t));
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (clamped >= t0 && clamped <= t1) {
      const f = (clamped - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + f * (c1[0] - c0[0])),
        Math.round(c0[1] + f * (c1[1] - c0[1])),
        Math.round(c0[2] + f * (c1[2] - c0[2])),
      ];
    }
  }
  return [253, 231, 37];
}

interface CellTypeStat {
  n_cells: number;
  n_expressed: number;
  pct_expressed: number;
  mean_expr: number;
}

interface GeneExprData {
  x: number[];
  y: number[];
  expression: number[];
  gene: string;
  min_expr: number;
  max_expr: number;
  celltype_stats?: Record<string, CellTypeStat>;
  current_celltype?: string;
}

// 全局缓存：按 gene+celltype 缓存
const exprCache = new Map<string, GeneExprData>();

export default function GeneExpressionPopup({
  gene,
  celltype,
  projectId,
  mousePos,
  onMouseEnter,
  onMouseLeave,
  token,
}: {
  gene: string;
  celltype?: string | null;
  projectId: number;
  mousePos: { x: number; y: number };
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  token?: string;
}) {
  const [data, setData] = useState<GeneExprData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const POPUP_W = 320;
  const POPUP_H = 420;
  const OFFSET_X = 12;
  const OFFSET_Y = 12;

  // ── 拖动状态：拖动时弹窗固定在拖动位置，不再跟随鼠标 ──
  const [dragPos, setDragPos] = useState<{ top: number; left: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; startPos: { top: number; left: number } } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    // 以当前显示位置为拖动起点
    const current = dragPos ?? hoverPos;
    dragRef.current = { startX: e.clientX, startY: e.clientY, startPos: { ...current } };
    setDragging(true);
    setDragPos(current);
  }, [dragPos]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setDragPos({
        top: Math.max(0, Math.min(dragRef.current.startPos.top + dy, window.innerHeight - POPUP_H)),
        left: Math.max(0, Math.min(dragRef.current.startPos.left + dx, window.innerWidth - POPUP_W)),
      });
    };
    const onUp = () => {
      dragRef.current = null;
      setDragging(false);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  // hover 跟随位置（未拖动时使用）
  const hoverPos = useMemo(() => {
    let left = mousePos.x + OFFSET_X;
    let top = mousePos.y + OFFSET_Y;
    if (left + POPUP_W > window.innerWidth) left = mousePos.x - POPUP_W - OFFSET_X;
    if (top + POPUP_H > window.innerHeight) top = mousePos.y - POPUP_H - OFFSET_Y;
    left = Math.max(4, left);
    top = Math.max(4, top);
    return { top, left };
  }, [mousePos.x, mousePos.y]);

  // 最终位置：拖动时用 dragPos，否则用 hoverPos
  const pos = dragPos ?? hoverPos;

  // 获取数据
  useEffect(() => {
    const cacheKey = `${projectId}:${gene}:${celltype ?? ""}`;
    if (exprCache.has(cacheKey)) {
      setData(exprCache.get(cacheKey)!);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const authToken = token || (typeof window !== "undefined" ? getAuthToken() || "" : "");

    const params = new URLSearchParams({ gene });
    if (celltype) params.set("celltype", celltype);

    fetch(`/api/projects/${projectId}/gene_expression?${params}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: GeneExprData | { error: string }) => {
        if (cancelled) return;
        if ("error" in d) {
          setError(d.error);
        } else {
          exprCache.set(cacheKey, d);
          setData(d);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [gene, celltype, projectId, token]);

  // deck.gl 图层
  const layers = useMemo(() => {
    if (!data) return [];
    const range = data.max_expr - data.min_expr || 1;
    const points = data.x.map((x, i) => ({
      x,
      y: data.y[i],
      expr: data.expression[i],
    }));

    return [
      new ScatterplotLayer({
        id: "gene-expr-scatter",
        data: points,
        getPosition: (d: { x: number; y: number }) => [d.x, d.y],
        getRadius: 1.5,
        radiusUnits: "pixels" as const,
        getFillColor: (d: { expr: number }) => {
          const t = (d.expr - data.min_expr) / range;
          return viridisColor(t);
        },
        opacity: 0.8,
        pickable: false,
      }),
    ];
  }, [data]);

  // deck.gl 视图状态：自适应数据范围
  const viewState = useMemo(() => {
    if (!data || data.x.length === 0) {
      return { target: [0, 0] as [number, number], zoom: 1 };
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < data.x.length; i++) {
      if (data.x[i] < minX) minX = data.x[i];
      if (data.x[i] > maxX) maxX = data.x[i];
      if (data.y[i] < minY) minY = data.y[i];
      if (data.y[i] > maxY) maxY = data.y[i];
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;
    const maxRange = Math.max(rangeX, rangeY);
    const zoom = Math.log2(250 / (maxRange * 1.1));
    return { target: [cx, cy] as [number, number], zoom };
  }, [data]);

  return (
    <div
      ref={popupRef}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width: POPUP_W,
        height: POPUP_H,
        zIndex: 9999,
        background: "var(--clr-bg-card)",
        borderRadius: 8,
        border: "1px solid var(--clr-border)",
        boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        pointerEvents: "auto",
      }}
    >
      {/* 标题栏 — 可拖动 */}
      <div
        onMouseDown={onDragStart}
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "6px 12px",
          cursor: dragging ? "grabbing" : "grab",
          borderBottom: "1px solid var(--clr-border)",
          background: "var(--clr-bg-alt)",
          userSelect: "none",
        }}
      >
        <span style={{ color: "var(--clr-text)", fontSize: 13, fontWeight: 600 }}>{gene}</span>
      </div>

      {/* 表达比例统计 */}
      {data?.celltype_stats && (() => {
        const stats = data.celltype_stats;
        const ct = data.current_celltype;
        const sorted = Object.entries(stats)
          .sort((a, b) => b[1].pct_expressed - a[1].pct_expressed);

        return (
          <div style={{ padding: "5px 10px 6px", borderBottom: "1px solid var(--clr-border)", background: "var(--clr-bg)", fontSize: 11, maxHeight: 90, overflowY: "auto" }}>
            {sorted.map(([name, s]) => {
              const isCurrent = name === ct;
              return (
                <div key={name} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "1px 0",
                  color: isCurrent ? "var(--clr-text)" : "var(--clr-text-muted)",
                  fontWeight: isCurrent ? 600 : 400,
                }}>
                  <span>{isCurrent ? `${name} *` : name}</span>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>
                    {s.pct_expressed}%
                    <span style={{ color: "var(--clr-text-faint)", marginLeft: 3 }}>({s.n_expressed}/{s.n_cells})</span>
                  </span>
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* 图表区域 */}
      <div style={{ flex: 1, position: "relative", background: "var(--clr-bg-card)" }}>
        {loading && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--clr-text-muted)",
              fontSize: 12,
            }}
          >
            Loading...
          </div>
        )}
        {error && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--clr-danger, #d32f2f)",
              fontSize: 12,
              padding: 12,
              textAlign: "center",
            }}
          >
            {error}
          </div>
        )}
        {data && (
          <DeckGL
            views={new OrthographicView({ id: "gene-expr" })}
            viewState={viewState}
            layers={layers}
            controller={false}
            style={{ width: "100%", height: "100%" }}
            parameters={{}}
          />
        )}
      </div>

      {/* 色阶条 */}
      {data && (
        <div
          style={{
            padding: "5px 12px 7px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            borderTop: "1px solid var(--clr-border)",
            background: "var(--clr-bg)",
          }}
        >
          <span style={{ color: "var(--clr-text-faint)", fontSize: 10, whiteSpace: "nowrap" }}>
            {data.min_expr.toFixed(1)}
          </span>
          <div
            style={{
              flex: 1,
              height: 6,
              borderRadius: 3,
              background: `linear-gradient(to right, rgb(220,220,220), rgb(68,1,84), rgb(52,94,141), rgb(33,145,140), rgb(94,201,98), rgb(170,220,50), rgb(253,231,37))`,
            }}
          />
          <span style={{ color: "var(--clr-text-faint)", fontSize: 10, whiteSpace: "nowrap" }}>
            {data.max_expr.toFixed(1)}
          </span>
        </div>
      )}
    </div>
  );
}
