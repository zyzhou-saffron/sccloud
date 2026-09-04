/**
 * scCloud v2 — 分析流程向导页面（仅全流程分析）
 *
 * 单步分析 UI 已归档到 archive/single-step-ui（见 issue #16）。
 */
"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type MouseEvent } from "react";
import ProjectSelector from "../../components/ProjectSelector";
import { type Project, getAuthToken, tryRefresh } from "../../lib/api";
import PipelineForm from "./components/PipelineForm";
import PipelineView from "./components/PipelineView";

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

const SS_KEY = "sccloud_analysis_state";
function loadSession() {
  if (typeof window === "undefined") return null;
  try { return JSON.parse(sessionStorage.getItem(SS_KEY) || "null"); } catch { return null; }
}
function saveSession(patch: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  try {
    const prev = loadSession() || {};
    sessionStorage.setItem(SS_KEY, JSON.stringify({ ...prev, ...patch }));
  } catch { /* ignore */ }
}

function AnalysisPageContent() {
  const searchParams = useSearchParams();
  const initialProjectId = searchParams.get("project");
  const ss = loadSession();

  const [project, setProject] = useState<Project | null>(ss?.project ?? null);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>(
    ss?.uploadedFiles ?? (ss?.uploadedFile ? [ss.uploadedFile] : [])
  );
  const [sampleGroups, setSampleGroups] = useState<Record<string, string>>(
    ss?.sampleGroups ?? {}
  );
  const [activePipelineId, setActivePipelineId] = useState<string | null>(
    ss?.activePipelineId ?? null
  );

  const setActivePipelineIdPersist = (v: string | null | ((p: string | null) => string | null)) => {
    setActivePipelineId((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      saveSession({ activePipelineId: next });
      return next;
    });
  };

  useEffect(() => {
    const handlePipelineBack = () => setActivePipelineIdPersist(null);
    window.addEventListener("pipeline-back", handlePipelineBack);
    return () => window.removeEventListener("pipeline-back", handlePipelineBack);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    saveSession({ uploadedFiles, uploadedFile: uploadedFiles[0] ?? null });
  }, [uploadedFiles]);
  useEffect(() => {
    saveSession({ sampleGroups });
  }, [sampleGroups]);

  const handleExportProject = async (e: MouseEvent<HTMLButtonElement>) => {
    if (!project) return;
    const btn = e.currentTarget;
    const origHTML = btn.innerHTML;
    btn.innerHTML = '<span class="w-3 h-3 border-2 border-t-transparent rounded-full animate-spin"></span> 打包中...';
    btn.disabled = true;
    try {
      const dlUrl = `/api/projects/${project.id}/download`;
      let res = await fetch(dlUrl, { headers: { Authorization: `Bearer ${getAuthToken() || ""}` } });
      if (res.status === 401) {
        const nt = await tryRefresh();
        if (nt) res = await fetch(dlUrl, { headers: { Authorization: `Bearer ${nt}` } });
      }
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 100)}`);
      }
      const blob = await res.blob();
      if (blob.size === 0) throw new Error("打包文件为空，项目可能没有结果文件");
      const now = new Date();
      const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
      const filename = `${project.name}-${ts}.zip`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      alert("打包下载失败: " + (err instanceof Error ? err.message : ""));
    } finally {
      btn.innerHTML = origHTML;
      btn.disabled = false;
    }
  };

  const handleProjectSelect = (p: Project | null) => {
    setProject(p);
    setUploadedFiles([]);
    setSampleGroups({});
    setActivePipelineId(null);
    saveSession({
      project: p,
      uploadedFiles: [],
      uploadedFile: null,
      sampleGroups: {},
      activePipelineId: null,
    });
  };

  return (
    <div className="animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold" style={{ fontFamily: "var(--font-serif)", color: "var(--clr-dark-deep)" }}>
          scRNA分析
        </h1>
        <div className="flex items-center gap-3">
          <div className="w-72">
            <ProjectSelector
              selectedId={project?.id ?? (initialProjectId ? Number(initialProjectId) : null)}
              onSelect={handleProjectSelect}
            />
          </div>
        </div>
      </div>

      <div className="flex gap-2 mb-6 border-b" style={{ borderColor: "var(--clr-border)" }}>
        <button
          className="px-4 py-2 text-sm font-semibold border-b-2 transition-all"
          style={{ borderColor: "var(--clr-amber)", color: "var(--clr-amber)" }}
        >
          全流程分析
        </button>
      </div>

      {project ? (
        <div className="space-y-6">
          {!activePipelineId ? (
            <PipelineForm
              projectId={project.id}
              token={getAuthToken() || ""}
              onSubmit={(pipelineId) => setActivePipelineIdPersist(pipelineId)}
              uploadedFiles={uploadedFiles}
              onUploadedFilesChange={setUploadedFiles}
              sampleGroups={sampleGroups}
              onSampleGroupsChange={setSampleGroups}
              onExportProject={handleExportProject}
            />
          ) : (
            <PipelineView
              pipelineId={activePipelineId}
              token={getAuthToken() || ""}
              projectName={project?.name}
            />
          )}
        </div>
      ) : (
        <div className="p-6 rounded-lg border" style={{ borderColor: "var(--clr-border)", background: "rgba(255,0,0,0.05)" }}>
          <p style={{ color: "var(--clr-warn)" }}>请先选择一个项目</p>
        </div>
      )}
    </div>
  );
}

export default function AnalysisPage() {
  return (
    <Suspense fallback={<div className="p-8" style={{ color: "var(--clr-text-muted)" }}>加载中...</div>}>
      <AnalysisPageContent />
    </Suspense>
  );
}
