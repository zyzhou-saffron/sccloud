/**
 * 文件上传模态框组件
 * 支持文件上传、解析和文件信息展示
 */
"use client";

import React, { useState, useRef } from "react";
import { createPortal } from "react-dom";
import { IconUpload } from "./Icons";

interface FileInfo {
  filename: string;
  n_cells?: number;
  n_genes?: number;
  n_rows: number;
  n_cols: number;
  genes: string[];
  gene_ids: string[];
  file_size_mb: number;
  metadata_columns: string[];
  samples?: { name: string; cell_count: number }[];
  ensembl_version?: string;
}

interface FileUploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  onFileUploaded: (file: { name: string; path: string; metadata_columns?: string[]; n_cells?: number; n_genes?: number; n_rows?: number; n_cols?: number; file_size_mb?: number; samples?: { name: string; cell_count: number }[]; ensembl_version?: string }) => void;
  projectId: number;
  token: string;
  sampleGroups?: Record<string, string>;
}

export default function FileUploadModal({
  isOpen,
  onClose,
  onFileUploaded,
  projectId,
  token,
  sampleGroups,
}: FileUploadModalProps) {
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [uploadedFile, setUploadedFile] = useState<{ name: string; path: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = async (file: File) => {
    const CHUNK = 5 * 1024 * 1024; // 5MB per chunk
    setUploadProgress(0);
    setError(null);
    setFileInfo(null);

    try {
      // 1. 初始化上传
      const initForm = new FormData();
      initForm.append("filename", file.name);
      initForm.append("file_size", String(file.size));
      const initRes = await fetch("/api/upload/init", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: initForm,
      });
      if (!initRes.ok) { const errData = await initRes.json().catch(() => ({})); throw new Error(errData.detail || "初始化上传失败"); }
      const { upload_id } = (await initRes.json()) as { upload_id: string };

      // 2. 分片上传
      const totalChunks = Math.ceil(file.size / CHUNK);
      for (let i = 0; i < totalChunks; i++) {
        const blob = file.slice(i * CHUNK, (i + 1) * CHUNK);
        const chunkForm = new FormData();
        chunkForm.append("upload_id", upload_id);
        chunkForm.append("chunk_index", String(i));
        chunkForm.append("chunk", blob, file.name);
        const chunkRes = await fetch("/api/upload/chunk", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: chunkForm,
        });
        if (!chunkRes.ok) throw new Error(`分片 ${i + 1} 上传失败`);
        setUploadProgress(Math.round(((i + 1) / totalChunks) * 70));
      }

      // 3. 先完成上传（合并分片），不依赖 R 引擎
      setUploadProgress(80);
      const completeForm = new FormData();
      completeForm.append("upload_id", upload_id);
      completeForm.append("project_id", String(projectId));
      if (sampleGroups && Object.keys(sampleGroups).length > 0) {
        completeForm.append("sample_groups", JSON.stringify(sampleGroups));
      }
      const completeRes = await fetch("/api/upload/complete", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: completeForm,
      });
      if (!completeRes.ok) {
        const errData = await completeRes.json().catch(() => ({}));
        throw new Error(errData.detail || "合并文件失败");
      }
      const { path: filePath } = (await completeRes.json()) as { path: string };

      setUploadProgress(90);
      setUploadedFile({ name: file.name, path: filePath });

      // 4. 解析文件信息（不阻塞上传，失败时用户仍可使用文件）
      setInspecting(true);
      try {
        const inspectForm = new FormData();
        inspectForm.append("file_path", filePath);
        const inspectRes = await fetch("/api/upload/inspect-path", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: inspectForm,
        });
        if (inspectRes.ok) {
          const info = (await inspectRes.json()) as FileInfo;
          setFileInfo(info);
        }
      } catch {
        // inspect 失败不影响上传结果
      }

      setUploadProgress(100);
      setTimeout(() => setUploadProgress(null), 500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败");
      setUploadProgress(null);
    } finally {
      setInspecting(false);
    }
  };

  const handleConfirm = () => {
    if (uploadedFile) {
      onFileUploaded({
        ...uploadedFile,
        metadata_columns: fileInfo?.metadata_columns,
        n_cells: fileInfo?.n_cells,
        n_genes: fileInfo?.n_genes,
        n_rows: fileInfo?.n_rows,
        n_cols: fileInfo?.n_cols,
        file_size_mb: fileInfo?.file_size_mb,
        samples: fileInfo?.samples,
        ensembl_version: fileInfo?.ensembl_version,
      });
      onClose();
    }
  };

  const handleReset = () => {
    setFileInfo(null);
    setUploadedFile(null);
    setUploadProgress(null);
    setError(null);
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* 背景遮罩 */}
      <div
        className="absolute inset-0 bg-black/20"
        onClick={onClose}
      />

      {/* 模态框内容 */}
      <div
        className="relative w-full max-w-3xl max-h-[90vh] overflow-hidden rounded-xl shadow-2xl animate-fade-in"
        style={{
          background: "var(--clr-bg-card)",
          border: "1px solid var(--clr-border)",
        }}
      >
        {/* 头部 */}
        <div
          className="flex items-center justify-between px-6 py-4"
          style={{
            borderBottom: "1px solid var(--clr-border)",
            background: "var(--clr-bg-alt)",
          }}
        >
          <div>
            <h2
              className="text-lg font-bold"
              style={{
                fontFamily: "var(--font-serif)",
                color: "var(--clr-dark-deep)",
              }}
            >
              上传数据文件
            </h2>
            <p className="text-xs mt-1" style={{ color: "var(--clr-text-muted)" }}>
              支持 .rds, .h5seurat, .h5ad, .h5, .rdata, .loom 格式
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-white/80 transition-colors"
            style={{ color: "var(--clr-text-muted)" }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 内容区域 */}
        <div className="p-6 overflow-y-auto" style={{ maxHeight: "calc(90vh - 140px)" }}>
          {/* 错误提示 */}
          {error && (
            <div
              className="mb-4 px-4 py-3 rounded-lg text-sm border"
              style={{
                borderColor: "var(--clr-danger)",
                background: "rgba(220, 53, 69, 0.05)",
                color: "var(--clr-danger)",
              }}
            >
              {error}
            </div>
          )}

          {/* 上传区域 */}
          {!uploadedFile && (
            <div
              className="border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all hover:border-[#C86019] hover:bg-[rgba(200,96,25,0.02)]"
              style={{
                borderColor: uploadProgress !== null ? "var(--clr-amber)" : "var(--clr-border)",
                background: uploadProgress !== null ? "rgba(200,96,25,0.03)" : undefined,
              }}
              onClick={() => {
                if (uploadProgress === null) {
                  fileInputRef.current?.click();
                }
              }}
            >
              <IconUpload
                size={48}
                className="mx-auto mb-4"
                style={{ color: "var(--clr-amber)" }}
              />
              <div
                className="text-base font-semibold mb-2"
                style={{ color: "var(--clr-amber-dark)" }}
              >
                {uploadProgress !== null ? "上传中..." : "点击选择文件或拖拽到此处"}
              </div>
              <div className="text-sm" style={{ color: "var(--clr-text-muted)" }}>
                支持 .rds, .h5seurat, .h5ad, .h5, .rdata, .loom 格式，最大 30GB
              </div>

              {/* 上传进度条 */}
              {uploadProgress !== null && (
                <div className="mt-6 space-y-2">
                  <div
                    className="flex justify-between text-sm"
                    style={{ color: "var(--clr-amber-dark)" }}
                  >
                    <span>{inspecting ? "解析文件中..." : "上传中..."}</span>
                    <span>{uploadProgress}%</span>
                  </div>
                  <div
                    className="w-full h-3 rounded-full overflow-hidden"
                    style={{ background: "var(--clr-border)" }}
                  >
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{
                        width: `${uploadProgress}%`,
                        background: "linear-gradient(90deg, var(--clr-amber), #E8913A)",
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept=".rds,.h5seurat,.h5ad,.h5,.rdata,.loom"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFileUpload(f);
              e.target.value = "";
            }}
          />

          {/* 已上传文件信息 */}
          {uploadedFile && (
            <div className="space-y-4">
              {/* 文件基本信息 */}
              <div
                className="p-4 rounded-lg border"
                style={{
                  borderColor: "#2D8A56",
                  background: "rgba(45,138,86,0.05)",
                }}
              >
                <div className="flex items-center gap-3 mb-3">
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#2D8A56"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span className="text-sm font-semibold" style={{ color: "#2D8A56" }}>
                    文件上传成功
                  </span>
                </div>
                <div className="text-sm" style={{ color: "var(--clr-text-muted)" }}>
                  {fileInfo ? `${fileInfo.filename} (${fileInfo.file_size_mb} MB)` : uploadedFile.name}
                </div>
              </div>

              {!fileInfo && inspecting && (
                <div className="p-4 rounded-lg border text-center" style={{ borderColor: "var(--clr-border)", background: "var(--clr-bg-alt)" }}>
                  <div className="text-sm" style={{ color: "var(--clr-text-muted)" }}>正在解析文件信息...</div>
                </div>
              )}
              {fileInfo && (<>
              {/* 文件维度信息 */}
              <div
                className="p-4 rounded-lg border"
                style={{
                  borderColor: "var(--clr-border)",
                  background: "var(--clr-bg-alt)",
                }}
              >
                <h3
                  className="text-sm font-semibold mb-3"
                  style={{
                    fontFamily: "var(--font-serif)",
                    color: "var(--clr-dark-deep)",
                  }}
                >
                  数据维度
                </h3>
                <div className="grid grid-cols-2 gap-4">
                  <div className="text-center p-3 rounded-lg bg-white">
                    <div
                      className="text-2xl font-bold"
                      style={{ color: "var(--clr-amber)" }}
                    >
                      {(fileInfo.n_cells ?? fileInfo.n_rows).toLocaleString()}
                    </div>
                    <div className="text-xs mt-1" style={{ color: "var(--clr-text-muted)" }}>
                      细胞数
                    </div>
                  </div>
                  <div className="text-center p-3 rounded-lg bg-white">
                    <div
                      className="text-2xl font-bold"
                      style={{ color: "var(--clr-amber)" }}
                    >
                      {(fileInfo.n_genes ?? fileInfo.n_cols).toLocaleString()}
                    </div>
                    <div className="text-xs mt-1" style={{ color: "var(--clr-text-muted)" }}>
                      基因数
                    </div>
                  </div>
                </div>
                <div
                  className="text-center mt-3 text-sm font-semibold"
                  style={{ color: "var(--clr-text)" }}
                >
                  {(fileInfo.n_cells ?? fileInfo.n_rows).toLocaleString()} 细胞 × {(fileInfo.n_genes ?? fileInfo.n_cols).toLocaleString()} 基因
                </div>
              </div>

              {/* 基因名 Ensemble ID 表格 */}
              <div
                className="p-4 rounded-lg border"
                style={{
                  borderColor: "var(--clr-border)",
                  background: "var(--clr-bg-alt)",
                }}
              >
                <h3
                  className="text-sm font-semibold mb-3"
                  style={{
                    fontFamily: "var(--font-serif)",
                    color: "var(--clr-dark-deep)",
                  }}
                >
                  基因名预览 (前 100 个)
                </h3>
                <div
                  className="overflow-auto rounded-lg border"
                  style={{
                    borderColor: "var(--clr-border)",
                    maxHeight: "300px",
                  }}
                >
                  <table className="w-full text-sm">
                    <thead>
                      <tr
                        style={{
                          background: "var(--clr-bg-alt)",
                          borderBottom: "1px solid var(--clr-border)",
                        }}
                      >
                        <th
                          className="px-4 py-2 text-left font-semibold"
                          style={{ color: "var(--clr-text-muted)" }}
                        >
                          #
                        </th>
                        <th
                          className="px-4 py-2 text-left font-semibold"
                          style={{ color: "var(--clr-text-muted)" }}
                        >
                          基因名
                        </th>
                        <th
                          className="px-4 py-2 text-left font-semibold"
                          style={{ color: "var(--clr-text-muted)" }}
                        >
                          Ensemble ID
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {fileInfo.genes.map((gene, index) => (
                        <tr
                          key={index}
                          className="hover:bg-white/50 transition-colors"
                          style={{
                            borderBottom: "1px solid var(--clr-border)",
                          }}
                        >
                          <td
                            className="px-4 py-2"
                            style={{
                              color: "var(--clr-text-faint)",
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            {index + 1}
                          </td>
                          <td
                            className="px-4 py-2 font-medium"
                            style={{ color: "var(--clr-text)" }}
                          >
                            {gene}
                          </td>
                          <td
                            className="px-4 py-2"
                            style={{
                              color: fileInfo.gene_ids[index] === "N/A"
                                ? "var(--clr-text-faint)"
                                : "var(--clr-amber-dark)",
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            {fileInfo.gene_ids[index]}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {(fileInfo.n_genes ?? fileInfo.n_cols) > 100 && (
                  <div
                    className="text-xs mt-2 text-center"
                    style={{ color: "var(--clr-text-faint)" }}
                  >
                    仅显示前 100 个基因，共 {(fileInfo.n_genes ?? fileInfo.n_cols).toLocaleString()} 个
                  </div>
                )}
              </div>

              </>)}
              {/* 操作按钮 */}
              <div className="flex gap-3 pt-2">
                <button
                  onClick={handleReset}
                  className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-all"
                  style={{
                    border: "1px solid var(--clr-border)",
                    color: "var(--clr-text-muted)",
                    background: "var(--clr-bg-alt)",
                  }}
                >
                  重新上传
                </button>
                <button
                  onClick={handleConfirm}
                  className="flex-1 px-4 py-2.5 rounded-lg text-sm font-semibold text-white transition-all"
                  style={{ background: "var(--clr-amber)" }}
                >
                  确认使用此文件
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
