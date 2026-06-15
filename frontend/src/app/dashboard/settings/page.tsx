/**
 * scCloud v2 — 设置页面
 * ComputaBio 暖色学术风格
 */
"use client";

import { useEffect, useState } from "react";
import AuthModal from "../../components/AuthModal";
import { healthCheck, getAuthToken} from "../../lib/api";



interface Health {
  status: string;
  version: string;
  db: string;
  redis: string;
}

export default function SettingsPage() {
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [userRole, setUserRole] = useState("user");
  const [maxProjects, setMaxProjects] = useState(5);
  const [saving, setSaving] = useState(false);
  const [pwdMsg, setPwdMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [guest, setGuest] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);

  const username = typeof window !== "undefined" ? localStorage.getItem("username") : "";

  useEffect(() => {
    const token = getAuthToken();
    const isGuestUser = !token || token.startsWith("guest_") || (username || "").startsWith("guest_");
    setGuest(isGuestUser);
    if (isGuestUser) {
      setAuthOpen(true);
    }
    healthCheck().then(setHealth).catch(() => setHealth(null));
  }, []);

  const handleChangePassword = async () => {
    if (newPwd !== confirmPwd) { setPwdMsg({ ok: false, text: "两次密码不一致" }); return; }
    if (newPwd.length < 6) { setPwdMsg({ ok: false, text: "密码至少 6 位" }); return; }
    setSaving(true); setPwdMsg(null);
    try {
      const token = getAuthToken();
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ old_password: oldPwd, new_password: newPwd }),
      });
      if (res.ok) {
        setPwdMsg({ ok: true, text: "密码修改成功" });
        setOldPwd(""); setNewPwd(""); setConfirmPwd("");
      } else {
        const data = await res.json().catch(() => null);
        setPwdMsg({ ok: false, text: data?.detail || "修改失败" });
      }
    } catch { setPwdMsg({ ok: false, text: "网络错误" }); }
    finally { setSaving(false); }
  };

  const statusDot = (s: string) => {
    const color = s === "connected" ? "var(--clr-success)" : s.startsWith("error") ? "var(--clr-danger)" : "var(--clr-warn)";
    return <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: color }} />;
  };

  const inputCls = "w-full px-3 py-2 bg-white border rounded text-sm focus:outline-none focus:ring-2 focus:ring-[#C86019]/30";

  return (
    <div className="animate-fade-in max-w-2xl mx-auto space-y-6">
      {guest && authOpen && (
        <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} defaultTab="login" />
      )}
      <h1 className="text-2xl font-bold" style={{ fontFamily: "var(--font-serif)", color: "var(--clr-dark-deep)" }}>设置</h1>

      {/* Account Info */}
      <div className="card">
        <div className="card-label">账户信息</div>
        <div className="grid gap-3 text-sm mt-3">
          <div className="flex justify-between py-2" style={{ borderBottom: "1px solid var(--clr-border)" }}>
            <span style={{ color: "var(--clr-text-muted)" }}>用户名</span>
            <span className="font-medium" style={{ color: "var(--clr-dark)" }}>{username}</span>
          </div>
          <div className="flex justify-between py-2" style={{ borderBottom: "1px solid var(--clr-border)" }}>
            <span style={{ color: "var(--clr-text-muted)" }}>角色</span>
            <span className="badge">{userRole}</span>
          </div>
          <div className="flex justify-between py-2">
            <span style={{ color: "var(--clr-text-muted)" }}>项目上限</span>
            <span style={{ color: "var(--clr-dark)" }}>{maxProjects}</span>
          </div>
        </div>
      </div>

      {/* Password Change */}
      <div className="card">
        <div className="card-label">修改密码</div>
        <div className="space-y-4 mt-3">
          <div>
            <label className="block text-sm mb-1" style={{ color: "var(--clr-text-muted)" }}>当前密码</label>
            <input type="password" value={oldPwd} onChange={(e) => setOldPwd(e.target.value)} placeholder="输入当前密码" className={inputCls} style={{ borderColor: "var(--clr-border)" }} />
          </div>
          <div>
            <label className="block text-sm mb-1" style={{ color: "var(--clr-text-muted)" }}>新密码</label>
            <input type="password" value={newPwd} onChange={(e) => setNewPwd(e.target.value)} placeholder="至少 6 位" className={inputCls} style={{ borderColor: "var(--clr-border)" }} />
          </div>
          <div>
            <label className="block text-sm mb-1" style={{ color: "var(--clr-text-muted)" }}>确认新密码</label>
            <input type="password" value={confirmPwd} onChange={(e) => setConfirmPwd(e.target.value)} placeholder="再次输入新密码" className={inputCls} style={{ borderColor: "var(--clr-border)" }} />
          </div>

          {pwdMsg && (
            <div className={pwdMsg.ok ? "callout text-xs" : "callout callout-danger text-xs"}>
              {pwdMsg.text}
            </div>
          )}

          <button
            onClick={handleChangePassword}
            disabled={saving || !oldPwd || !newPwd || !confirmPwd}
            className="w-full py-2.5 text-white font-semibold rounded text-sm transition-all shadow-md disabled:opacity-50 flex items-center justify-center gap-2"
            style={{ background: saving ? "var(--clr-dark-light)" : "var(--clr-amber)" }}
          >
            {saving && <svg className="w-3 h-3" viewBox="0 0 24 24" style={{ animation: "spin 1s linear infinite" }}><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>}
            确认修改
          </button>
        </div>
      </div>

      {/* System Health */}
      <div className="card">
        <div className="card-label">系统状态</div>
        {health ? (
          <div className="grid gap-3 text-sm mt-3">
            <div className="flex justify-between py-2" style={{ borderBottom: "1px solid var(--clr-border)" }}>
              <span style={{ color: "var(--clr-text-muted)" }}>整体状态</span>
              <span className={health.status === "ok" ? "badge badge-green" : "badge"}>
                {health.status === "ok" ? "正常" : "降级"}
              </span>
            </div>
            <div className="flex justify-between py-2" style={{ borderBottom: "1px solid var(--clr-border)" }}>
              <span style={{ color: "var(--clr-text-muted)" }}>版本</span>
              <span className="text-xs" style={{ fontFamily: "var(--font-mono)", color: "var(--clr-text)" }}>v{health.version}</span>
            </div>
            <div className="flex justify-between py-2" style={{ borderBottom: "1px solid var(--clr-border)" }}>
              <span style={{ color: "var(--clr-text-muted)" }}>数据库</span>
              <span className="text-xs" style={{ color: "var(--clr-text)" }}>{statusDot(health.db)} {health.db}</span>
            </div>
            <div className="flex justify-between py-2">
              <span style={{ color: "var(--clr-text-muted)" }}>Redis</span>
              <span className="text-xs truncate max-w-[60%]" style={{ color: "var(--clr-text)" }}>{statusDot(health.redis)} {health.redis}</span>
            </div>
          </div>
        ) : (
          <p className="text-sm mt-3" style={{ color: "var(--clr-text-faint)" }}>无法连接后端服务</p>
        )}
      </div>
    </div>
  );
}
