"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { IconBeaker, IconConvert, IconGear, IconUsers } from "../components/Icons";
import { isGuest, ROLE_LABELS, getAuthToken, getAuthItem, clearAuthData } from "../lib/api";
import AuthModal from "../components/AuthModal";

/**
 * 仪表盘布局 — ComputaBio 暖色学术风格
 * 深色顶栏 + 暖白内容区
 * 支持游客模式: 显示"注册"按钮代替用户名
 */

const NAV_ITEMS = [
  { href: "/dashboard/analysis", label: "分析流程", Icon: IconBeaker },
  { href: "/dashboard/convert", label: "多样本整合", Icon: IconConvert },
  { href: "/dashboard/settings", label: "设置", Icon: IconGear },
];

const ADMIN_NAV_ITEM = { href: "/dashboard/admin", label: "用户管理", Icon: IconUsers };

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [username, setUsername] = useState("");
  const [guest, setGuest] = useState(false);
  const [userRole, setUserRole] = useState("");
  const [quotaInfo, setQuotaInfo] = useState({ total: 0, used: 0 });
  const [retentionDays, setRetentionDays] = useState(0);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);
  const [navItems, setNavItems] = useState(NAV_ITEMS);

  useEffect(() => {
    const token = getAuthToken();
    const name = getAuthItem("username");
    if (!token) {
      router.push("/");
      return;
    }
    setUsername(name || "用户");
    setGuest(isGuest());
    // 获取操作配额和角色
    const token2 = getAuthToken();
    if (token2) {
      fetch("/api/auth/me", { headers: { Authorization: "Bearer " + token2 } })
        .then(r => r.json())
        .then(d => {
          if (d.total_quota !== undefined) setQuotaInfo({ total: d.total_quota, used: d.used_quota });
          if (d.retention_days) setRetentionDays(d.retention_days);
          if (d.role) {
            setUserRole(d.role);
            const _sto = isGuest() ? sessionStorage : localStorage; _sto.setItem("role", d.role);
            if (d.is_guest !== undefined) { const _sto2 = d.is_guest ? sessionStorage : localStorage; _sto2.setItem("is_guest", d.is_guest ? "true" : "false"); }
            setGuest(d.is_guest || false);
          }
        })
        .catch(() => {});
    }
    const role = getAuthItem("role") || "user";
    setNavItems(role === "admin" ? [...NAV_ITEMS, ADMIN_NAV_ITEM] : NAV_ITEMS);
    if (pathname === "/dashboard") {
      router.replace("/dashboard/analysis");
    }
    // Close dropdown on outside click
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".user-dropdown")) setUserDropdownOpen(false);
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, [router, pathname]);

  const handleLogout = () => {
    clearAuthData();
    window.location.href = "/";
    router.push("/");
  };

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--clr-bg)" }}>
      {/* Header */}
      <header
        className="sticky top-0 z-50"
        style={{ background: "var(--clr-dark)", borderBottom: "3px solid var(--clr-amber)" }}
      >
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2.5 group">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center group-hover:scale-105 transition-transform shadow-sm"
              style={{ background: "linear-gradient(135deg, #C86019, #E07828)" }}
            >
              <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3" />
              </svg>
            </div>
            <span className="font-bold text-white/90 group-hover:text-[#FFD42A] transition-colors">
              scCloud
            </span>
          </Link>

          {/* Nav */}
          <nav className="hidden md:flex items-center gap-1">
            {navItems.map((item) => {
              const active = pathname === item.href || pathname?.startsWith(item.href);
              const isSettings = item.href === "/dashboard/settings";
              const handleClick = (e: React.MouseEvent) => {
                if (guest && isSettings) {
                  e.preventDefault();
                  setAuthOpen(true);
                }
              };
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={handleClick}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium transition-all duration-200 ${
                    active
                      ? "text-[#FFD42A] bg-white/10"
                      : "text-white/60 hover:text-white/90 hover:bg-white/5"
                  }`}
                >
                  <item.Icon size={14} />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          {/* User area */}
          <div className="flex items-center gap-4">
            {/* Common Icons for both modes */}
            <div className="flex items-center gap-3 text-white/70 mr-1">
              {/* Moon Icon */}
              <button className="hover:text-[#FFD42A] transition-colors cursor-pointer">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
              </button>
              {/* Lang Icon */}
              <button className="hover:text-[#FFD42A] transition-colors flex items-center justify-center text-[14px] font-bold cursor-pointer" style={{ fontFamily: "var(--font-sans)" }}>
                中
              </button>
              {/* GitHub Icon */}
              <a href="https://github.com" target="_blank" rel="noreferrer" className="hover:text-[#FFD42A] transition-colors cursor-pointer">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path></svg>
              </a>
            </div>

            <div className="flex items-center gap-3 pl-2 user-dropdown" style={{ borderLeft: "1px solid rgba(255,255,255,0.15)", position: "relative" }}>
                <button
                  onClick={() => {
                    const opening = !userDropdownOpen;
                    setUserDropdownOpen(opening);
                    if (opening) {
                      const tk = getAuthToken();
                      if (tk) fetch("/api/auth/me", { headers: { Authorization: "Bearer " + tk } })
                        .then(r => r.json())
                        .then(d => {
                          if (d.total_quota !== undefined) setQuotaInfo({ total: d.total_quota, used: d.used_quota });
          if (d.retention_days) setRetentionDays(d.retention_days);
                          if (d.role) { setUserRole(d.role); const _s = isGuest() ? sessionStorage : localStorage; _s.setItem("role", d.role); }
                        })
                        .catch(() => {});
                    }
                  }}
                  className="flex items-center gap-1.5 cursor-pointer hover:opacity-80 transition-opacity"
                >
                  <span className="text-sm font-medium text-white/90">{username}</span>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ color: "rgba(255,255,255,0.5)" }}>
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {userDropdownOpen && (
                  <div
                    className="absolute right-0 top-full mt-2 w-48 rounded-lg shadow-xl z-50 py-1"
                    style={{ background: "var(--clr-bg-card)", border: "1px solid var(--clr-border)" }}
                  >
                    <div className="px-3 py-2 border-b" style={{ borderColor: "var(--clr-border)" }}>
                      <p className="text-sm font-medium" style={{ color: "var(--clr-text)" }}>{username}</p>
                      <p className="text-[10px] mt-0.5" style={{ color: "var(--clr-text-faint)" }}>
                        {ROLE_LABELS[userRole || getAuthItem("role") || "user"] || "用户"}
                      </p>
                      {quotaInfo.total > 0 && (
                        <p className="text-[10px] mt-0.5" style={{ color: "var(--clr-amber-dark)" }}>
                          剩余操作: {Math.max(0, quotaInfo.total - quotaInfo.used)} / {quotaInfo.total} 次
                        </p>
                      )}
                      {retentionDays > 0 && (
                        <p className="text-[10px] mt-0.5" style={{ color: "var(--clr-text-faint)" }}>
                          数据保留: {retentionDays} 天
                        </p>
                      )}
                    </div>
                    {guest && (
                      <button
                        onClick={() => { setUserDropdownOpen(false); setUpgradeOpen(true); }}
                        className="w-full text-left px-3 py-2 text-xs hover:bg-black/5 transition-colors flex items-center gap-2"
                        style={{ color: "var(--clr-amber)" }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="8.5" cy="7" r="4" /><line x1="20" y1="8" x2="20" y2="14" /><line x1="23" y1="11" x2="17" y2="11" />
                        </svg>
                        注册账号
                      </button>
                    )}
                    {!guest && (
                      <button
                        onClick={() => { setUserDropdownOpen(false); router.push("/dashboard/settings"); }}
                        className="w-full text-left px-3 py-2 text-xs hover:bg-black/5 transition-colors flex items-center gap-2"
                        style={{ color: "var(--clr-text)" }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <circle cx="12" cy="12" r="3" /><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
                        </svg>
                        修改密码
                      </button>
                    )}
                    <button
                      onClick={() => { setUserDropdownOpen(false); handleLogout(); }}
                      className="w-full text-left px-3 py-2 text-xs hover:bg-black/5 transition-colors flex items-center gap-2"
                      style={{ color: "var(--clr-danger)" }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
                      </svg>
                      {guest ? "退出游客" : "退出登录"}
                    </button>
                  </div>
                )}
              </div>
          </div>
        </div>
      </header>

      {/* Guest banner */}
      {guest && (
        <div
          className="text-center py-2 text-xs"
          style={{
            background: "var(--clr-gold-soft)",
            color: "var(--clr-amber-dark)",
            borderBottom: "1px solid rgba(200,96,25,0.15)",
          }}
        >
          <span>🎉 当前只可以创建一个项目。</span>
          <button
            onClick={() => setUpgradeOpen(true)}
            className="ml-2 underline font-medium hover:text-[var(--clr-amber)] transition-colors"
            style={{ color: "var(--clr-amber-dark)" }}
          >
            注册以解锁更多
          </button>
        </div>
      )}



      {/* Main */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-6">
        {children}
      </main>

      {/* Auth Modal */}
      <AuthModal
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        defaultTab="login"
      />
      {/* Upgrade Modal */}
      <AuthModal
        open={upgradeOpen}
        onClose={() => setUpgradeOpen(false)}
        upgradeMode={true}
      />
    </div>
  );
}
