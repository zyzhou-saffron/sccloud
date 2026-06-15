/**
 * scCloud v2 — deck.gl WebGL 散点图组件
 *
 * 替代旧版 Plotly ScatterPlot，使用 WebGL 原生渲染：
 * - 10 万级细胞流畅缩放（1 draw call）
 * - 鼠标悬停显示细胞信息 tooltip
 * - 图例点击切换聚类高亮
 *
 * 数据格式（与 R 引擎返回一致）:
 * { x: number[], y: number[], cluster: string[] }
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OrthographicView } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";
import DeckGL from "@deck.gl/react";
import type { ScatterData } from "./ScatterPlot";

/* ── 多色板（可切换） ── */
const PALETTES: Record<string, { name: string; colors: [number, number, number][] }> = {
  tol: {
    name: "Tol (色盲安全)",
    colors: [
      [68, 119, 170],   // Blue    #4477AA
      [102, 204, 238],  // Cyan    #66CCEE
      [34, 136, 51],    // Green   #228833
      [204, 187, 68],   // Yellow  #CCBB44
      [238, 102, 119],  // Red     #EE6677
      [170, 51, 119],   // Purple  #AA3377
      [187, 187, 187],  // Grey    #BBBBBB
      [0, 153, 136],    // Teal    #009988
      [238, 119, 51],   // Orange  #EE7733
      [238, 51, 119],   // Magenta #EE3377
      [51, 34, 136],    // Indigo  #332288
      [153, 153, 51],   // Olive   #999933
      [221, 204, 119],  // Sand    #DDCC77
      [204, 102, 119],  // Rose    #CC6677
      [136, 34, 85],    // Wine    #882255
    ],
  },
  vivid: {
    name: "Vivid (高饱和)",
    colors: [
      [228, 26, 28],    // Red
      [55, 126, 184],   // Blue
      [77, 175, 74],    // Green
      [255, 127, 0],    // Orange
      [152, 78, 163],   // Purple
      [247, 129, 191],  // Pink
      [166, 86, 40],    // Brown
      [255, 215, 0],    // Gold
      [0, 128, 128],    // Teal
      [148, 103, 189],  // Amethyst
      [31, 119, 180],   // Steel Blue
      [174, 199, 232],  // Light Blue
      [255, 152, 150],  // Salmon
      [197, 176, 213],  // Lavender
      [128, 128, 128],  // Grey
    ],
  },
  nature: {
    name: "Nature (经典)",
    colors: [
      [0, 114, 178],    // Blue    #0072B2
      [230, 159, 0],    // Orange  #E69F00
      [0, 158, 115],    // Teal    #009E73
      [213, 94, 0],     // Vermil. #D55E00
      [86, 180, 233],   // Sky     #56B4E9
      [204, 121, 167],  // Purple  #CC79A7
      [240, 228, 66],   // Yellow  #F0E442
      [153, 153, 153],  // Grey    #999999
      [68, 119, 170],   // Blue2
      [17, 119, 51],    // Green
      [153, 153, 51],   // Olive
      [136, 34, 85],    // Wine
      [221, 204, 119],  // Sand
      [68, 170, 153],   // Teal2
      [51, 34, 136],    // Indigo
    ],
  },
  pastel: {
    name: "Pastel (柔和)",
    colors: [
      [102, 194, 165],  // Teal    #66C2A5
      [252, 141, 98],   // Orange  #FC8D62
      [141, 160, 203],  // Blue    #8DA0CB
      [231, 138, 195],  // Pink    #E78AC3
      [166, 216, 84],   // Green   #A6D854
      [255, 217, 47],   // Yellow  #FFD92F
      [229, 196, 148],  // Sand    #E5C494
      [179, 179, 179],  // Grey    #B3B3B3
      [166, 86, 40],    // Brown
      [247, 129, 191],  // Pink2
      [0, 128, 128],    // Teal2
      [148, 103, 189],  // Amethyst
      [166, 216, 84],   // Lime
      [255, 152, 150],  // Salmon
      [128, 128, 128],  // Grey2
    ],
  },
};

const DEFAULT_PALETTE = "tol";

/* ── CellXgene 风格侧边栏图例 ── */
function LegendSidebar({
  availableGroups, colorBy, setColorBy, paletteKey, setPaletteKey,
  clusters, colorMap, hiddenClusters, toggleCluster, data,
  mergeMode, selectedForMerge, onToggleMerge, mergeIdKey = "celltype",
}: {
  availableGroups: { key: string; label: string }[];
  colorBy: string; setColorBy: (v: string) => void;
  paletteKey: string; setPaletteKey: (v: string) => void;
  clusters: string[]; colorMap: Map<string, [number, number, number]>;
  hiddenClusters: Set<string>; toggleCluster: (c: string) => void;
  data: ScatterData;
  mergeMode?: boolean;
  selectedForMerge?: Set<string>;
  onToggleMerge?: (celltype: string) => void;
  mergeIdKey?: "celltype" | "cluster";
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set([colorBy]));
  const [collapsed, setCollapsed] = useState(false);

  // 切换色板时同步展开
  useEffect(() => {
    setExpanded(new Set([colorBy]));
  }, [colorBy]);

  // 为每个 group 计算值列表
  const groupValues = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const g of availableGroups) {
      const key = g.key as keyof typeof data;
      const arr = data[key];
      if (Array.isArray(arr)) {
        const unique = Array.from(new Set(arr as string[]));
        unique.sort((a, b) => {
          const numA = parseInt(a.replace(/\D/g, ""), 10);
          const numB = parseInt(b.replace(/\D/g, ""), 10);
          if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
          return a.localeCompare(b);
        });
        result[g.key] = unique;
      }
    }
    return result;
  }, [availableGroups, data]);

  // 计算每个值的计数
  const groupCounts = useMemo(() => {
    const result: Record<string, Record<string, number>> = {};
    for (const g of availableGroups) {
      const key = g.key as keyof typeof data;
      const arr = data[key];
      if (Array.isArray(arr)) {
        const counts: Record<string, number> = {};
        for (const v of arr as string[]) {
          counts[v] = (counts[v] || 0) + 1;
        }
        result[g.key] = counts;
      }
    }
    return result;
  }, [availableGroups, data]);

  // 将平行数组转为点对象数组（merge 选择时需要）
  const points = useMemo(() => toPoints(data), [data]);

  const isMergeActive = selectedForMerge && selectedForMerge.size > 0;

  // 为每个 group 分配颜色（只给当前 colorBy 分配，其他用灰色）
  const getGroupColorMap = useCallback((groupKey: string) => {
    if (groupKey === colorBy) return colorMap;
    // 非激活的 group 用灰色
    const vals = groupValues[groupKey] || [];
    const grayMap = new Map<string, [number, number, number]>();
    vals.forEach(v => grayMap.set(v, [180, 180, 180]));
    return grayMap;
  }, [colorBy, colorMap, groupValues]);

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="absolute top-2 right-2 z-10 w-8 h-8 rounded-md flex items-center justify-center transition-all"
        style={{
          background: "rgba(255,255,255,0.92)",
          backdropFilter: "blur(8px)",
          border: "1px solid rgba(45,41,38,0.08)",
          boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
          color: "var(--clr-text-muted)",
          cursor: "pointer",
        }}
        title="展开图例"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
        </svg>
      </button>
    );
  }

  return (
    <div
      className="absolute top-2 right-2 z-10 rounded-md overflow-hidden"
      style={{
        width: 220,
        maxHeight: "calc(100% - 16px)",
        background: "rgba(255,255,255,0.95)",
        backdropFilter: "blur(8px)",
        border: "1px solid rgba(45,41,38,0.08)",
        boxShadow: "0 2px 12px rgba(0,0,0,0.08)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* 头部：标题 + 收起按钮 */}
      <div
        className="flex items-center justify-between px-3 py-2 shrink-0"
        style={{ borderBottom: "1px solid rgba(45,41,38,0.06)" }}
      >
        <span className="text-[11px] font-semibold" style={{ color: "var(--clr-text)" }}>
          分类方式
        </span>
        <div className="flex items-center gap-1">
          {/* 色板选择 */}
          <select
            value={paletteKey}
            onChange={(e) => setPaletteKey(e.target.value)}
            className="text-[9px] px-1 py-0.5 rounded border-none"
            style={{ background: "transparent", color: "var(--clr-text-muted)", cursor: "pointer" }}
          >
            {Object.entries(PALETTES).map(([key, pal]) => (
              <option key={key} value={key}>{pal.name}</option>
            ))}
          </select>
          <button
            onClick={() => setCollapsed(true)}
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-black/5"
            style={{ color: "var(--clr-text-muted)", cursor: "pointer" }}
            title="收起"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* 可滚动内容区 */}
      <div className="overflow-y-auto flex-1 min-h-0">
        {availableGroups.map((g) => {
          const isActive = colorBy === g.key;
          const isExpanded = expanded.has(g.key);
          const vals = groupValues[g.key] || [];
          const counts = groupCounts[g.key] || {};
          const cmap = getGroupColorMap(g.key);

          return (
            <div key={g.key}>
              {/* Category 头部 — 可点击展开/折叠 */}
              <button
                onClick={() => {
                  setColorBy(g.key);
                  setExpanded(prev => {
                    const next = new Set(prev);
                    if (next.has(g.key)) next.delete(g.key);
                    else next.add(g.key);
                    return next;
                  });
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors"
                style={{
                  background: isActive ? "rgba(200,96,25,0.06)" : "transparent",
                  cursor: "pointer",
                  borderLeft: isActive ? "2px solid var(--clr-amber)" : "2px solid transparent",
                }}
              >
                {/* 展开/折叠箭头 */}
                <svg
                  width="8" height="8" viewBox="0 0 24 24" fill="none"
                  stroke={isActive ? "var(--clr-amber)" : "var(--clr-text-muted)"}
                  strokeWidth="3" strokeLinecap="round"
                  style={{
                    transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                    transition: "transform 0.15s",
                  }}
                >
                  <path d="M9 18l6-6-6-6" />
                </svg>
                <span
                  className="text-[11px] font-semibold flex-1"
                  style={{ color: isActive ? "var(--clr-amber-dark)" : "var(--clr-text)" }}
                >
                  {g.label}
                </span>
                <span className="text-[9px]" style={{ color: "var(--clr-text-faint)" }}>
                  {vals.length}
                </span>
              </button>

              {/* Category 值列表 */}
              {isExpanded && (
                <div className="px-3 pb-2">
                  {vals.map((v) => {
                    const color = cmap.get(v) || [180, 180, 180];
                    const isHidden = hiddenClusters.has(v) && isActive;
                    const count = counts[v] || 0;
                    // For merge selection: check by mergeIdKey
                    // If mergeIdKey="cluster", need to check if any cluster with this celltype is selected
                    const mergeIdsForVal = mergeIdKey !== colorBy
                      ? points.filter(p => (p[colorBy as keyof typeof p] as string) === v).map(p => p[mergeIdKey])
                      : [v];
                    const isMergeSelected = isActive && mergeIdsForVal.some(id => selectedForMerge?.has(id));
                    return (
                      <button
                        key={v}
                        onClick={() => {
                          if (!isActive) return;
                          if (mergeMode && onToggleMerge) {
                            // Toggle all merge IDs for this value
                            const uniqueIds = [...new Set(mergeIdsForVal)];
                            const allSelected = uniqueIds.every(id => selectedForMerge?.has(id));
                            for (const id of uniqueIds) {
                              if (allSelected ? selectedForMerge?.has(id) : !selectedForMerge?.has(id)) {
                                onToggleMerge(id);
                              }
                            }
                          } else {
                            toggleCluster(v);
                          }
                        }}
                        className="flex items-center gap-1.5 w-full text-left py-[3px] text-[11px] transition-opacity"
                        style={{
                          opacity: isHidden && !isMergeActive ? 0.3 : 1,
                          cursor: mergeMode ? (isActive ? "pointer" : "default") : (isActive ? "pointer" : "default"),
                          background: isMergeSelected ? "rgba(200,96,25,0.12)" : "transparent",
                          borderRadius: 4,
                        }}
                      >
                        {/* Merge checkbox (only for active category) */}
                        {isMergeActive && isActive ? (
                          <input
                            type="checkbox"
                            checked={isMergeSelected}
                            readOnly
                            className="w-3 h-3 accent-[#C86019] flex-shrink-0"
                            style={{ pointerEvents: "none" }}
                          />
                        ) : (
                          <span
                            className="inline-block w-[10px] h-[10px] rounded-full flex-shrink-0"
                            style={{ background: `rgb(${color[0]},${color[1]},${color[2]})` }}
                          />
                        )}
                        <span
                          className="flex-1 truncate"
                          style={{
                            color: "var(--clr-text)",
                            textDecoration: isHidden && !mergeMode ? "line-through" : "none",
                            fontWeight: isMergeSelected ? 600 : 400,
                          }}
                          title={v}
                        >
                          {v}
                        </span>
                        <span className="text-[9px] tabular-nums" style={{ color: "var(--clr-text-faint)" }}>
                          {count.toLocaleString()}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface DeckScatterPlotProps {
  data: ScatterData | null;
  method?: "UMAP" | "tSNE" | "PCA";
  height?: number;
  children?: React.ReactNode;
  mergeMode?: boolean;
  selectedForMerge?: Set<string>;
  onToggleMerge?: (celltype: string) => void;
  onColorByChange?: (colorBy: string) => void;
  /** Which field to use for merge selection: "celltype" (default) or "cluster" */
  mergeIdKey?: "celltype" | "cluster";
  /** Controlled colorBy — if set, overrides internal state */
  colorBy?: string;
  /** 不显示的分类字段 */
  excludeGroups?: string[];
}

/** 将平行数组转为点对象数组（deck.gl accessor 需要） */
function toPoints(data: ScatterData) {
  const result: { x: number; y: number; cluster: string; celltype: string; sample: string; group: string; idx: number }[] = [];
  for (let i = 0; i < data.x.length; i++) {
    result.push({
      x: data.x[i],
      y: data.y[i],
      cluster: data.cluster[i],
      celltype: data.celltype?.[i] ?? data.cluster[i],
      sample: data.sample?.[i] ?? "",
      group: data.group?.[i] ?? "",
      idx: i,
    });
  }
  return result;
}

export default function DeckScatterPlot({
  data,
  method = "UMAP",
  height = 500,
  children,
  mergeMode,
  selectedForMerge,
  onToggleMerge,
  onColorByChange,
  mergeIdKey = "celltype",
  colorBy: colorByProp,
  excludeGroups,
}: DeckScatterPlotProps) {
  const [hoverInfo, setHoverInfo] = useState<{
    x: number;
    y: number;
    object?: { x: number; y: number; cluster: string; celltype: string; sample: string; group: string; idx: number };
  } | null>(null);

  // deck.gl ref（用于坐标转换）
  const deckRef = useRef<any>(null);

  // 图例：哪些聚类被隐藏
  const [hiddenClusters, setHiddenClusters] = useState<Set<string>>(new Set());


  // 色板选择
  const [paletteKey, setPaletteKey] = useState(DEFAULT_PALETTE);
  const currentPalette = PALETTES[paletteKey]?.colors || PALETTES[DEFAULT_PALETTE].colors;

  // 分组选择（默认 celltype，不可用时回退 cluster）
  const [colorByInternal, setColorBy] = useState<string>("sample");
  // 使用受控 prop 或内部状态
  const colorBy = colorByProp ?? colorByInternal;

  // 通知父组件 colorBy 变化
  useEffect(() => {
    onColorByChange?.(colorBy);
  }, [colorBy, onColorByChange]);

  // 将平行数组 → 对象数组（仅在数据变化时重算）
  const points = useMemo(() => (data ? toPoints(data) : []), [data]);

  // 当前分组可用的字段列表
  // 旧数据没有 celltype 字段时，cluster 里存的其实是 CellType 标签，动态改标签
  const availableGroups = useMemo(() => {
    if (!data) return [];
    const d = data as Record<string, unknown>;
    const ct = d.celltype;
    const cl = d.cluster;
    const hasCelltype = !!ct && Array.isArray(ct);
    // 区分注释结果（celltype != cluster）和聚类结果（celltype == cluster）
    const isAnnotate = hasCelltype && Array.isArray(cl) &&
      (ct as string[]).some((v, i) => v !== (cl as string[])[i]);
    let opts: { key: string; label: string }[];
    if (isAnnotate) {
      opts = [
        { key: "celltype", label: "CellType" },
        { key: "sample", label: "Sample" },
        { key: "group", label: "Group" },
        { key: "cluster", label: "Cluster" },
      ];
    } else if (hasCelltype) {
      opts = [
        { key: "celltype", label: "CellType" },
        { key: "group", label: "Group" },
      ];
    } else {
      opts = [
        { key: "sample", label: "Sample" },
        { key: "group", label: "Group" },
      ];
    }
    return opts.filter(g => {
      if (excludeGroups?.includes(g.key)) return false;
      if (g.key === "group") {
        const gArr = d.group;
        if (!Array.isArray(gArr) || new Set(gArr as string[]).size <= 1) return false;
        // 如果 group 和 sample 完全一样，说明是旧数据回退，不显示
        const sArr = d.sample;
        if (Array.isArray(sArr) && gArr.length === sArr.length &&
            (gArr as string[]).every((v, i) => v === (sArr as string[])[i])) return false;
        return true;
      }
      return true;
    });
  }, [data, excludeGroups]);

  // 如果当前 colorBy 不在可用列表中，自动回退
  useEffect(() => {
    if (availableGroups.length > 0 && !availableGroups.some(g => g.key === colorBy)) {
      setColorBy(availableGroups[0].key);
    }
  }, [availableGroups, colorBy]);

  // 提取唯一分组列表并按自然数值排序
  const clusters = useMemo(() => {
    if (!data) return [];
    const key = colorBy as keyof typeof points[0];
    const unique = Array.from(new Set(points.map(p => p[key] as string)));
    unique.sort((a, b) => {
      const numA = parseInt(a.replace(/\D/g, ""), 10);
      const numB = parseInt(b.replace(/\D/g, ""), 10);
      if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
      return a.localeCompare(b);
    });
    return unique;
  }, [data, points, colorBy]);

  // 聚类 → 颜色索引映射
  const colorMap = useMemo(() => {
    const map = new Map<string, [number, number, number]>();
    clusters.forEach((c, i) => {
      map.set(c, currentPalette[i % currentPalette.length]);
    });
    return map;
  }, [clusters, currentPalette]);

  // 计算数据边界 → 初始视口
  const initialViewState = useMemo(() => {
    if (!data || data.x.length === 0) {
      return { target: [0, 0], zoom: 1 };
    }
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
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
    // zoom 公式：log2(视口像素 / 数据范围)
    const zoom = Math.log2(Math.min(600, height) / maxRange) - 0.3;
    return { target: [cx, cy], zoom: Math.max(-2, Math.min(zoom, 10)) };
  }, [data, height]);

  // 可控视口状态（用于重置）
  const [viewState, setViewState] = useState(initialViewState);
  const resetView = useCallback(() => setViewState(initialViewState), [initialViewState]);

  // 获取当前分组值的辅助函数
  const getGroupValue = useCallback((p: { cluster: string; celltype: string; sample: string; group: string }) => {
    return p[colorBy as keyof typeof p] as string || p.cluster;
  }, [colorBy]);

  // 过滤后的点（排除隐藏聚类）
  const filteredPoints = useMemo(() => {
    if (hiddenClusters.size === 0) return points;
    return points.filter((p) => !hiddenClusters.has(getGroupValue(p)));
  }, [points, hiddenClusters, getGroupValue]);

  const onHover = useCallback(
    (info: { x: number; y: number; object?: unknown }) => {
      if (info.object) {
        setHoverInfo(
          info as { x: number; y: number; object: { x: number; y: number; cluster: string; celltype: string; sample: string; group: string; idx: number } }
        );
      } else {
        setHoverInfo(null);
      }
    },
    []
  );

  // 图例点击
  const toggleCluster = useCallback((cluster: string) => {
    setHiddenClusters((prev) => {
      const next = new Set(prev);
      if (next.has(cluster)) {
        next.delete(cluster);
      } else {
        next.add(cluster);
      }
      return next;
    });
  }, []);

  if (!data) {
    return (
      <div
        className="flex items-center justify-center rounded-lg"
        style={{
          height,
          background: "var(--clr-bg-alt)",
          border: "1px solid rgba(45,41,38,0.06)",
        }}
      >
        <div className="text-center" style={{ color: "var(--clr-text-faint)" }}>
          <p className="text-sm">📈 {method} 可视化</p>
          <p className="text-xs mt-1">等待分析完成后加载数据</p>
        </div>
      </div>
    );
  }

  const isMergeActive = selectedForMerge && selectedForMerge.size > 0;
  // 选中内容的 key，用于触发 deck.gl 重绘（size 不变但内容变化时）
  const selectionKey = selectedForMerge ? [...selectedForMerge].sort().join(",") : "";

  const mainLayer = new ScatterplotLayer({
    id: "scatter",
    data: filteredPoints,
    getPosition: (d: { x: number; y: number }) => [d.x, d.y],
    getFillColor: (d: { cluster: string; celltype: string; sample: string; group: string }) => {
      const val = getGroupValue(d);
      const c = colorMap.get(val) || [128, 128, 128];
      if (isMergeActive) {
        const mergeId = d[mergeIdKey] ?? d.celltype;
        const alpha = selectedForMerge!.has(mergeId) ? 235 : 12;
        return [c[0], c[1], c[2], alpha];
      }
      return [c[0], c[1], c[2], 102];
    },
    stroked: false,
    getRadius: 4,
    radiusUnits: "pixels" as const,
    radiusMinPixels: 2,
    radiusMaxPixels: 8,
    pickable: true,
    onHover,
    onClick: (info: { object?: { cluster: string; celltype: string; sample: string; group: string } }) => {
      if (!mergeMode || !info.object || !onToggleMerge) return false;
      const mergeId = info.object[mergeIdKey] ?? info.object.celltype;
      onToggleMerge(mergeId);
      return true;
    },
    updateTriggers: {
      getFillColor: [hiddenClusters.size, paletteKey, colorBy, isMergeActive, selectionKey, mergeIdKey],
    },
  });

  const layers = [mainLayer];

  return (
    <div className="relative" style={{ height }}>
      {/* deck.gl 画布 — Nature 风格白底 */}
      <div
        className="overflow-hidden"
        style={{
          height,
          background: "#FFFFFF",
          borderRadius: 0,
          border: "none",
        }}
      >
        <DeckGL
          ref={deckRef}
          views={new OrthographicView({})}
          viewState={viewState}
          controller={{ minZoom: 0, maxZoom: 8 }}
          layers={layers}
          onViewStateChange={({ viewState: vs }: { viewState: Record<string, unknown> }) => setViewState(vs)}
          style={{ position: "relative", width: "100%", height: "100%" }}
        />

        {/* 重置视图按钮 — Nature 风格极简 */}
        <button
          onClick={resetView}
          title="恢复默认视图"
          className="absolute top-2 left-2 z-20 flex items-center justify-center w-6 h-6 rounded transition-opacity opacity-40 hover:opacity-80"
          style={{
            background: "rgba(255,255,255,0.9)",
            border: "1px solid rgba(0,0,0,0.1)",
            cursor: "pointer",
            backdropFilter: "blur(4px)",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--clr-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
        </button>
      </div>

      {/* Tooltip */}
      {hoverInfo?.object && (
        <div
          className="absolute pointer-events-none z-10 px-3 py-2 rounded-md text-xs"
          style={{
            left: hoverInfo.x + 12,
            top: hoverInfo.y - 40,
            background: "rgba(30,27,24,0.92)",
            color: "#fff",
            backdropFilter: "blur(4px)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            maxWidth: 200,
          }}
        >
          <div className="font-semibold" style={{ color: "var(--clr-gold)" }}>
            {getGroupValue(hoverInfo.object)}
          </div>
          <div className="mt-0.5 opacity-80">
            {method}_1: {hoverInfo.object.x.toFixed(3)}
          </div>
          <div className="opacity-80">
            {method}_2: {hoverInfo.object.y.toFixed(3)}
          </div>
          <div className="opacity-60 mt-0.5">Cell #{hoverInfo.object.idx}</div>
        </div>
      )}

      {/* CellXgene 风格侧边栏图例 */}
      <LegendSidebar
        availableGroups={availableGroups}
        colorBy={colorBy}
        setColorBy={(v) => { setColorBy(v); setHiddenClusters(new Set()); }}
        paletteKey={paletteKey}
        setPaletteKey={setPaletteKey}
        clusters={clusters}
        colorMap={colorMap}
        hiddenClusters={hiddenClusters}
        toggleCluster={toggleCluster}
        data={data}
        mergeMode={mergeMode}
        selectedForMerge={selectedForMerge}
        onToggleMerge={onToggleMerge}
        mergeIdKey={mergeIdKey}
      />

      {/* 左下角信息 — Nature 风格极简 */}
      <div
        className="absolute bottom-2 left-2 z-10 text-[10px] px-1.5 py-0.5"
        style={{
          color: "#999",
          background: "transparent",
        }}
      >
        {data.x.length.toLocaleString()} cells
      </div>

      {/* 外部注入的额外元素（如下载按钮） */}
      {children}
    </div>
  );
}
