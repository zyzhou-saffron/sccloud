/**
 * scCloud v2 — 项目选择器 + 管理弹窗
 * ComputaBio 暖色学术风格
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IconFolder, IconChart, IconDNA } from "./Icons";
import {
  createProject,
  deleteProject,
  isGuest,
  getUserRole,
  listProjects,
  getProjectRemainingDays,
  type Project,
} from "../lib/api";

interface ProjectSelectorProps {
  selectedId: number | null;
  onSelect: (project: Project | null) => void;
}

export default function ProjectSelector({
  selectedId,
  onSelect,
}: ProjectSelectorProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSpecies, setNewSpecies] = useState("human");
  const [newDesc, setNewDesc] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guest, setGuest] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [showSpeciesDropdown, setShowSpeciesDropdown] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);

  const fetchProjects = useCallback(async () => {
    try {
      const data = await listProjects();
      setProjects(data.projects || []);
    } catch {
      setProjects([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProjects(); setGuest(isGuest()); }, [fetchProjects]);

  /** 项目列表加载完成后，若 selectedId 与任何项目都不匹配，主动清除过期选择 */
  useEffect(() => {
    if (!loading && selectedId !== null && projects.length >= 0) {
      const match = projects.find((p) => p.id === selectedId);
      if (!match) {
        onSelect(null);
      }
    }
  }, [loading, selectedId, projects, onSelect]);

  /** 游客是否已达到 1 个项目限制 */
  const role = getUserRole();
  const guestLimitReached = (guest || role === "user") && projects.length >= 1;

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false); setShowNew(false); setError(null); setDeletingId(null);
        setShowSpeciesDropdown(false);
      }
    };
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  useEffect(() => {
    const handleOpen = () => setOpen(true);
    window.addEventListener("open-project-selector", handleOpen);
    return () => window.removeEventListener("open-project-selector", handleOpen);
  }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true); setError(null);
    try {
      const p = await createProject({ name: newName.trim(), description: newDesc || undefined, species: newSpecies });
      await fetchProjects();
      onSelect(p);
      setNewName(""); setNewDesc(""); setShowNew(false); setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    } finally { setCreating(false); }
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteProject(id);
      await fetchProjects();
      if (id === selectedId) {
        const remaining = projects.filter((p) => p.id !== id);
        if (remaining.length > 0) {
          onSelect(remaining[0]);
        } else {
          onSelect(null);
        }
      }
      setDeletingId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  };

  const selected = projects.find((p) => p.id === selectedId);
  const inputCls = "w-full px-3 py-2 bg-white border rounded text-sm focus:outline-none focus:ring-2 focus:ring-[#C86019]/30";

  return (
    <div className="relative" ref={panelRef}>
      {/* 选择器按钮 */}
      <button
        onClick={() => { setOpen(!open); setShowNew(false); setError(null); setDeletingId(null); }}
        className="flex items-center gap-3 px-4 py-2 card hover:shadow-md transition-all text-sm w-full"
      >
        <IconChart className="text-[#C86019]" />
        <span className="flex-1 text-left" style={{ color: "var(--clr-text)" }}>
          {loading ? "加载中..." : selected ? `${selected.name} (${selected.species})` : "选择项目..."}
        </span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--clr-text-faint)", transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}><polyline points="6 9 12 15 18 9" /></svg>
      </button>

      {/* 弹出管理面板 — 始终挂载，通过 CSS transition 实现从顶部滑下动画 */}
      <div
        className="absolute top-full right-0 mt-2 w-96 z-50 rounded-lg overflow-hidden"
        style={{
          background: "var(--clr-bg-card)",
          border: open ? "1px solid var(--clr-border)" : "1px solid transparent",
          boxShadow: open ? "var(--shadow-lg)" : "none",
          maxHeight: open ? 600 : 0,
          opacity: open ? 1 : 0,
          transform: open ? "translateY(0)" : "translateY(-12px)",
          transition: "max-height 0.35s cubic-bezier(0.4,0,0.2,1), opacity 0.25s ease, transform 0.3s cubic-bezier(0.4,0,0.2,1), border-color 0.25s ease, box-shadow 0.25s ease",
          pointerEvents: open ? "auto" : "none",
        }}
      >
          {/* 标题栏 */}
          <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: "1px solid var(--clr-border)", background: "var(--clr-bg-alt)" }}>
            <h3 className="text-sm font-semibold" style={{ fontFamily: "var(--font-serif)", color: "var(--clr-dark)" }}>项目管理</h3>
            {!guestLimitReached && (
              <button
                onClick={() => { setShowNew(!showNew); setError(null); }}
                className="text-xs px-3 py-1 rounded transition-colors"
                style={{ background: "rgba(200,96,25,0.1)", color: "var(--clr-amber)" }}
              >
                {showNew ? "取消" : "+ 新建"}
              </button>
            )}
          </div>
          {guestLimitReached && (
            <div className="px-4 py-2 text-xs" style={{ background: "var(--clr-gold-soft)", color: "var(--clr-amber-dark)", borderBottom: "1px solid var(--clr-border)" }}>
              最多 1 个项目。注册账号以创建更多。
            </div>
          )}

          {/* 新建项目表单 */}
          {showNew && (
            <div className="p-4 space-y-3" style={{ borderBottom: "1px solid var(--clr-border)", background: "var(--clr-bg-alt)" }}>
              <div>
                <label className="block text-[10px] mb-1" style={{ color: "var(--clr-text-muted)" }}>项目名称 *</label>
                <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="例: PBMC_3k" className={inputCls} style={{ borderColor: "var(--clr-border)" }} autoFocus onKeyDown={(e) => e.key === "Enter" && handleCreate()} />
              </div>
              <div className="flex gap-2">
                <div className="flex-1 relative">
                  <label className="block text-[10px] mb-1" style={{ color: "var(--clr-text-muted)" }}>物种</label>
                  <button
                    onClick={() => setShowSpeciesDropdown(!showSpeciesDropdown)}
                    type="button"
                    className={`w-full text-left px-3 py-2 bg-white border rounded text-sm focus:outline-none focus:ring-2 focus:ring-[#C86019]/30 flex justify-between items-center transition-colors cursor-pointer ${showSpeciesDropdown ? 'border-[#C86019]' : 'border-[var(--clr-border)]'}`}
                  >
                    <span className="text-stone-700 capitalize">{newSpecies === 'mouse' ? 'Mouse' : 'Human'}</span>
                    <svg className={`w-4 h-4 text-stone-400 transition-transform ${showSpeciesDropdown ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                  </button>

                  {/* 自定义下拉菜单 */}
                  {showSpeciesDropdown && (
                    <div className="absolute top-full left-0 w-full mt-1 bg-white border rounded-lg shadow-lg z-50 py-1 overflow-hidden" style={{ borderColor: 'var(--clr-border)' }}>
                      {[
                        { value: 'human', label: 'Human' },
                        { value: 'mouse', label: 'Mouse' }
                      ].map((item) => (
                        <button
                          key={item.value}
                          onClick={() => {
                            setNewSpecies(item.value);
                            setShowSpeciesDropdown(false);
                          }}
                          className="w-full text-left px-3 py-2 text-sm text-stone-700 hover:bg-[#C86019]/10 transition-colors flex items-center justify-between group"
                        >
                          <span className="capitalize">{item.label}</span>
                          {newSpecies === item.value && (
                            <svg className="w-4 h-4 text-[#C86019]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path></svg>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex-1">
                  <label className="block text-[10px] mb-1" style={{ color: "var(--clr-text-muted)" }}>描述 (可选)</label>
                  <input type="text" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="简短描述" className={inputCls} style={{ borderColor: "var(--clr-border)" }} />
                </div>
              </div>
              {error && <div className="callout callout-danger text-xs">{error}</div>}
              <button onClick={handleCreate} disabled={creating || !newName.trim()} className="w-full py-2 text-white text-sm font-medium rounded transition-colors disabled:opacity-40" style={{ background: "var(--clr-amber)" }}>
                {creating ? "创建中..." : "创建项目"}
              </button>
            </div>
          )}

          {/* 项目列表 */}
          <div className="max-h-72 overflow-y-auto">
            {projects.length === 0 ? (
              <div className="p-8 text-center flex flex-col items-center">
                <IconFolder size={32} className="mb-2 opacity-30" />
                <p className="text-xs" style={{ color: "var(--clr-text-muted)" }}>暂无项目</p>
                <p className="text-[10px] mt-1" style={{ color: "var(--clr-text-faint)" }}>点击上方「+ 新建」创建第一个项目</p>
              </div>
            ) : (
              projects.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-3 px-4 py-3 transition-colors group"
                  style={{
                    borderBottom: "1px solid var(--clr-border)",
                    background: p.id === selectedId ? "rgba(200,96,25,0.04)" : undefined,
                  }}
                >
                  <button onClick={() => { onSelect(p); setOpen(false); }} className="flex-1 flex items-center gap-3 text-left">
                    <span className="text-stone-400"><IconDNA size={16} /></span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate" style={{ color: p.id === selectedId ? "var(--clr-amber)" : "var(--clr-dark)" }}>{p.name}</div>
                      <div className="text-[10px] flex items-center gap-2" style={{ color: "var(--clr-text-faint)" }}>
                        <span>{new Date(p.created_at + (!p.created_at.endsWith("Z") ? "Z" : "")).toLocaleDateString("zh-CN")}</span>
                        {(() => { const rem = getProjectRemainingDays(p.created_at); return rem > 0 ? (
                          <><span>·</span><span style={{ color: rem <= 2 ? "var(--clr-danger)" : undefined }}>剩余 {rem} 天</span></>
                        ) : (
                          <><span>·</span><span style={{ color: "var(--clr-danger)" }}>已过期</span></>
                        ); })()}
                        {p.description && <><span>·</span><span className="truncate">{p.description}</span></>}
                      </div>
                    </div>
                    {p.id === selectedId && (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-[#2D8A56]"><polyline points="20 6 9 17 4 12" /></svg>
                    )}
                  </button>

                  {deletingId === p.id ? (
                    <div className="flex items-center gap-1">
                      <button onClick={(e) => { e.stopPropagation(); handleDelete(p.id); }} className="text-[10px] px-2 py-1 rounded text-white" style={{ background: "var(--clr-danger)" }}>确认</button>
                      <button onClick={() => setDeletingId(null)} className="text-[10px] px-2 py-1 rounded" style={{ background: "var(--clr-bg-alt)", color: "var(--clr-text-muted)" }}>取消</button>
                    </div>
                  ) : (
                    <button onClick={(e) => { e.stopPropagation(); setDeletingId(p.id); }} className="opacity-0 group-hover:opacity-100 transition-all text-xs p-1" style={{ color: "var(--clr-text-faint)" }} title="删除项目">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6" /></svg>
                    </button>
                  )}
                </div>
              ))
            )}
          </div>

          {projects.length > 0 && (
            <div className="px-4 py-2 text-[10px]" style={{ borderTop: "1px solid var(--clr-border)", background: "var(--clr-bg-alt)", color: "var(--clr-text-faint)" }}>
              共 {projects.length} 个项目
            </div>
          )}
      </div>
    </div>
  );
}
