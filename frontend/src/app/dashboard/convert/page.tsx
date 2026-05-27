/**
 * scCloud v2 — 多样本 MTX 整合页面 (暖白学术风格)
 *
 * 单文件格式转换已融合到分析流程的上传环节（自动转换）。
 * 本页仅保留多样本 10X MTX 整合功能。
 */
"use client";

import { useState, useCallback } from "react";
import { apiFetch } from "../../lib/api";

/* ===== 接口类型 ===== */
interface MergeResult {
  status: string;
  cells?: number;
  genes?: number;
  file_size_mb?: number;
  download_url?: string;
  output_path?: string;
  n_samples?: number;
}

/* ===== 样本条目 ===== */
interface SampleEntry {
  id: string;
  name: string;
  group: string;
  file: File | null;
}

/* ===== 步骤锚点组件 ===== */
function StepAnchor({ step, title, subtitle }: { step: number; title: string; subtitle?: string }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <div
        className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white"
        style={{ background: "linear-gradient(135deg, var(--clr-amber-dark), var(--clr-amber))" }}
      >
        {step}
      </div>
      <div>
        <p className="text-sm font-semibold" style={{ color: "var(--clr-text)" }}>{title}</p>
        {subtitle && <p className="text-xs" style={{ color: "var(--clr-text-faint)" }}>{subtitle}</p>}
      </div>
    </div>
  );
}

/* ===== 带认证下载 ===== */
async function authDownload(url: string, filename: string) {
  const token = localStorage.getItem("access_token");
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("下载失败");
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function ConvertPage() {
  // ===== MTX 整合状态 =====
  const [samples, setSamples] = useState<SampleEntry[]>([
    { id: "s1", name: "Sample1", group: "", file: null },
    { id: "s2", name: "Sample2", group: "", file: null },
  ]);
  const [merging, setMerging] = useState(false);
  const [mergeResult, setMergeResult] = useState<MergeResult | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);

  /* ===== MTX 整合 ===== */
  const handleMerge = useCallback(async () => {
    const validSamples = samples.filter((s) => s.file && s.name.trim());
    if (validSamples.length < 1) return;
    setMerging(true);
    setMergeResult(null);
    setMergeError(null);

    try {
      const formData = new FormData();
      validSamples.forEach((s) => {
        formData.append("sample_names", s.name);
        formData.append("sample_groups", s.group || s.name);
        formData.append("files", s.file!);
      });

      const data: MergeResult = await apiFetch("/api/convert/mtx-merge", {
        method: "POST",
        body: formData,
      });
      setMergeResult(data);
    } catch (e) {
      setMergeError(e instanceof Error ? e.message : "整合失败");
    } finally {
      setMerging(false);
    }
  }, [samples]);

  const addSample = () => {
    const id = `s${Date.now()}`;
    setSamples((prev) => [
      ...prev,
      { id, name: `Sample${prev.length + 1}`, group: "", file: null },
    ]);
  };

  const removeSample = (id: string) => {
    setSamples((prev) => prev.filter((s) => s.id !== id));
  };

  /* ===== 渲染 ===== */
  return (
    <div className="animate-fade-in space-y-5">
      {/* 页面标题 */}
      <div>
        <h1 className="text-xl font-bold" style={{ color: "var(--clr-text)" }}>
          多样本 MTX 整合
        </h1>
        <p className="text-xs mt-1" style={{ color: "var(--clr-text-faint)" }}>
          整合多个 10X CellRanger 样本为单个 Seurat RDS 文件
        </p>
      </div>

      {/* 说明 */}
      <div className="p-4 rounded-xl text-xs" style={{ background: "var(--clr-gold-soft)", border: "1px solid rgba(200,96,25,0.15)", color: "var(--clr-amber-dark)" }}>
        <p className="font-semibold mb-1">使用说明</p>
        <p>每个样本上传一个 ZIP 压缩包，包含 10X CellRanger 输出的 3 个文件：</p>
        <p className="font-mono mt-1">matrix.mtx.gz、features.tsv.gz、barcodes.tsv.gz</p>
      </div>

      {/* Step 1: 样本列表 */}
      <div className="p-5 rounded-xl" style={{ background: "var(--clr-card)", border: "1px solid var(--clr-border)" }}>
        <StepAnchor step={1} title="添加样本" subtitle="为每个样本命名并上传对应的 ZIP 包" />
        <div className="space-y-3" style={{ maxHeight: "400px", overflowY: "auto" }}>
          {samples.map((s, idx) => (
            <div key={s.id} className="flex items-center gap-3 p-3 rounded-lg" style={{ background: "var(--clr-bg)", border: "1px solid var(--clr-border)" }}>
              <span className="text-xs font-mono w-6 text-center" style={{ color: "var(--clr-text-faint)" }}>#{idx + 1}</span>
              <input
                type="text"
                value={s.name}
                onChange={(e) => setSamples((prev) => prev.map((x) => x.id === s.id ? { ...x, name: e.target.value } : x))}
                className="text-sm px-2 py-1 rounded border w-32"
                style={{ borderColor: "var(--clr-border)", color: "var(--clr-text)", background: "white" }}
                placeholder="样本名"
              />
              <input
                type="text"
                value={s.group}
                onChange={(e) => setSamples((prev) => prev.map((x) => x.id === s.id ? { ...x, group: e.target.value } : x))}
                className="text-sm px-2 py-1 rounded border w-24"
                style={{ borderColor: "var(--clr-border)", color: "var(--clr-text)", background: "white" }}
                placeholder="分组名"
              />
              <label className="flex-1 flex items-center gap-2 text-xs cursor-pointer" style={{ color: s.file ? "#15803d" : "var(--clr-text-faint)" }}>
                <input
                  type="file"
                  accept=".zip"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0] || null;
                    setSamples((prev) => prev.map((x) => x.id === s.id ? { ...x, file: f } : x));
                  }}
                />
                {s.file ? `${s.file.name} (${(s.file.size / 1024 / 1024).toFixed(1)}MB)` : "点击上传 ZIP"}
              </label>
              {samples.length > 1 && (
                <button
                  onClick={() => removeSample(s.id)}
                  className="text-xs px-2 py-1 rounded transition-colors"
                  style={{ color: "var(--clr-text-faint)" }}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>

        <button
          onClick={addSample}
          className="mt-3 w-full py-2 rounded-lg text-sm font-medium transition-all"
          style={{ border: "1px dashed var(--clr-amber)", color: "var(--clr-amber-dark)", background: "transparent" }}
        >
          + 添加样本
        </button>
      </div>

      {/* Step 2: 整合按钮 */}
      <div className="p-5 rounded-xl" style={{ background: "var(--clr-card)", border: "1px solid var(--clr-border)" }}>
        <StepAnchor step={2} title="执行整合" subtitle={`已选 ${samples.filter((s) => s.file).length} / ${samples.length} 个样本`} />
        <button
          onClick={handleMerge}
          disabled={merging || samples.filter((s) => s.file).length < 1}
          className="w-full py-3 rounded-lg font-semibold text-sm text-white transition-all disabled:opacity-40 flex items-center justify-center gap-2"
          style={{ background: "linear-gradient(135deg, var(--clr-amber-dark), var(--clr-amber))" }}
        >
          {merging ? (
            <>
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              整合中...
            </>
          ) : (
            `开始整合 (${samples.filter((s) => s.file).length} 个样本)`
          )}
        </button>
      </div>

      {/* 整合错误 */}
      {mergeError && (
        <div className="p-3 rounded-lg text-xs" style={{ background: "rgba(220,38,38,0.06)", border: "1px solid rgba(220,38,38,0.15)", color: "#b91c1c" }}>
          {mergeError}
        </div>
      )}

      {/* 整合结果 */}
      {mergeResult && mergeResult.status === "success" && (
        <div className="p-4 rounded-xl space-y-2" style={{ background: "rgba(22,163,74,0.05)", border: "1px solid rgba(22,163,74,0.15)" }}>
          <p className="text-sm font-semibold" style={{ color: "#15803d" }}>整合完成</p>
          <div className="text-xs space-y-1" style={{ color: "var(--clr-text-faint)" }}>
            <p>样本数: <strong style={{ color: "var(--clr-text)" }}>{mergeResult.n_samples}</strong></p>
            {mergeResult.cells != null && <p>总细胞数: <strong style={{ color: "var(--clr-text)" }}>{mergeResult.cells.toLocaleString()}</strong></p>}
            {mergeResult.genes != null && <p>总基因数: <strong style={{ color: "var(--clr-text)" }}>{mergeResult.genes.toLocaleString()}</strong></p>}
            {mergeResult.file_size_mb != null && <p>文件大小: <strong style={{ color: "var(--clr-text)" }}>{mergeResult.file_size_mb} MB</strong></p>}
          </div>
          {mergeResult.download_url && (
            <button
              onClick={() => authDownload(mergeResult.download_url!, `merged_${samples.length}samples.rds`)}
              className="mt-2 w-full py-2 rounded-lg text-sm font-medium text-white transition-all"
              style={{ background: "linear-gradient(135deg, #15803d, #22c55e)" }}
            >
              下载整合 RDS
            </button>
          )}
        </div>
      )}
    </div>
  );
}
