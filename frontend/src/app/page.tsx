"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { guestLogin, saveAuthData } from "./lib/api";
import AuthModal from "./components/AuthModal";

/**
 * scCloud v2 Landing Page — 编辑式暖色学术设计
 *
 * 设计语言: Claude-inspired terracotta editorial
 * 排版: Playfair Display (display) + DM Sans (body) + Noto Serif SC (中文)
 * 布局: 左对齐 Hero + 交错卡片 + 水平时间轴 + 深色 CTA 块
 */

/* ===== 功能卡片数据 ===== */
const FEATURES = [
  {
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 012-2h2a2 2 0 012 2M9 5h6M9 14l2 2 4-4" />
      </svg>
    ),
    title: "智能质控",
    desc: "自动识别低质量细胞，精准过滤线粒体比例、基因数与 UMI 阈值",
    large: true,
  },
  {
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <circle cx="12" cy="12" r="3" /><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
      </svg>
    ),
    title: "标准化与降维",
    desc: "SCTransform + PCA/UMAP/tSNE 高维数据可视化",
    large: false,
  },
  {
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
      </svg>
    ),
    title: "聚类与注释",
    desc: "Harmony 批次校正 + Louvain 聚类 + SingleR 自动注释",
    large: false,
  },
  {
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M3 3v18h18M7 16l4-8 4 4 4-6" />
      </svg>
    ),
    title: "差异表达与富集",
    desc: "Wilcoxon 差异基因 + GO/KEGG/GSEA 通路分析，直出 publication-ready 图表",
    large: true,
  },
];

/* ===== 流水线步骤 ===== */
const PIPELINE = [
  { label: "质控", sub: "QC", num: "01" },
  { label: "标准化", sub: "SCTransform", num: "02" },
  { label: "降维", sub: "PCA / UMAP", num: "03" },
  { label: "聚类", sub: "Harmony", num: "04" },
  { label: "差异基因", sub: "FindMarkers", num: "05" },
  { label: "通路富集", sub: "GO / KEGG", num: "06" },
  { label: "可视化", sub: "Violin / Dot", num: "07" },
  { label: "注释", sub: "SingleR", num: "08" },
];




export default function LandingPage() {
  const router = useRouter();
  const [authOpen, setAuthOpen] = useState(false);
  const [authTab, setAuthTab] = useState<"login" | "register">("login");
  const [startLoading, setStartLoading] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  /* ── Hero Dashboard 响应式参数（基于视口宽度动态计算） ── */
  const [heroDash, setHeroDash] = useState({
    scale: 1.6, width: 1100, marginRight: -200,
    rotateY: -15, rotateX: 10, textScale: 1,
  });

  useEffect(() => {
    const calc = () => {
      const vw = window.innerWidth;
      // 基础参数线性插值（1024px → 1680px）
      const t = Math.max(0, Math.min(1, (vw - 1024) / (1680 - 1024)));
      const baseWidth = 800 + t * 300;
      const baseMR = -60 + t * -140;

      // 中线约束：Dashboard 左视觉边缘不超过 vw/2
      // transformOrigin="right center"，右边缘 ≈ vw + |baseMR|
      // 左边缘 = 右边缘 - baseWidth * scale >= vw/2
      // ∴ scale <= (vw/2 + |baseMR|) / baseWidth
      const maxScale = (vw / 2 + Math.abs(baseMR)) / baseWidth;

      setHeroDash({
        scale: Math.max(0.7, maxScale),
        width: baseWidth,
        marginRight: baseMR,
        rotateY: -12 + t * -3,
        rotateX: 8 + t * 2,
        textScale: Math.min(1, vw / 1680),
      });
    };
    calc();
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, []);

  /* Scroll observer for navbar shadow + reveal animations */
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  /* IntersectionObserver for scroll-triggered reveals */
  const revealCallback = useCallback((entries: IntersectionObserverEntry[]) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
      }
    });
  }, []);

  useEffect(() => {
    observerRef.current = new IntersectionObserver(revealCallback, {
      threshold: 0.15,
      rootMargin: "0px 0px -40px 0px",
    });
    document.querySelectorAll(".reveal").forEach((el) => {
      observerRef.current?.observe(el);
    });
    return () => observerRef.current?.disconnect();
  }, [revealCallback]);

  /* 点击"开始分析": 始终创建新游客会话（标签页隔离） */
  const handleStart = async () => {
    setStartLoading(true);
    try {
      const data = await guestLogin();
      saveAuthData(data, true);
      router.push("/dashboard/analysis");
    } catch {
      setAuthTab("login");
      setAuthOpen(true);
    } finally {
      setStartLoading(false);
    }
  };

  const openLogin = () => { setAuthTab("login"); setAuthOpen(true); };

  return (
    <>
      <div className="noise-overlay min-h-screen flex flex-col" style={{ background: "var(--clr-bg)", overflowX: "hidden" }}>
        {/* ═══════ Navbar ═══════ */}
        <nav
          className="sticky top-0 z-50 transition-all duration-300"
          style={{
            background: scrolled ? "rgba(250,247,244,0.92)" : "transparent",
            backdropFilter: scrolled ? "blur(20px) saturate(180%)" : "none",
            boxShadow: scrolled ? "0 1px 12px rgba(45,41,38,0.06)" : "none",
          }}
        >
          <div className="px-8 lg:px-16 h-16 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2.5">
                <div
                  className="w-8 h-8 rounded shrink-0 flex items-center justify-center"
                  style={{ background: "#C56B3A" }}
                >
                  <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                    <path d="M7 14L12 9L17 14" />
                  </svg>
                </div>
                <span
                  className="text-lg font-bold"
                  style={{ fontFamily: "var(--font-display)", color: "var(--clr-dark-deep)", letterSpacing: "0.5px" }}
                >
                  scCloud
                </span>
              </div>
              {/* Separator */}
              <div className="hidden md:block w-px h-6 mx-2" style={{ background: "rgba(0,0,0,0.06)" }} />
              {/* Nav links */}
              <div className="hidden md:flex items-center gap-6">
                {[
                  { label: "功能", href: "#features" },
                  { label: "流程", href: "#pipeline" },
                  { label: "技术栈", href: "#tech" },
                ].map((item) => (
                  <a
                    key={item.href}
                    href={item.href}
                    className="text-[13px] transition-colors duration-200"
                    style={{ color: "rgba(0,0,0,0.55)", fontWeight: 500 }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "var(--clr-dark-deep)")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(0,0,0,0.55)")}
                  >
                    {item.label}
                  </a>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-5">
              {/* Icons */}
              <div className="flex items-center gap-4 mr-1" style={{ color: "var(--clr-dark-deep)" }}>
                {/* Moon Icon */}
                <button className="hover:opacity-70 transition-opacity cursor-pointer">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
                </button>
                {/* Lang Icon */}
                <button className="hover:opacity-70 transition-opacity flex items-center justify-center text-[15px] cursor-pointer" style={{ fontFamily: "var(--font-sans)", fontWeight: 400 }}>
                  中
                </button>
                {/* GitHub Icon */}
                <a href="https://github.com" target="_blank" rel="noreferrer" className="hover:opacity-70 transition-opacity cursor-pointer">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path></svg>
                </a>
              </div>

              {/* Get Started (Guest Login) */}
              <div className="flex items-center gap-2.5">
                <button
                  onClick={handleStart}
                  disabled={startLoading}
                  className="px-4 py-[7px] text-[13px] font-medium rounded transition-all duration-300 disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed"
                  style={{
                    background: "transparent",
                    color: "var(--clr-amber)",
                    border: "1px solid rgba(200,96,25,0.2)",
                    lineHeight: 1,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "rgba(200,96,25,0.06)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  {startLoading ? "Loading..." : "Get Started"}
                </button>

                {/* Login */}
                <button
                  onClick={openLogin}
                  className="px-5 py-[8px] text-[13px] font-medium rounded transition-all duration-300 cursor-pointer"
                  style={{
                    background: "rgba(200,96,25,0.1)",
                    color: "var(--clr-amber)",
                    lineHeight: 1,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "rgba(200,96,25,0.15)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "rgba(200,96,25,0.1)";
                  }}
                >
                  Login
                </button>
              </div>
            </div>
          </div>
        </nav>

        {/* ═══════ Hero — 全宽 flex 布局 ═══════ */}
        <section className="relative flex items-center min-h-[calc(100vh-80px)] pt-10 pb-20 md:pt-16 md:pb-24 overflow-hidden">
          {/* Warm glow accents */}
          <div className="absolute top-[-100px] left-[-80px] w-[500px] h-[500px] rounded-full pointer-events-none"
            style={{ background: "radial-gradient(circle, rgba(194,105,61,0.06) 0%, transparent 70%)" }} />
          <div className="absolute bottom-[-80px] right-[-60px] w-[400px] h-[400px] rounded-full pointer-events-none"
            style={{ background: "radial-gradient(circle, rgba(255,212,42,0.04) 0%, transparent 70%)" }} />

          {/* 全宽 flex 两栏 */}
          <div className="relative z-10 w-full flex flex-col md:flex-row items-center" style={{ minHeight: 480 }}>
            {/* Left: Text — 左侧全宽 padding */}
            <div
              className="w-full md:w-[42%] shrink-0 px-8 lg:px-16"
              style={{
                transform: "translateY(-40px)",
                zoom: heroDash.textScale,
              }}
            >
              {/* Badge */}
              <div
                className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-[15px] font-semibold mb-8 tracking-wide uppercase"
                style={{
                  background: "rgba(194,105,61,0.08)",
                  color: "var(--clr-amber)",
                  border: "1px solid rgba(194,105,61,0.12)",
                  animation: "fadeUp 0.5s cubic-bezier(0.22,1,0.36,1) 0s both",
                }}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--clr-success)" }} />
                scCloud v2 · Open Source
              </div>

              {/* Title */}
              <h1
                className="text-[3.5rem] md:text-[4rem] lg:text-[5rem] xl:text-[6rem] font-bold leading-[1.05] mb-8"
                style={{
                  fontFamily: "var(--font-display)",
                  color: "var(--clr-dark-deep)",
                  letterSpacing: "-0.04em",
                  whiteSpace: "nowrap",
                  animation: "fadeUp 0.6s cubic-bezier(0.22,1,0.36,1) 0.05s both",
                }}
              >
                从数据到发现：
                <br />
                <span className="gradient-text">单细胞</span>
                <br />
                云端分析平台
              </h1>

              {/* Gold divider */}
              <div
                className="w-20 h-[3px] mb-8"
                style={{
                  background: "linear-gradient(90deg, var(--clr-amber), var(--clr-gold))",
                  animation: "fadeUp 0.6s cubic-bezier(0.22,1,0.36,1) 0.1s both",
                }}
              />

              {/* Subtitle */}
              <p
                className="text-xl md:text-2xl mb-12 max-w-none md:whitespace-nowrap"
                style={{
                  fontFamily: "var(--font-sans)",
                  color: "var(--clr-text-muted)",
                  lineHeight: 1.8,
                  fontWeight: 400,
                  animation: "fadeUp 0.6s cubic-bezier(0.22,1,0.36,1) 0.15s both",
                }}
              >
                上传 scRNA-seq 数据，获得 publication-ready 的可视化结果。
              </p>

              {/* CTA */}
              <div
                className="flex flex-wrap items-center gap-6"
                style={{ animation: "fadeUp 0.6s cubic-bezier(0.22,1,0.36,1) 0.2s both" }}
              >
                <button
                  onClick={handleStart}
                  disabled={startLoading}
                  className="px-10 py-4 text-white font-semibold rounded-xl text-base transition-all duration-300 disabled:opacity-60"
                  style={{
                    background: "var(--clr-amber)",
                    boxShadow: "0 4px 20px rgba(194,105,61,0.3)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform = "translateY(-2px)";
                    e.currentTarget.style.boxShadow = "0 8px 30px rgba(194,105,61,0.4)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = "translateY(0)";
                    e.currentTarget.style.boxShadow = "0 4px 20px rgba(194,105,61,0.3)";
                  }}
                >
                  {startLoading ? "准备分析环境..." : "立即体验"}
                </button>
                <a
                  href="#features"
                  className="text-base font-medium transition-colors duration-200"
                  style={{ color: "var(--clr-text-muted)" }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "var(--clr-amber)")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "var(--clr-text-muted)")}
                >
                  了解更多 ↓
                </a>
              </div>
            </div>

            {/* Right: Dashboard Preview — flex 子元素，自然溢出右边界 */}
            <div
              className="hidden md:flex flex-1 items-center justify-end relative"
              style={{
                animation: "fadeIn 1s cubic-bezier(0.22,1,0.36,1) 0.3s both, float-y 6s ease-in-out infinite",
                perspective: "1500px",
                marginRight: heroDash.marginRight,
              }}
            >
              {/* ── 暖色渐变飘带装饰 ── */}
              <div
                className="absolute pointer-events-none"
                style={{
                  width: 500, height: 600,
                  right: -60, top: -80,
                  background: "linear-gradient(160deg, rgba(194,105,61,0.15) 0%, rgba(200,96,25,0.08) 40%, rgba(232,168,130,0.06) 100%)",
                  borderRadius: "40% 60% 60% 40% / 60% 30% 70% 40%",
                  transform: "rotate(-8deg)",
                  filter: "blur(2px)",
                }}
              />
              <div
                className="absolute pointer-events-none"
                style={{
                  width: 400, height: 500,
                  right: 80, bottom: -100,
                  background: "linear-gradient(200deg, rgba(255,212,42,0.08) 0%, rgba(194,105,61,0.05) 60%, transparent 100%)",
                  borderRadius: "50% 50% 40% 60% / 40% 60% 40% 60%",
                  transform: "rotate(12deg)",
                  filter: "blur(3px)",
                }}
              />

              <div
                style={{
                  transform: `rotateY(${heroDash.rotateY}deg) rotateX(${heroDash.rotateX}deg) scale(${heroDash.scale})`,
                  transformOrigin: "right center",
                  transformStyle: "preserve-3d",
                  width: heroDash.width,
                  flexShrink: 0,
                  position: "relative",
                  zIndex: 5,
                }}
              >
                {/* Frosted glass border — 毛玻璃外框 */}
                <div
                  style={{
                    borderRadius: 22,
                    padding: 8,
                    background: "rgba(255,255,255,0.35)",
                    backdropFilter: "blur(16px) saturate(180%)",
                    WebkitBackdropFilter: "blur(16px) saturate(180%)",
                    boxShadow: "0 40px 100px rgba(45,41,38,0.2), 0 15px 40px rgba(45,41,38,0.1), inset 0 1px 0 rgba(255,255,255,0.5)",
                    border: "1px solid rgba(255,255,255,0.45)",
                  }}
                >
                {/* Main card — 仪表盘预览 */}
                <div
                  style={{
                    background: "#FEFCFA",
                    borderRadius: 14,
                    overflow: "hidden",
                    position: "relative",
                  }}
                >
                  {/* Glass reflection overlay */}
                  <div style={{
                    position: "absolute", inset: 0, zIndex: 10, pointerEvents: "none",
                    background: "linear-gradient(125deg, rgba(255,255,255,0.2) 0%, rgba(255,255,255,0.05) 30%, transparent 60%)",
                    borderRadius: 14,
                  }} />

                  {/* Top bar — macOS style */}
                  <div style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "18px 28px", borderBottom: "1px solid rgba(0,0,0,0.06)",
                    background: "rgba(255,255,255,0.6)",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <div style={{ width: 16, height: 16, borderRadius: "50%", background: "#FF5F56" }} />
                      <div style={{ width: 16, height: 16, borderRadius: "50%", background: "#FFBD2E" }} />
                      <div style={{ width: 16, height: 16, borderRadius: "50%", background: "#27C93F" }} />
                    </div>
                    <div style={{
                      fontSize: 18, color: "#aaa", fontFamily: "var(--font-mono)",
                      background: "rgba(0,0,0,0.03)", padding: "5px 22px", borderRadius: 7,
                      letterSpacing: "0.02em",
                    }}>
                      sccloud.computabio.com/dashboard
                    </div>
                    <div style={{ width: 50 }} />
                  </div>

                  {/* Body */}
                  <div style={{ display: "flex", minHeight: 580 }}>
                    {/* Sidebar */}
                    <div style={{
                      width: 260, borderRight: "1px solid rgba(0,0,0,0.05)",
                      padding: "22px 0", flexShrink: 0, background: "rgba(250,247,244,0.5)",
                    }}>
                      <div style={{
                        padding: "0 22px 20px", fontSize: 22, fontWeight: 700,
                        color: "#2D2926", fontFamily: "var(--font-sans)",
                        display: "flex", alignItems: "center", gap: 6,
                      }}>
                        <div style={{
                          width: 34, height: 34, borderRadius: 7,
                          background: "#C86019", display: "flex", alignItems: "center", justifyContent: "center",
                        }}>
                          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"><path d="M7 14L12 9L17 14" /></svg>
                        </div>
                        scRNA 分析
                      </div>
                      {[
                        { n: "1", label: "数据预处理", sub: "质控过滤", active: true },
                        { n: "2", label: "数据标准化", sub: "SCTransform", active: false },
                        { n: "3", label: "数据降维", sub: "PCA/UMAP", active: false },
                        { n: "4", label: "批次聚类", sub: "Harmony", active: false },
                        { n: "5", label: "差异基因", sub: "FindMarkers", active: false },
                        { n: "6", label: "通路富集", sub: "GO/KEGG", active: false },
                      ].map((s) => (
                        <div key={s.n} style={{
                          display: "flex", alignItems: "center", gap: 12,
                          padding: "11px 22px", fontSize: 18,
                          color: s.active ? "#C86019" : "#999",
                          fontWeight: s.active ? 600 : 400,
                          background: s.active ? "rgba(200,96,25,0.06)" : "transparent",
                          borderLeft: s.active ? "3px solid #C86019" : "3px solid transparent",
                        }}>
                          <span style={{
                            width: 32, height: 32, borderRadius: 7, fontSize: 16,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            background: s.active ? "#C86019" : "rgba(0,0,0,0.05)",
                            color: s.active ? "#fff" : "#bbb", fontWeight: 700,
                            flexShrink: 0,
                          }}>{s.n}</span>
                          <div>
                            <div>{s.label}</div>
                            <div style={{ fontSize: 14, color: s.active ? "rgba(200,96,25,0.6)" : "#ccc", marginTop: 2 }}>{s.sub}</div>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Main content */}
                    <div style={{ flex: 1, padding: "26px 32px" }}>
                      {/* Header */}
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 22 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                          <div style={{
                            width: 44, height: 44, borderRadius: "50%", background: "#2D2926",
                            color: "#fff", fontSize: 22, fontWeight: 700,
                            display: "flex", alignItems: "center", justifyContent: "center",
                          }}>1</div>
                          <span style={{ fontSize: 24, fontWeight: 700, color: "#2D2926" }}>数据预处理 — 结果</span>
                        </div>
                        <span style={{
                          fontSize: 17, padding: "5px 18px", borderRadius: 16,
                          background: "rgba(200,96,25,0.08)", color: "#C86019", fontWeight: 600,
                        }}>✓ 完成</span>
                      </div>

                      {/* Tabs */}
                      <div style={{ display: "flex", gap: 0, marginBottom: 22, borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
                        {["过滤结果", "样本相关性", "样本质控", "线粒体基因占比", "UMI 基因统计"].map((t, i) => (
                          <div key={t} style={{
                            fontSize: 17, padding: "10px 18px",
                            color: i === 0 ? "#fff" : "#999",
                            background: i === 0 ? "#C86019" : "transparent",
                            borderRadius: i === 0 ? "8px 8px 0 0" : 0,
                            fontWeight: i === 0 ? 600 : 400,
                          }}>{t}</div>
                        ))}
                      </div>

                      {/* Stats cards */}
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
                        {[
                          { value: "1,888", label: "过滤前细胞", color: "#C86019" },
                          { value: "1,888", label: "过滤后细胞", color: "#2D8A56" },
                          { value: "0 (0.0%)", label: "过滤掉", color: "#999" },
                          { value: "38,606", label: "基因数", color: "#2D2926" },
                        ].map((c) => (
                          <div key={c.label} style={{
                            textAlign: "center", padding: "18px 8px",
                            border: "1px solid rgba(0,0,0,0.06)", borderRadius: 12,
                            background: "#fff",
                          }}>
                            <div style={{ fontSize: 32, fontWeight: 800, color: c.color, fontFamily: "var(--font-mono)", letterSpacing: "-0.02em" }}>{c.value}</div>
                            <div style={{ fontSize: 15, color: "#999", marginTop: 5 }}>{c.label}</div>
                          </div>
                        ))}
                      </div>

                      {/* Summary bar */}
                      <div style={{
                        background: "rgba(200,96,25,0.04)", borderRadius: 12,
                        padding: "14px 22px", fontSize: 17, color: "#666", lineHeight: 1.7,
                        border: "1px solid rgba(200,96,25,0.08)", marginBottom: 22,
                      }}>
                        <span style={{ fontWeight: 600, color: "#C86019" }}>数据概览</span>
                        <span style={{ margin: "0 10px", color: "#ddd" }}>|</span>
                        样本数: 2
                        <span style={{ margin: "0 10px", color: "#ddd" }}>|</span>
                        保留率: <span style={{ color: "#2D8A56", fontWeight: 600 }}>100.0%</span>
                      </div>

                      {/* Bottom hint text — 模拟说明文字 */}
                      <div style={{
                        fontSize: 15, color: "#bbb", lineHeight: 1.6,
                        padding: "0 2px",
                      }}>
                        质控过滤根据设定的线粒体基因占比阈值和最小表达基因数阈值，去除低质量细胞。过滤后的数据将用于后续的标准化和降维分析。
                      </div>
                    </div>
                  </div>
                </div>
                </div>{/* close frosted glass border */}
              </div>
            </div>{/* close dashboard container */}
          </div>{/* close flex row */}
        </section>

        {/* ═══════ Features — 交错卡片 ═══════ */}
        <section id="features" className="py-24" style={{ background: "var(--clr-bg-card)" }}>
          <div className="max-w-6xl mx-auto px-6">
            {/* Section header */}
            <div className="mb-16 reveal">
              <p
                className="text-[11px] font-semibold uppercase tracking-[0.15em] mb-3"
                style={{ color: "var(--clr-amber)", fontFamily: "var(--font-sans)" }}
              >
                Core Features
              </p>
              <h2
                className="text-2xl md:text-3xl font-bold"
                style={{ fontFamily: "var(--font-display)", color: "var(--clr-dark-deep)", letterSpacing: "-0.03em" }}
              >
                一站式完成
              </h2>
            </div>

            {/* Bento grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {FEATURES.map((f, i) => (
                <div
                  key={f.title}
                  className={`reveal group p-7 rounded-xl cursor-default transition-all duration-400 ${f.large ? "md:col-span-2" : ""}`}
                  style={{
                    background: "var(--clr-surface-warm)",
                    border: "1px solid transparent",
                    transitionDelay: `${i * 0.08}s`,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "rgba(194,105,61,0.2)";
                    e.currentTarget.style.boxShadow = "var(--shadow-glow)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "transparent";
                    e.currentTarget.style.boxShadow = "none";
                  }}
                >
                  <div
                    className="w-12 h-12 rounded-xl flex items-center justify-center mb-5 transition-transform duration-300 group-hover:scale-110"
                    style={{ background: "rgba(194,105,61,0.08)", color: "var(--clr-amber)" }}
                  >
                    {f.icon}
                  </div>
                  <h3
                    className="text-[15px] font-bold mb-2"
                    style={{ fontFamily: "var(--font-sans)", color: "var(--clr-dark-deep)" }}
                  >
                    {f.title}
                  </h3>
                  <p className="text-sm leading-relaxed" style={{ color: "var(--clr-text-muted)" }}>
                    {f.desc}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ═══════ Pipeline — 水平时间轴 ═══════ */}
        <section id="pipeline" className="py-24">
          <div className="max-w-6xl mx-auto px-6">
            <div className="mb-16 reveal">
              <p
                className="text-[11px] font-semibold uppercase tracking-[0.15em] mb-3"
                style={{ color: "var(--clr-amber)", fontFamily: "var(--font-sans)" }}
              >
                Analysis Pipeline
              </p>
              <h2
                className="text-2xl md:text-3xl font-bold"
                style={{ fontFamily: "var(--font-display)", color: "var(--clr-dark-deep)", letterSpacing: "-0.03em" }}
              >
                八步，从原始数据到生物学洞见
              </h2>
            </div>

            {/* Timeline */}
            <div className="reveal relative">
              {/* Connecting line */}
              <div
                className="hidden md:block absolute top-6 left-0 right-0 h-[2px]"
                style={{
                  background: "repeating-linear-gradient(90deg, var(--clr-border) 0, var(--clr-border) 6px, transparent 6px, transparent 12px)",
                }}
              />
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-4 md:gap-2">
                {PIPELINE.map((step, i) => (
                  <div
                    key={step.num}
                    className="group relative flex flex-col items-center text-center"
                    style={{ transitionDelay: `${i * 0.06}s` }}
                  >
                    {/* Node */}
                    <div
                      className="w-12 h-12 rounded-full flex items-center justify-center mb-3 transition-all duration-300 relative z-10 group-hover:scale-110"
                      style={{
                        background: `linear-gradient(135deg, var(--clr-amber), ${i > 4 ? "var(--clr-gold)" : "var(--clr-amber-light)"})`,
                        boxShadow: "0 2px 8px rgba(194,105,61,0.2)",
                      }}
                    >
                      <span className="text-[11px] font-bold text-white" style={{ fontFamily: "var(--font-mono)" }}>
                        {step.num}
                      </span>
                    </div>
                    <div
                      className="text-[13px] font-bold mb-0.5"
                      style={{ fontFamily: "var(--font-sans)", color: "var(--clr-dark-deep)" }}
                    >
                      {step.label}
                    </div>
                    <div className="text-[11px]" style={{ color: "var(--clr-text-faint)", fontFamily: "var(--font-mono)" }}>
                      {step.sub}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ═══════ Footer ═══════ */}
        <footer className="py-8" style={{ borderTop: "1px solid var(--clr-border)" }}>
          <div className="max-w-6xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <div
                className="w-5 h-5 rounded flex items-center justify-center"
                style={{ background: "var(--clr-amber)" }}
              >
                <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5" />
                </svg>
              </div>
              <span className="text-xs font-medium" style={{ color: "var(--clr-text-faint)" }}>
                scCloud v2
              </span>
            </div>
            <p className="text-[11px]" style={{ color: "var(--clr-text-faint)" }}>
              Next.js · FastAPI · R Engine · ComputaBio Palette
            </p>
          </div>
        </footer>
      </div>

      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} defaultTab={authTab} />
    </>
  );
}
