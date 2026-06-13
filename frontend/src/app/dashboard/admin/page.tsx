"use client";

import React, { useEffect, useState, useCallback } from "react";
import { listUsers, updateUser, deleteUser, type AdminUser } from "../../lib/api";

export default function AdminPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editUser, setEditUser] = useState<AdminUser | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [batchLoading, setBatchLoading] = useState(false);
  const pageSize = 20;

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listUsers(page, pageSize, search);
      setUsers(data.users);
      setTotal(data.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载用户列表失败");
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const toggleSelect = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const selectable = users.filter(u => u.username !== 'Linli');
    if (selected.size === selectable.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectable.map(u => u.id)));
    }
  };

  const batchDelete = async () => {
    if (selected.size === 0) return;
    if (!confirm(`确定要删除选中的 ${selected.size} 个用户吗？此操作不可撤销。`)) return;
    setBatchLoading(true);
    let ok = 0, fail = 0;
    for (const id of selected) {
      try { await deleteUser(id); ok++; }
      catch { fail++; }
    }
    setBatchLoading(false);
    setSelected(new Set());
    if (fail > 0) alert(`已删除 ${ok} 个，${fail} 个失败（可能包含受保护账户）`);
  loadUsers();
  };

  const batchSetRole = async (role: string) => {
    if (selected.size === 0) return;
    setBatchLoading(true);
    let ok = 0, fail = 0;
    for (const id of selected) {
      try { await updateUser(id, { role }); ok++; }
      catch { fail++; }
    }
    setBatchLoading(false);
    setSelected(new Set());
    if (fail > 0) alert(`已更新 ${ok} 个，${fail} 个失败`);
  loadUsers();
  };

  const handleEdit = (user: AdminUser) => {
    setEditUser({ ...user });
  };

  const handleSave = async () => {
    if (!editUser) return;
    try {
      await updateUser(editUser.id, {
        role: editUser.role,
        max_projects: editUser.max_projects,
        total_quota: editUser.total_quota,
        used_quota: editUser.used_quota,
        is_active: editUser.is_active,
      });
      setEditUser(null);
      loadUsers();
    } catch (e) {
      alert("更新失败: " + (e instanceof Error ? e.message : "未知错误"));
    }
  };

  const handleDelete = async (user: AdminUser) => {
    if (!confirm(`确定要删除用户 "${user.username}" 吗？此操作不可撤销。`)) return;
    try {
      await deleteUser(user.id);
      loadUsers();
    } catch (e) {
      alert("删除失败: " + (e instanceof Error ? e.message : "未知错误"));
    }
  };

  const totalPages = Math.ceil(total / pageSize);

  const inputCls =
    "w-full px-2.5 py-1.5 rounded border text-xs transition-all focus:outline-none";
  const inputStyle: React.CSSProperties = {
    borderColor: "var(--clr-border)",
    background: "var(--clr-bg-card)",
    color: "var(--clr-text)",
  };

  return (
    <div className="space-y-4">
      {/* 标题栏 */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold" style={{ color: "var(--clr-text)" }}>
            用户管理
          </h2>
          <p className="text-xs mt-0.5" style={{ color: "var(--clr-text-faint)" }}>
            共 {total} 个用户
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="搜索用户名..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className={inputCls}
            style={{ ...inputStyle, width: 200 }}
          />
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 rounded text-xs" style={{ background: "var(--clr-danger)", color: "#fff" }}>
          {error}
        </div>
      )}

      {/* 工具栏 */}
      <div className="flex items-center gap-2">
        <button
          onClick={toggleSelectAll}
          className="px-3 py-1.5 rounded text-xs font-medium transition-all border"
          style={{
            color: "var(--clr-text-muted)",
            borderColor: "var(--clr-border)",
          }}
        >
          {selected.size > 0 ? "取消全选" : "全选"}
        </button>
        <span className="text-[10px]" style={{ color: "var(--clr-text-faint)" }}>
          {`已选 ${selected.size} 个`}
        </span>
      </div>

      {/* 批量操作栏 */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 px-3 py-2 rounded-lg" style={{ background: "var(--clr-amber)", color: "#fff" }}>
          <span className="text-xs font-medium">已选 {selected.size} 个用户</span>
          <button
            onClick={() => batchSetRole("user")}
            disabled={batchLoading}
            className="px-2.5 py-1 rounded text-[11px] font-medium bg-white/20 hover:bg-white/30 transition-all"
          >
            批量设为注册用户
          </button>
          <button
            onClick={() => batchSetRole("super")}
            disabled={batchLoading}
            className="px-2.5 py-1 rounded text-[11px] font-medium bg-white/20 hover:bg-white/30 transition-all"
          >
            批量设为付费用户
          </button>
          <button
            onClick={() => batchSetRole("admin")}
            disabled={batchLoading}
            className="px-2.5 py-1 rounded text-[11px] font-medium bg-white/20 hover:bg-white/30 transition-all"
          >
            批量设为管理员
          </button>
          <button
            onClick={batchDelete}
            disabled={batchLoading}
            className="px-2.5 py-1 rounded text-[11px] font-medium ml-auto"
            style={{ background: "rgba(255,255,255,0.25)", color: "#fff" }}
          >
            {batchLoading ? "处理中..." : "批量删除"}
          </button>
        </div>
      )}

      {/* 用户表格 */}
      <div className="overflow-x-auto rounded-lg border" style={{ borderColor: "var(--clr-border)" }}>
        <table className="w-full text-xs">
          <thead>
            <tr style={{ background: "var(--clr-bg-alt)" }}>
              <th className="px-3 py-2 w-8">
                <input
                  type="checkbox"
                  checked={selected.size === users.length && users.length > 0}
                  onChange={() => toggleSelectAll()}
                />
              </th>
              <th className="px-3 py-2 text-left font-medium" style={{ color: "var(--clr-text-muted)" }}>ID</th>
              <th className="px-3 py-2 text-left font-medium" style={{ color: "var(--clr-text-muted)" }}>用户名</th>
              <th className="px-3 py-2 text-left font-medium" style={{ color: "var(--clr-text-muted)" }}>用户类型</th>
              <th className="px-3 py-2 text-left font-medium" style={{ color: "var(--clr-text-muted)" }}>操作配额</th>
              <th className="px-3 py-2 text-left font-medium" style={{ color: "var(--clr-text-muted)" }}>项目上限</th>
              <th className="px-3 py-2 text-left font-medium" style={{ color: "var(--clr-text-muted)" }}>状态</th>
              <th className="px-3 py-2 text-right font-medium" style={{ color: "var(--clr-text-muted)" }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center" style={{ color: "var(--clr-text-faint)" }}>
                  加载中...
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center" style={{ color: "var(--clr-text-faint)" }}>
                  暂无用户
                </td>
              </tr>
            ) : (
              users.map((u) => (
                <tr
                  key={u.id}
                  className="border-t transition-colors hover:bg-opacity-50"
                  style={{ borderColor: "var(--clr-border)", background: selected.has(u.id) ? "rgba(200,96,25,0.06)" : undefined }}
                >
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(u.id)}
                      onChange={() => toggleSelect(u.id)}
                      disabled={u.username === "Linli"}
                      style={u.username === "Linli" ? { opacity: 0.3, cursor: "not-allowed" } : undefined}
                    />
                  </td>
                  <td className="px-3 py-2 font-mono" style={{ color: "var(--clr-text-faint)" }}>{u.id}</td>
                  <td className="px-3 py-2 font-medium" style={{ color: "var(--clr-text)" }}>
                    {u.username}
                    {u.username === "Linli" && (
                      <span className="ml-1.5 px-1 py-0.5 rounded text-[9px] font-bold" style={{ background: "var(--clr-amber)", color: "#fff" }}>主管理员</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                      style={{
                        background: u.role === "admin" ? "var(--clr-amber)" : u.is_guest ? "var(--clr-bg-alt)" : "var(--clr-bg-alt)",
                        color: u.role === "admin" ? "#fff" : "var(--clr-text-muted)",
                      }}
                    >
                      {u.role === "admin" ? "admin" : u.is_guest ? "guest" : "user"}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono" style={{ color: "var(--clr-text-muted)" }}>
                    {u.used_quota}/{u.total_quota}
                  </td>
                  <td className="px-3 py-2 font-mono" style={{ color: "var(--clr-text-muted)" }}>{u.max_projects}</td>
                  <td className="px-3 py-2">
                    <span
                      className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                      style={{
                        background: u.is_active ? "var(--clr-success)" : "var(--clr-danger)",
                        color: "#fff",
                      }}
                    >
                      {u.is_active ? "正常" : "停用"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => handleEdit(u)}
                      className="px-2 py-1 rounded text-[10px] font-medium mr-1 transition-all hover:opacity-80"
                      style={{ background: "var(--clr-amber)", color: "#fff" }}
                    >
                      编辑
                    </button>
                    <button
                      onClick={() => handleDelete(u)}
                      disabled={u.username === "Linli"}
                      className="px-2 py-1 rounded text-[10px] font-medium transition-all hover:opacity-80"
                      style={u.username === "Linli" ? { background: "#ccc", color: "#999", cursor: "not-allowed" } : { background: "var(--clr-danger)", color: "#fff" }}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-1">
          <button
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
            className="px-2 py-1 rounded text-xs disabled:opacity-30"
            style={{ color: "var(--clr-text-muted)" }}
          >
            ‹ 上一页
          </button>
          <span className="text-xs" style={{ color: "var(--clr-text-faint)" }}>
            {page} / {totalPages}
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage(page + 1)}
            className="px-2 py-1 rounded text-xs disabled:opacity-30"
            style={{ color: "var(--clr-text-muted)" }}
          >
            下一页 ›
          </button>
        </div>
      )}

      {/* 编辑弹窗 */}
      {editUser && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.4)" }}
          onClick={() => setEditUser(null)}
        >
          <div
            className="rounded-xl shadow-2xl p-6 w-full max-w-md space-y-4"
            style={{ background: "var(--clr-bg-card)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-bold" style={{ color: "var(--clr-text)" }}>
              编辑用户 — {editUser.username}
            </h3>

            <div className="space-y-3">
              <div>
                <label className="block text-[10px] font-medium mb-1" style={{ color: "var(--clr-text-faint)" }}>
                  角色
                </label>
                <select
                  value={editUser.role}
                  onChange={(e) => {
                    const newRole = e.target.value;
                    const defaults: Record<string, { max_projects: number; total_quota: number }> = {
                      guest: { max_projects: 1, total_quota: 0 },
                      user:  { max_projects: 1, total_quota: 0 },
                      super: { max_projects: 5, total_quota: 100 },
                      admin: { max_projects: 99, total_quota: 99999 },
                    };
                    const d = defaults[newRole] || {};
                    setEditUser({
                      ...editUser,
                      role: newRole,
                      max_projects: d.max_projects ?? editUser.max_projects,
                      total_quota: d.total_quota ?? editUser.total_quota,
                    });
                  }}
                  className={inputCls}
                  style={inputStyle}
                >
                  <option value="guest">guest (游客)</option>
                  <option value="user">user (注册用户)</option>
                  <option value="super">super (付费用户)</option>
                  <option value="admin">admin (管理员)</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-medium mb-1" style={{ color: "var(--clr-text-faint)" }}>
                    操作配额
                  </label>
                  <input
                    type="number"
                    value={editUser.total_quota}
                    onChange={(e) => setEditUser({ ...editUser, total_quota: Number(e.target.value) })}
                    className={inputCls}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-medium mb-1" style={{ color: "var(--clr-text-faint)" }}>
                    已用次数
                  </label>
                  <input
                    type="number"
                    value={editUser.used_quota}
                    onChange={(e) => setEditUser({ ...editUser, used_quota: Number(e.target.value) })}
                    className={inputCls}
                    style={inputStyle}
                  />
                </div>
              </div>
              <div>
                <label className="block text-[10px] font-medium mb-1" style={{ color: "var(--clr-text-faint)" }}>
                  最大项目数
                </label>
                <input
                  type="number"
                  value={editUser.max_projects}
                  onChange={(e) => setEditUser({ ...editUser, max_projects: Number(e.target.value) })}
                  className={inputCls}
                  style={inputStyle}
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="isActive"
                  checked={editUser.is_active}
                  onChange={(e) => setEditUser({ ...editUser, is_active: e.target.checked })}
                />
                <label htmlFor="isActive" className="text-xs" style={{ color: "var(--clr-text)" }}>
                  账户启用
                </label>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setEditUser(null)}
                className="px-3 py-1.5 rounded text-xs"
                style={{ color: "var(--clr-text-muted)", border: "1px solid var(--clr-border)" }}
              >
                取消
              </button>
              <button
                onClick={handleSave}
                className="px-3 py-1.5 rounded text-xs font-medium text-white"
                style={{ background: "var(--clr-amber)" }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
