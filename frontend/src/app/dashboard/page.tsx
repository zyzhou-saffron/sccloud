/**
 * scCloud v2 — 项目管理仪表盘
 * ComputaBio 暖色学术风格
 */
"use client";

import { useEffect, useState } from "react";
import { IconFolder, IconDNA } from "../components/Icons";
import {
  createProject,
  deleteProject,
  listProjects,
  type Project,
} from "../lib/api";

export default function DashboardPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newSpecies, setNewSpecies] = useState("human");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchProjects = async () => {
    try {
      const data = await listProjects();
      setProjects(data.projects || []);
    } catch {
      setProjects([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchProjects(); }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true); setError(null);
    try {
      await createProject({ name: newName.trim(), description: newDesc || undefined, species: newSpecies });
      setShowNew(false); setNewName(""); setNewDesc("");
      fetchProjects();
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    } finally { setCreating(false); }
  };

  const handleDownload = async (project: Project) => {
    const token = localStorage.getItem("access_token");
    try {
      const res = await fetch(`/api/projects/${project.id}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`下载失败 (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="?(.+?)"?$/);
      a.download = match?.[1] || `${project.name}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert("下载失败: " + (e instanceof Error ? e.message : "未知错误"));
    }
  };

  const handleDelete = async (id: number, name: string) => {
    if (!confirm(`确定删除项目 "${name}" 吗？此操作不可撤销。`)) return;
    try {
      await deleteProject(id);
      fetchProjects();
    } catch { alert("删除失败"); }
  };

  const inputCls = "w-full px-3 py-2 bg-white border rounded text-sm focus:outline-none focus:ring-2 focus:ring-[#C86019]/30";

  return (
    <div className="animate-fade-in space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ fontFamily: "var(--font-serif)", color: "var(--clr-dark-deep)" }}>项目管理</h1>
          <p className="text-sm mt-1" style={{ color: "var(--clr-text-muted)" }}>管理你的单细胞分析项目</p>
        </div>
        <button
          onClick={() => setShowNew(true)}
          className="px-4 py-2 text-white font-medium rounded text-sm transition-all shadow-md"
          style={{ background: "var(--clr-amber)" }}
        >
          + 新建项目
        </button>
      </div>

      {/* New Project Form */}
      {showNew && (
        <div className="card animate-fade-in">
          <div className="card-label">新建项目</div>
          <div className="grid gap-4 md:grid-cols-3 mt-3">
            <div>
              <label className="block text-sm mb-1" style={{ color: "var(--clr-text-muted)" }}>项目名称</label>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="输入项目名称" className={inputCls} style={{ borderColor: "var(--clr-border)" }} />
            </div>
            <div>
              <label className="block text-sm mb-1" style={{ color: "var(--clr-text-muted)" }}>物种</label>
              <select value={newSpecies} onChange={(e) => setNewSpecies(e.target.value)} className={inputCls} style={{ borderColor: "var(--clr-border)" }}>
                <option value="human">Human (人类)</option>
                <option value="mouse">Mouse (小鼠)</option>
              </select>
            </div>
            <div>
              <label className="block text-sm mb-1" style={{ color: "var(--clr-text-muted)" }}>描述 (可选)</label>
              <input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="项目描述" className={inputCls} style={{ borderColor: "var(--clr-border)" }} />
            </div>
          </div>
          {error && <div className="callout callout-danger text-xs mt-3">{error}</div>}
          <div className="flex gap-3 mt-4">
            <button onClick={handleCreate} disabled={!newName.trim() || creating} className="px-4 py-2 text-white rounded text-sm transition-colors flex items-center gap-2 disabled:opacity-40" style={{ background: "var(--clr-amber)" }}>
              {creating && <svg className="w-3 h-3" viewBox="0 0 24 24" style={{ animation: "spin 1s linear infinite" }}><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>}
              创建
            </button>
            <button onClick={() => { setShowNew(false); setError(null); }} className="px-4 py-2 border rounded text-sm transition-colors" style={{ borderColor: "var(--clr-border)", color: "var(--clr-text-muted)" }}>取消</button>
          </div>
        </div>
      )}

      {/* Projects Grid */}
      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="card animate-pulse">
              <div className="h-5 rounded w-2/3 mb-3" style={{ background: "var(--clr-bg-alt)" }}></div>
              <div className="h-3 rounded w-1/2 mb-4" style={{ background: "var(--clr-bg-alt)" }}></div>
              <div className="h-8 rounded w-1/3" style={{ background: "var(--clr-bg-alt)" }}></div>
            </div>
          ))}
        </div>
      ) : projects.length === 0 ? (
        <div className="card p-12 text-center flex flex-col items-center">
          <IconFolder size={48} className="mb-4 opacity-30" />
          <h3 className="text-lg font-medium mb-2" style={{ fontFamily: "var(--font-serif)", color: "var(--clr-dark)" }}>暂无项目</h3>
          <p className="text-sm mb-4" style={{ color: "var(--clr-text-muted)" }}>创建你的第一个单细胞分析项目</p>
          <button onClick={() => setShowNew(true)} className="px-4 py-2 border rounded text-sm transition-colors" style={{ borderColor: "var(--clr-amber)", color: "var(--clr-amber)" }}>+ 新建项目</button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <div key={project.id} className="card group hover:shadow-md transition-all">
              <div className="flex items-start justify-between mb-3">
                <h3 className="font-semibold transition-colors" style={{ fontFamily: "var(--font-serif)", color: "var(--clr-dark)" }}>{project.name}</h3>
                <div className="flex items-center gap-2">
                  <span className="badge">{project.status}</span>
                  <button onClick={() => handleDownload(project)} className="opacity-0 group-hover:opacity-100 transition-all text-xs mr-1" style={{ color: "var(--clr-amber)" }} title="下载项目文件">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  </button>
                  <button onClick={() => handleDelete(project.id, project.name)} className="opacity-0 group-hover:opacity-100 transition-all text-xs" style={{ color: "var(--clr-text-faint)" }} title="删除项目">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6" /></svg>
                  </button>
                </div>
              </div>
              {project.description && (
                <p className="text-sm mb-3 line-clamp-2" style={{ color: "var(--clr-text-muted)" }}>{project.description}</p>
              )}
              <div className="flex items-center justify-between">
                <span className="text-xs flex items-center gap-1.5" style={{ color: "var(--clr-text-faint)", fontFamily: "var(--font-mono)" }}>
                  <IconDNA size={12} className="text-stone-400" />
                  {project.species === "human" ? "Human" : "Mouse"}{" · "}{new Date(project.created_at + (!project.created_at.endsWith("Z") ? "Z" : "")).toLocaleDateString("zh-CN")}
                </span>
                <a href={`/dashboard/analysis?project=${project.id}`} className="text-xs font-medium transition-colors" style={{ color: "var(--clr-amber)" }}>开始分析 →</a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
