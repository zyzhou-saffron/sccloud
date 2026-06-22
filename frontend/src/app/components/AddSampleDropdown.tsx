/**
 * 添加样本下拉菜单
 * 两个选项：本地上传 / 从项目文件选择
 * 下拉菜单关闭后，模态框仍保持挂载
 */
"use client";

import React, { useEffect, useRef, useState } from "react";
import FileUploadModal from "./FileUploadModal";
import ProjectFilesModal, { type FileWithInspect } from "./ProjectFilesModal";

interface UploadedFile {
  name: string;
  path: string;
  metadata_columns?: string[];
  n_cells?: number;
  n_genes?: number;
  n_rows?: number;
  n_cols?: number;
  file_size_mb?: number;
  samples?: { name: string; cell_count: number }[];
  ensembl_version?: string;
}

interface AddSampleDropdownProps {
  isOpen: boolean;
  onClose: () => void;
  onFileUploaded: (file: UploadedFile) => void;
  onFilesSelected: (files: UploadedFile[]) => void;
  projectId: number;
  token: string;
  existingPaths: string[];
  sampleGroups?: Record<string, string>;
}

export default function AddSampleDropdown({
  isOpen,
  onClose,
  onFileUploaded,
  onFilesSelected,
  projectId,
  token,
  existingPaths,
  sampleGroups,
}: AddSampleDropdownProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [showProjectFiles, setShowProjectFiles] = useState(false);

  // 有模态框打开时，不渲染下拉菜单，但组件保持挂载
  const hasModal = showUpload || showProjectFiles;

  useEffect(() => {
    if (!isOpen || hasModal) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isOpen, onClose, hasModal]);

  // 当模态框全部关闭且下拉也不再 open 时，重置状态
  useEffect(() => {
    if (!isOpen && !hasModal) {
      // nothing to clean up
    }
  }, [isOpen, hasModal]);

  return (
    <>
      {/* Dropdown menu — 仅在 isOpen 且没有模态框打开时显示 */}
      {isOpen && !hasModal && (
        <div ref={ref} className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 rounded-lg overflow-hidden z-50 animate-fade-in"
          style={{
            background: "var(--clr-bg-card)",
            border: "1px solid var(--clr-border)",
            boxShadow: "var(--shadow-lg, 0 10px 25px rgba(0,0,0,0.12))",
          }}
        >
          <button
            onClick={() => setShowUpload(true)}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 text-xs transition-colors hover:bg-white/60"
            style={{ borderBottom: "1px solid var(--clr-border)", color: "var(--clr-text)" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--clr-amber)" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" /></svg>
            本地上传
          </button>
          <button
            onClick={() => setShowProjectFiles(true)}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 text-xs transition-colors hover:bg-white/60"
            style={{ color: "var(--clr-text)" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--clr-amber)" strokeWidth="2" strokeLinecap="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" /></svg>
            从项目文件选择
          </button>
        </div>
      )}

      {/* Upload modal */}
      <FileUploadModal
        isOpen={showUpload}
        onClose={() => { setShowUpload(false); onClose(); }}
        sampleGroups={sampleGroups}
        onFileUploaded={(file) => {
          onFileUploaded({
            name: file.name,
            path: file.path,
            metadata_columns: file.metadata_columns,
            n_cells: file.n_cells,
            n_genes: file.n_genes,
            n_rows: file.n_rows,
            n_cols: file.n_cols,
            file_size_mb: file.file_size_mb,
            samples: file.samples,
            ensembl_version: file.ensembl_version,
          });
        }}
        projectId={projectId}
        token={token}
      />

      {/* Project files modal */}
      <ProjectFilesModal
        isOpen={showProjectFiles}
        onClose={() => { setShowProjectFiles(false); onClose(); }}
        projectId={projectId}
        existingPaths={existingPaths}
        onFilesSelected={(results) => {
          const files: UploadedFile[] = results.map((r) => ({
            name: r.inspect.filename,
            path: r.path,
            metadata_columns: r.inspect.metadata_columns,
            n_cells: r.inspect.n_cells,
            n_genes: r.inspect.n_genes,
            n_rows: r.inspect.n_rows,
            n_cols: r.inspect.n_cols,
            file_size_mb: r.inspect.file_size_mb,
            samples: r.inspect.samples,
            ensembl_version: r.inspect.ensembl_version,
          }));
          onFilesSelected(files);
        }}
      />
    </>
  );
}
