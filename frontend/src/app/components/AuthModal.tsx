"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveAuthData, upgradeGuest, moveGuestToUser } from "../lib/api";

/**
 * AuthModal — 登录/注册/游客升级 二合一模态框
 *
 * 新 UI：居中标题、图标输入框、圆角按钮、忘记密码/注册链接
 * 游客升级模式：当 `upgradeMode=true` 时，只显示注册表单。
 */

interface AuthModalProps {
  open: boolean;
  onClose: () => void;
  /** 默认选中的 Tab */
  defaultTab?: "login" | "register";
  /** 游客升级模式 — 跳过登录 Tab，直接显示注册 */
  upgradeMode?: boolean;
}

export default function AuthModal({
  open,
  onClose,
  defaultTab = "login",
  upgradeMode = false,
}: AuthModalProps) {
  const router = useRouter();
  const [tab, setTab] = useState<"login" | "register">(
    upgradeMode ? "register" : defaultTab
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (!open) return null;

  const resetForm = () => {
    setUsername("");
    setPassword("");
    setConfirmPassword("");
    setError("");
    setLoading(false);
  };

  const handleSwitchMode = (mode: "login" | "register") => {
    setTab(mode);
    setError("");
    resetForm();
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username, password }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.detail || "登录失败");
      }
      const data = await res.json();
      saveAuthData(data, false);
      resetForm();
      onClose();
      window.location.href = "/dashboard/analysis";
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }
    if (password.length < 6) {
      setError("密码长度至少 6 位");
      return;
    }

    setLoading(true);
    try {
      let data;
      if (upgradeMode) {
        data = await upgradeGuest(username, password);
      } else {
        const res = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        if (!res.ok) {
          const errData = await res.json();
          if (res.status === 409) {
            throw new Error("用户名已存在，请更换其他用户名");
          }
          throw new Error(errData.detail || "注册失败");
        }
        data = await res.json();
      }
      if (upgradeMode) { moveGuestToUser(data); } else { saveAuthData(data, false); }
      resetForm();
      onClose();
      window.location.href = "/dashboard/analysis";
    } catch (err) {
      setError(err instanceof Error ? err.message : "注册失败");
    } finally {
      setLoading(false);
    }
  };

  const isLogin = tab === "login";

  return (
    <div
      className="fixed inset-0 z-[999] flex items-center justify-center"
      style={{ background: "rgba(30,27,24,0.55)", backdropFilter: "blur(4px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-sm mx-4 relative"
        style={{ animation: "fadeUp 0.3s ease-out forwards" }}
      >
        <div className="card p-8">
          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full transition-colors"
            style={{ color: "var(--clr-text-faint)" }}
            aria-label="关闭"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>

          {/* Title */}
          <h2
            className="text-center text-xl font-bold mb-8"
            style={{ fontFamily: "var(--font-serif)", color: "var(--clr-dark-deep)" }}
          >
            {isLogin ? "登录" : upgradeMode ? "注册正式账号" : "注册"}
          </h2>

          {/* Form */}
          <form onSubmit={isLogin ? handleLogin : handleRegister} className="space-y-5">
            {/* Username */}
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: "var(--clr-text)" }}>
                {isLogin ? "用户名或邮箱" : "用户名"}
              </label>
              <div className="flex items-center bg-white border rounded-lg overflow-hidden transition-colors" style={{ borderColor: "var(--clr-border)" }}>
                <span className="pl-3 shrink-0" style={{ color: "var(--clr-text-faint)" }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <rect x="2" y="4" width="20" height="16" rx="2" />
                    <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                  </svg>
                </span>
                <input
                  type="text" value={username} onChange={(e) => setUsername(e.target.value)}
                  placeholder={isLogin ? "请输入您的用户名或邮箱地址" : "字母、数字、下划线"} required
                  className="w-full px-3 py-2.5 text-sm focus:outline-none focus:ring-0" style={{ color: "var(--clr-text)", background: "#fff", WebkitTextFillColor: "var(--clr-text)", boxShadow: "0 0 0 30px #fff inset" }}
                  style={{ color: "var(--clr-text)" }}
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: "var(--clr-text)" }}>密码</label>
              <div className="flex items-center bg-white border rounded-lg overflow-hidden transition-colors" style={{ borderColor: "var(--clr-border)" }}>
                <span className="pl-3 shrink-0" style={{ color: "var(--clr-text-faint)" }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                </span>
                <input
                  type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder={isLogin ? "请输入您的密码" : "至少 6 位"} required
                  className="w-full px-3 py-2.5 text-sm focus:outline-none focus:ring-0" style={{ color: "var(--clr-text)", background: "#fff", WebkitTextFillColor: "var(--clr-text)", boxShadow: "0 0 0 30px #fff inset" }}
                  style={{ color: "var(--clr-text)" }}
                />
              </div>
            </div>

            {/* Confirm Password (register only) */}
            {!isLogin && (
              <div>
                <label className="block text-sm font-medium mb-1.5" style={{ color: "var(--clr-text)" }}>确认密码</label>
                <div className="flex items-center bg-white border rounded-lg overflow-hidden transition-colors" style={{ borderColor: "var(--clr-border)" }}>
                  <span className="pl-3 shrink-0" style={{ color: "var(--clr-text-faint)" }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  </span>
                  <input
                    type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="再次输入密码" required
                    className="w-full px-3 py-2.5 text-sm focus:outline-none focus:ring-0" style={{ color: "var(--clr-text)", background: "#fff", WebkitTextFillColor: "var(--clr-text)", boxShadow: "0 0 0 30px #fff inset" }}
                    style={{ color: "var(--clr-text)" }}
                  />
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="px-3 py-2 rounded-lg text-sm" style={{ background: "rgba(220,53,69,0.08)", color: "var(--clr-danger)", border: "1px solid rgba(220,53,69,0.15)" }}>
                {error}
              </div>
            )}

            {/* Submit Button */}
            <button
              type="submit" disabled={loading}
              className="w-full py-2.5 text-white font-semibold rounded-full text-sm transition-all duration-300 shadow-md disabled:opacity-50"
              style={{ background: loading ? "var(--clr-dark-light)" : "var(--clr-amber)" }}
            >
              {loading ? (isLogin ? "登录中..." : "注册中...") : (isLogin ? "登录" : upgradeMode ? "注册并保留数据" : "注册")}
            </button>
          </form>

          {/* Links */}
          <div className="mt-6 space-y-3 text-center text-sm">
            {isLogin ? (
              <>
                <button
                  onClick={() => { /* TODO: forgot password */ }}
                  className="transition-colors hover:underline"
                  style={{ color: "var(--clr-text-muted)" }}
                >
                  忘记密码？
                </button>
                <div style={{ color: "var(--clr-text-muted)" }}>
                  没有账户？{" "}
                  <button
                    onClick={() => handleSwitchMode("register")}
                    className="font-medium transition-colors hover:underline"
                    style={{ color: "var(--clr-amber)" }}
                  >
                    注册
                  </button>
                </div>
              </>
            ) : (
              <div style={{ color: "var(--clr-text-muted)" }}>
                已有账户？{" "}
                <button
                  onClick={() => handleSwitchMode("login")}
                  className="font-medium transition-colors hover:underline"
                  style={{ color: "var(--clr-amber)" }}
                >
                  登录
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
