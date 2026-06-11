/**
 * Phase 2 参数选择页
 * Pipeline Phase 1 完成后（paused 状态），用户配置 Phase 2 分析参数。
 * 包含：markers、enrich、Monocle、CellChat、inferCNV 五个可选模块。
 */
"use client";

import React, { useEffect, useState } from "react";
import { resumePipeline, type Pipeline } from "../../../lib/pipeline-api";
import GeneExpressionPopup from "../../../components/GeneExpressionPopup";
import { createPortal } from "react-dom";
import { IconTestTube, IconPathway, IconBranch, IconNetwork, IconDNA } from "../../../components/Icons";
import { apiFetch } from "../../../lib/api";

interface Phase2ParamPageProps {
  pipeline: Pipeline;
  token: string;
  onComplete: () => void;
  species?: string;
}

const DEFAULT_PARAMS = {
  markers: { cluster: "All", min_pct: 0.1, logfc_threshold: 0.25, p_val_adj: 0.05, test_use: "wilcox", only_pos: true, ntop: 5, group_by: "CellType", plot_format: "png" },
  enrich: { pathway: "GO", direction: "Up", pvalue_cutoff: 0.05, qvalue_cutoff: 0.2, n_term: 10, p_adjust_method: "BH", plot_format: "png" },
  monocle: { group_beam: "CellType", group_traj: "CellType", min_expr_threshold: 0.5, min_cells_pct: 0.01, mean_expr: 0.3, qvalue1: 1e-5, reverse: false, plot_format: "png" },
  cellchat: { db_use: "Secreted", thresh: 0.05, min_cells: 10, prob_method: "triMean", top_pathways: 1, remove_isolate: false, plot_format: "png" },
  infercnv: { cutoff_gene: 0.1, num_threads: 4, species: "Human", infer_df: [] as { cellType: string; refType: string }[], plot_format: "png" },
  wgcna: { interest_types: [] as string[], min_fraction: 0.05, sft_threshold: 0.8, module_score: "Seurat", k: 25, max_shared: 10, min_cells: 100, n_hubs: 10, n_genes_score: 25, plot_format: "png" },
};

export default function Phase2ParamPage({ pipeline, token, onComplete, species = "Human" }: Phase2ParamPageProps) {
  const [enabled, setEnabled] = useState<Record<string, boolean>>({
    markers: true,
    wgcna: false,
    enrich: false,
    monocle: false,
    cellchat: false,
    infercnv: false,
  });
  const [params, setParams] = useState(DEFAULT_PARAMS);
  const [showAdvanced, setShowAdvanced] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  // ── WGCNA 基因表达查询 ──
  const [wgcnaGeneInput, setWgcnaGeneInput] = useState("");
  const [wgcnaActiveGene, setWgcnaActiveGene] = useState<string | null>(null);
  const [wgcnaGenePos, setWgcnaGenePos] = useState<{ x: number; y: number } | null>(null);
  const [wgcnaDropdownOpen, setWgcnaDropdownOpen] = useState(false);
  const [wgcnaDropdownPos, setWgcnaDropdownPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 });
  const wgcnaBtnRef = React.useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [allCellTypes, setAllCellTypes] = useState<string[]>([]);

  // 从 annotate 结果中获取 CellType 列表
  const annotateTask = pipeline.tasks.find(t => t.step === "annotate");
  useEffect(() => {
    const handleScroll = () => setWgcnaDropdownOpen(false);
    window.addEventListener("scroll", handleScroll, true);
    return () => window.removeEventListener("scroll", handleScroll, true);
  }, []);

  useEffect(() => {
    if (!annotateTask?.id) return;
    apiFetch<Record<string, unknown>>(`/api/tasks/${annotateTask.id}/result`)
      .then((data) => {
        if (!data) return;
        // 优先从 scatter_data.celltype 提取（与 Seurat 对象一致）
        // freq_table 可能在重命名后过时
        const scatterCt = data.scatter_data?.celltype as string[] | undefined;
        const freqTable = data.freq_table as { CellType: string }[] | undefined;
        let types: string[] = [];
        if (scatterCt && scatterCt.length > 0) {
          types = [...new Set(scatterCt)].sort();
        } else if (freqTable && freqTable.length > 0) {
          types = [...new Set(freqTable.map(r => r.CellType))].sort();
        }
        if (types.length > 0) {
          setAllCellTypes(types);
          setParams(prev => ({ ...prev, wgcna: { ...prev.wgcna, interest_types: [types[0]] } }));
          // 自动填充 infer_df：所有细胞类型默认为 query，用户手动标记 reference
          setParams(prev => {
            if (prev.infercnv.infer_df.length > 0) return prev;
            return { ...prev, infercnv: { ...prev.infercnv, infer_df: types.map(ct => ({ cellType: ct, refType: "query" })) } };
          });
        }
      })
      .catch(() => {});
  }, [annotateTask?.id]);

  const updateParam = (step: string, key: string, value: unknown) => {
    setParams(prev => ({ ...prev, [step]: { ...prev[step as keyof typeof prev], [key]: value } }));
  };

  const toggleInferRef = (ct: string) => {
    setParams(prev => {
      const existing = prev.infercnv.infer_df;
      const idx = existing.findIndex(d => d.cellType === ct);
      let newDf;
      if (idx >= 0) {
        // 切换 reference <-> query
        newDf = existing.map((d, i) => i === idx ? { ...d, refType: d.refType === "reference" ? "query" : "reference" } : d);
      } else {
        newDf = [...existing, { cellType: ct, refType: "reference" }];
      }
      return { ...prev, infercnv: { ...prev.infercnv, infer_df: newDf } };
    });
  };

  const handleSubmit = async () => {
    const enabledSteps = Object.entries(enabled).filter(([, v]) => v).map(([k]) => k);
    if (enabledSteps.length === 0) {
      setError("请至少选择一个分析步骤");
      return;
    }

    if (enabledSteps.includes("infercnv")) {
      const hasRef = params.infercnv.infer_df.some(d => d.refType === "reference");
      if (!hasRef) {
        setError("拷贝数变异分析必须至少标记一个「参考（正常）」细胞类型，请点击细胞类型进行标记");
        return;
      }
    }

    setLoading(true);
    setError(null);

    try {
      const phase2Params: Record<string, Record<string, unknown>> = {};
      const fmt = (params.markers.plot_format as string) || "png";
      for (const step of enabledSteps) {
        phase2Params[step] = { ...params[step as keyof typeof params], plot_format: fmt };
      }

      // For failed pipelines, resume via the resume endpoint (now accepts failed)
      // For paused pipelines, same flow as before
      await resumePipeline(token, pipeline.id, {
        params: phase2Params,
        enabled_steps: enabledSteps,
      });

      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "启动失败");
      setLoading(false);
    }
  };

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

  const MODULES = [
    {
      key: "markers",
      label: "差异基因分析",
      desc: "FindMarkers — 基于 CellType 分组的差异表达基因",
      Icon: IconTestTube,
    },
    {
      key: "enrich",
      label: "通路富集分析",
      desc: "GO / KEGG / GSEA — 差异基因功能富集",
      Icon: IconPathway,
    },
    {
      key: "monocle",
      label: "拟时序分析",
      desc: "Monocle 2 — 细胞发育轨迹推断与分支分析",
      Icon: IconBranch,
    },
    {
      key: "cellchat",
      label: "细胞通讯分析",
      desc: "CellChat — 配体-受体介导的细胞间通讯网络",
      Icon: IconNetwork,
    },
    {
      key: "infercnv",
      label: "拷贝数变异分析",
      desc: "inferCNV — 基于基因表达推断 CNV（需标记参考细胞）",
      Icon: IconDNA,
    },
    {
      key: "wgcna",
      label: "WGCNA 分析",
      desc: "加权基因共表达网络 — 识别基因模块与细胞类型关联",
      Icon: IconNetwork,
    },
  ];

  return (
    <div className="animate-fade-in space-y-4">
      {/* 标题 */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold" style={{ fontFamily: "var(--font-serif)", color: "var(--clr-dark-deep)" }}>
            Phase 2: 后续分析参数配置
          </h3>
          <p className="text-xs mt-1" style={{ color: "var(--clr-text-muted)" }}>
            选择要执行的分析步骤并配置参数，点击"开始分析"后串行执行。
          </p>
        </div>
        <div className="text-xs px-3 py-1.5 rounded" style={{ background: "rgba(45,138,86,0.1)", color: "#2D8A56" }}>
          注释已完成 · {allCellTypes.length} 种细胞类型
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="px-3 py-2 rounded text-xs border" style={{ borderColor: "var(--clr-danger)", background: "rgba(220,53,69,0.05)", color: "var(--clr-danger)" }}>
          {error}
        </div>
      )}

      {/* 分析模块卡片 */}
      <div className="space-y-2">
      {MODULES.map((mod) => {
        const isEnabled = enabled[mod.key];
        const isAdvanced = showAdvanced[mod.key];

        return (
          <div
            key={mod.key}
            className="card overflow-hidden transition-all duration-200"
            style={{
              borderColor: isEnabled ? "var(--clr-amber)" : "var(--clr-border)",
              opacity: isEnabled ? 1 : 0.7,
            }}
          >
            {/* 模块头部：toggle + 标题 */}
            <div
              className="px-4 py-2 flex items-center justify-between cursor-pointer"
              style={{ background: isEnabled ? "rgba(200,96,25,0.04)" : "var(--clr-bg-alt)" }}
              onClick={() => setEnabled(prev => ({ ...prev, [mod.key]: !prev[mod.key] }))}
            >
              <div className="flex items-center gap-3">
                <mod.Icon size={20} className={isEnabled ? "text-[#C86019]" : "text-[#999]"} />
                <div>
                  <div className="text-sm font-semibold" style={{ color: "var(--clr-text)" }}>{mod.label}</div>
                  <div className="text-xs" style={{ color: "var(--clr-text-faint)" }}>{mod.desc}</div>
                </div>
              </div>
              <div
                className="w-10 h-5 rounded-full relative transition-colors duration-200"
                style={{ background: isEnabled ? "var(--clr-amber)" : "var(--clr-border)" }}
              >
                <div
                  className="w-4 h-4 rounded-full bg-white absolute top-0.5 transition-transform duration-200"
                  style={{ transform: isEnabled ? "translateX(22px)" : "translateX(2px)" }}
                />
              </div>
            </div>

            {/* 参数区域 */}
            {isEnabled && (
              <div className="px-4 py-2.5 space-y-2.5" style={{ borderTop: "1px solid var(--clr-border)" }}>
                {/* markers 参数 */}
                {mod.key === "markers" && (
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>分组方式</label>
                        <select value={params.markers.group_by} onChange={(e) => updateParam("markers", "group_by", e.target.value)} className={selectCls} style={selectStyle}>
                          <option value="CellType">CellType</option>
                          <option value="Cluster">Cluster</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>检验方法</label>
                        <select value={params.markers.test_use} onChange={(e) => updateParam("markers", "test_use", e.target.value)} className={selectCls} style={selectStyle}>
                          <option value="wilcox">Wilcoxon</option><option value="t">t-test</option><option value="bimod">Bimod</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>最小细胞比例</label>
                        <input type="number" value={params.markers.min_pct} onChange={(e) => updateParam("markers", "min_pct", Number(e.target.value))} min={0} max={1} step={0.01} className={numberCls} style={inputStyle} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>log2FC 阈值</label>
                        <input type="number" value={params.markers.logfc_threshold} onChange={(e) => updateParam("markers", "logfc_threshold", Number(e.target.value))} step={0.05} className={numberCls} style={inputStyle} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>校正 P 值</label>
                        <input type="number" value={params.markers.p_val_adj} onChange={(e) => updateParam("markers", "p_val_adj", Number(e.target.value))} min={0} max={1} step={0.01} className={numberCls} style={inputStyle} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>仅显著上调</label>
                        <select value={String(params.markers.only_pos)} onChange={(e) => updateParam("markers", "only_pos", e.target.value === "true")} className={selectCls} style={selectStyle}>
                          <option value="true">是</option>
                          <option value="false">否（含下调）</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>每组展示基因数</label>
                        <input type="number" value={params.markers.ntop} onChange={(e) => updateParam("markers", "ntop", Number(e.target.value))} min={1} max={100} className={numberCls} style={inputStyle} />
                      </div>
                    </div>
                  </div>
                )}

                {/* enrich 参数 */}
                {mod.key === "enrich" && (
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>通路数据库</label>
                        <select value={params.enrich.pathway} onChange={(e) => updateParam("enrich", "pathway", e.target.value)} className={selectCls} style={selectStyle}>
                          <option value="GO">GO</option>
                          <option value="KEGG">KEGG</option>
                          <option value="GSEA">GSEA</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>方向</label>
                        <select value={params.enrich.direction} onChange={(e) => updateParam("enrich", "direction", e.target.value)} className={selectCls} style={selectStyle}>
                          <option value="Up">上调</option>
                          <option value="Down">下调</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>P值阈值</label>
                        <input type="number" value={params.enrich.pvalue_cutoff} onChange={(e) => updateParam("enrich", "pvalue_cutoff", Number(e.target.value))} min={0} max={1} step={0.01} className={numberCls} style={inputStyle} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>Q值阈值</label>
                        <input type="number" value={params.enrich.qvalue_cutoff} onChange={(e) => updateParam("enrich", "qvalue_cutoff", Number(e.target.value))} min={0} max={1} step={0.01} className={numberCls} style={inputStyle} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>显示条数</label>
                        <input type="number" value={params.enrich.n_term} onChange={(e) => updateParam("enrich", "n_term", Number(e.target.value))} min={1} max={50} className={numberCls} style={inputStyle} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>P 值校正方法</label>
                        <select value={params.enrich.p_adjust_method} onChange={(e) => updateParam("enrich", "p_adjust_method", e.target.value)} className={selectCls} style={selectStyle}>
                          <option value="BH">BH (FDR)</option>
                          <option value="bonferroni">Bonferroni</option>
                          <option value="holm">Holm</option>
                          <option value="hochberg">Hochberg</option>
                          <option value="hommel">Hommel</option>
                          <option value="BY">BY</option>
                        </select>
                      </div>
                    </div>
                  </div>
                )}

                {/* Monocle 参数 */}
                {mod.key === "monocle" && (
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>BEAM 分析分组</label>
                        <select value={params.monocle.group_beam} onChange={(e) => updateParam("monocle", "group_beam", e.target.value)} className={selectCls} style={selectStyle}>
                          <option value="CellType">CellType</option>
                          <option value="Cluster">Cluster</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>轨迹可视化分组</label>
                        <select value={params.monocle.group_traj} onChange={(e) => updateParam("monocle", "group_traj", e.target.value)} className={selectCls} style={selectStyle}>
                          <option value="CellType">CellType</option>
                          <option value="Cluster">Cluster</option>
                          <option value="State">State</option>
                          <option value="Pseudotime">Pseudotime</option>
                        </select>
                      </div>
                    </div>

                    {/* 高级选项 */}
                    <div>
                      <button
                        type="button"
                        onClick={() => setShowAdvanced(prev => ({ ...prev, monocle: !prev.monocle }))}
                        className="text-xs flex items-center gap-1 transition-colors"
                        style={{ color: "var(--clr-amber-dark)", cursor: "pointer" }}
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transform: isAdvanced ? "rotate(90deg)" : "none", transition: "transform 0.2s" }}><polyline points="9 6 15 12 9 18" /></svg>
                        高级选项
                      </button>
                      {isAdvanced && (
                        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-3">
                          <div>
                            <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>最低表达阈值</label>
                            <input type="number" value={params.monocle.min_expr_threshold} onChange={(e) => updateParam("monocle", "min_expr_threshold", Number(e.target.value))} step={0.1} className={numberCls} style={inputStyle} />
                          </div>
                          <div>
                            <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>最低细胞检出率</label>
                            <input type="number" value={params.monocle.min_cells_pct} onChange={(e) => updateParam("monocle", "min_cells_pct", Number(e.target.value))} min={0} max={1} step={0.005} className={numberCls} style={inputStyle} />
                          </div>
                          <div>
                            <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>离散基因均值阈值</label>
                            <input type="number" value={params.monocle.mean_expr} onChange={(e) => updateParam("monocle", "mean_expr", Number(e.target.value))} step={0.1} className={numberCls} style={inputStyle} />
                          </div>
                          <div>
                            <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>差异基因 q 值阈值</label>
                            <input type="number" value={params.monocle.qvalue1} onChange={(e) => updateParam("monocle", "qvalue1", Number(e.target.value))} step={0.00001} className={numberCls} style={inputStyle} />
                          </div>
                          <div>
                            <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>反转拟时序方向</label>
                            <select value={String(params.monocle.reverse)} onChange={(e) => updateParam("monocle", "reverse", e.target.value === "true")} className={selectCls} style={selectStyle}>
                              <option value="false">否</option>
                              <option value="true">是</option>
                            </select>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* CellChat 参数 */}
                {mod.key === "cellchat" && (
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>信号通路数据库</label>
                        <select value={params.cellchat.db_use} onChange={(e) => updateParam("cellchat", "db_use", e.target.value)} className={selectCls} style={selectStyle}>
                          <option value="Secreted">Secreted Signaling</option>
                          <option value="ECM-Receptor">ECM-Receptor</option>
                          <option value="Cell-Cell Contact">Cell-Cell Contact</option>
                          <option value="All">全部</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>概率计算方法</label>
                        <select value={params.cellchat.prob_method} onChange={(e) => updateParam("cellchat", "prob_method", e.target.value)} className={selectCls} style={selectStyle}>
                          <option value="triMean">triMean</option>
                          <option value="truncatedMean">truncatedMean</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>通讯显著性阈值</label>
                        <input type="number" value={params.cellchat.thresh} onChange={(e) => updateParam("cellchat", "thresh", Number(e.target.value))} min={0} max={0.5} step={0.01} className={numberCls} style={inputStyle} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>物种</label>
                        <div className="px-2 py-1.5 rounded text-xs border" style={{ borderColor: "var(--clr-border)", background: "var(--clr-bg-alt)", color: "var(--clr-text-muted)" }}>
                          {species}（自动）
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>最少细胞数</label>
                        <input type="number" value={params.cellchat.min_cells} onChange={(e) => updateParam("cellchat", "min_cells", Number(e.target.value))} min={1} max={500} className={numberCls} style={inputStyle} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>展示通路数</label>
                        <input type="number" value={params.cellchat.top_pathways} onChange={(e) => updateParam("cellchat", "top_pathways", Number(e.target.value))} min={1} max={20} className={numberCls} style={inputStyle} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>隐藏无通讯类型</label>
                        <select value={String(params.cellchat.remove_isolate)} onChange={(e) => updateParam("cellchat", "remove_isolate", e.target.value === "true")} className={selectCls} style={selectStyle}>
                          <option value="false">否（显示全部）</option>
                          <option value="true">是（仅显示有通讯）</option>
                        </select>
                      </div>
                    </div>
                  </div>
                )}

                {/* WGCNA 参数 */}
                {mod.key === "wgcna" && (
                  <div className="space-y-3">
                    <div className="relative">
                      <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>目标细胞类型</label>
                      <button
                        type="button"
                        ref={wgcnaBtnRef}
                        onClick={() => {
                          if (wgcnaBtnRef.current) {
                            const rect = wgcnaBtnRef.current.getBoundingClientRect();
                            setWgcnaDropdownPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
                          }
                          if (wgcnaBtnRef.current) {
                            const rect = wgcnaBtnRef.current.getBoundingClientRect();
                            setWgcnaDropdownPos({ top: rect.bottom + 4, left: rect.left, width: window.innerWidth > 640 ? 320 : rect.width });
                          }
                          setWgcnaDropdownOpen(!wgcnaDropdownOpen);
                        }}
                        className="w-full px-3 py-2 rounded border text-xs text-left flex items-center justify-between"
                        style={{ borderColor: "var(--clr-border)", background: "var(--clr-bg-card)", color: "var(--clr-text)" }}
                      >
                        <span className="truncate">
                          {params.wgcna.interest_types.length === 0
                            ? "-- 选择细胞类型 --"
                            : params.wgcna.interest_types.length === allCellTypes.length
                            ? "全部 (" + allCellTypes.length + " 种)"
                            : params.wgcna.interest_types.join(", ")
                          }
                        </span>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="6 9 12 15 18 9" /></svg>
                      </button>
                      {wgcnaDropdownOpen && createPortal(
                        <>
                          <div className="fixed inset-0 z-[9998]" onClick={() => setWgcnaDropdownOpen(false)} />
                          <div
                            className="fixed z-[9999] rounded-lg border shadow-xl py-1"
                            style={{
                              top: wgcnaDropdownPos.top,
                              left: wgcnaDropdownPos.left,
                              width: wgcnaDropdownPos.width,
                              maxHeight: "300px",
                              overflowY: "auto",
                              borderColor: "var(--clr-border)",
                              background: "var(--clr-bg-card)",
                            }}
                            onWheel={(e) => e.stopPropagation()}
                          >
                            <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-black/5 cursor-pointer text-xs font-medium" style={{ color: "var(--clr-text)" }}>
                              <input
                                type="checkbox"
                                checked={params.wgcna.interest_types.length === allCellTypes.length}
                                onChange={() => {
                                  if (params.wgcna.interest_types.length === allCellTypes.length) {
                                    updateParam("wgcna", "interest_types", []);
                                  } else {
                                    updateParam("wgcna", "interest_types", [...allCellTypes]);
                                  }
                                }}
                              />
                              ALL（全选）
                            </label>
                            <div className="mx-3 border-t" style={{ borderColor: "var(--clr-border)" }} />
                            {allCellTypes.map((ct) => (
                              <label key={ct} className="flex items-center gap-2 px-3 py-1.5 hover:bg-black/5 cursor-pointer text-xs" style={{ color: "var(--clr-text)" }}>
                                <input
                                  type="checkbox"
                                  checked={params.wgcna.interest_types.includes(ct)}
                                  onChange={() => {
                                    const next = params.wgcna.interest_types.includes(ct)
                                      ? params.wgcna.interest_types.filter((t: string) => t !== ct)
                                      : [...params.wgcna.interest_types, ct];
                                    updateParam("wgcna", "interest_types", next);
                                  }}
                                />
                                {ct}
                              </label>
                            ))}
                          </div>
                        </>,
                        document.body
                      )}
                      <p className="text-[10px] mt-1" style={{ color: "var(--clr-text-faint)" }}>
                        选择要分析的目标细胞类型，支持多选
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>最小细胞比例</label>
                        <input type="number" value={params.wgcna.min_fraction} onChange={(e) => updateParam("wgcna", "min_fraction", Number(e.target.value))} min={0} max={1} step={0.01} className={numberCls} style={inputStyle} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>软阈值</label>
                        <input type="number" value={params.wgcna.sft_threshold} onChange={(e) => updateParam("wgcna", "sft_threshold", Number(e.target.value))} min={0} max={1} step={0.05} className={numberCls} style={inputStyle} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>最近邻 K</label>
                        <input type="number" value={params.wgcna.k} onChange={(e) => updateParam("wgcna", "k", Number(e.target.value))} min={1} max={100} className={numberCls} style={inputStyle} />
                      </div>
                    </div>

                    {/* WGCNA 高级选项 */}
                    <div>
                      <button
                        type="button"
                        onClick={() => setShowAdvanced(prev => ({ ...prev, wgcna: !prev.wgcna }))}
                        className="text-xs flex items-center gap-1 transition-colors"
                        style={{ color: "var(--clr-amber-dark)", cursor: "pointer" }}
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transform: isAdvanced ? "rotate(90deg)" : "none", transition: "transform 0.2s" }}><polyline points="9 6 15 12 9 18" /></svg>
                        高级选项
                      </button>
                      {isAdvanced && (
                        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-3">
                          <div>
                            <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>模块评分方法</label>
                            <select value={params.wgcna.module_score} onChange={(e) => updateParam("wgcna", "module_score", e.target.value)} className={selectCls} style={selectStyle}>
                              <option value="Seurat">Seurat</option>
                              <option value="UCell">UCell</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>最大共享邻居数</label>
                            <input type="number" value={params.wgcna.max_shared} onChange={(e) => updateParam("wgcna", "max_shared", Number(e.target.value))} min={1} max={50} className={numberCls} style={inputStyle} />
                          </div>
                          <div>
                            <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>最少细胞数</label>
                            <input type="number" value={params.wgcna.min_cells} onChange={(e) => updateParam("wgcna", "min_cells", Number(e.target.value))} min={10} max={1000} className={numberCls} style={inputStyle} />
                          </div>
                          <div>
                            <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>Hub 基因数</label>
                            <input type="number" value={params.wgcna.n_hubs} onChange={(e) => updateParam("wgcna", "n_hubs", Number(e.target.value))} min={1} max={50} className={numberCls} style={inputStyle} />
                          </div>
                          <div>
                            <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>评分基因数</label>
                            <input type="number" value={params.wgcna.n_genes_score} onChange={(e) => updateParam("wgcna", "n_genes_score", Number(e.target.value))} min={5} max={100} className={numberCls} style={inputStyle} />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* inferCNV 参数 */}
                {mod.key === "infercnv" && (
                  <div className="space-y-4">
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>表达量截断值 (cutoff)</label>
                        <input type="number" value={params.infercnv.cutoff_gene} onChange={(e) => updateParam("infercnv", "cutoff_gene", Number(e.target.value))} min={0} step={0.01} className={numberCls} style={inputStyle} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--clr-text-muted)" }}>线程数</label>
                        <input type="number" value={params.infercnv.num_threads} onChange={(e) => updateParam("infercnv", "num_threads", Number(e.target.value))} min={1} max={16} className={numberCls} style={inputStyle} />
                      </div>
                    </div>

                    {/* 参考细胞类型标记 */}
                    <div>
                      <label className="block text-xs font-medium mb-2" style={{ color: "var(--clr-text-muted)" }}>
                        标记参考（正常）细胞类型
                      </label>
                      {allCellTypes.length === 0 ? (
                        <p className="text-xs" style={{ color: "var(--clr-text-faint)" }}>
                          未检测到 CellType 信息，请确保注释步骤已完成。
                        </p>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {allCellTypes.map(ct => {
                            const isRef = params.infercnv.infer_df.some(d => d.cellType === ct && d.refType === "reference");
                            return (
                              <button
                                key={ct}
                                type="button"
                                onClick={() => toggleInferRef(ct)}
                                className="px-3 py-1.5 rounded text-xs border transition-all duration-200"
                                style={{
                                  borderColor: isRef ? "#2D8A56" : "var(--clr-border)",
                                  background: isRef ? "rgba(45,138,86,0.1)" : "var(--clr-bg-alt)",
                                  color: isRef ? "#2D8A56" : "var(--clr-text-muted)",
                                  cursor: "pointer",
                                }}
                              >
                                {isRef && "✓ "}{ct}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <p className="text-[10px] mt-1.5" style={{ color: "var(--clr-text-faint)" }}>
                        点击标记为"正常参考"的细胞类型（绿色高亮）。未标记的将作为待检测组。
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      </div>

      {/* 图片格式选择 */}
      <div className="flex items-center gap-2 px-3 py-2 rounded text-xs mb-3" style={{ background: "rgba(200,96,25,0.04)", border: "1px solid rgba(200,96,25,0.15)" }}>
        <span style={{ color: "var(--clr-text-muted)" }}>图片格式:</span>
        <select value={(params.markers.plot_format as string) || "png"} onChange={(e) => { const v = e.target.value; setParams(prev => { const next = {...prev}; Object.keys(next).forEach(k => { next[k] = {...next[k], plot_format: v}; }); return next; }); }} style={{ border: "1px solid var(--clr-border)", borderRadius: 4, padding: "2px 6px", fontSize: 12, background: "white", color: "var(--clr-text)" }}>
          <option value="png">PNG (默认)</option>
          <option value="pdf">PDF</option>
        </select>
        <span style={{ color: "var(--clr-text-faint)", fontSize: 10 }}>不选默认PNG</span>
      </div>

      {/* 开始分析按钮 */}
      <button
        onClick={handleSubmit}
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
          `开始分析 (${Object.entries(enabled).filter(([, v]) => v).length} 个步骤)`
        )}
      </button>

      {/* WGCNA 基因表达弹窗 */}
      {wgcnaActiveGene && wgcnaGenePos && typeof window !== undefined && pipeline.project_id && createPortal(
        <GeneExpressionPopup
          gene={wgcnaActiveGene}
          projectId={pipeline.project_id}
          mousePos={wgcnaGenePos}
          onMouseLeave={() => { setWgcnaActiveGene(null); setWgcnaGenePos(null); }}
          token={token}
        />,
        document.body
      )}
    </div>
  );
}
