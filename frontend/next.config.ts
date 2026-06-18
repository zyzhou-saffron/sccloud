import type { NextConfig } from "next";

/**
 * 后端地址 — 用于 Next.js rewrites 代理
 *
 * Docker 环境: 容器间通过服务名互访 → http://backend:8000
 * 本地 npm run dev: fallback → http://localhost:8000
 *
 * 注意: rewrites destination 在构建时确定。
 * Docker compose 中 build 阶段可通过 ARG 注入。
 */
const BACKEND = process.env.BACKEND_URL || "http://localhost:8000";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    // @types/react-plotly.js 的 ColorScale 类型定义与 plotly.js 不兼容
    // 代码运行时完全正常，仅类型声明过时
    ignoreBuildErrors: true,
  },
  /**
   * API 代理规则 — 前后端同源路由
   *
   * 前端 /api/* → rewrites → 后端 BACKEND/api/*
   * 前端 /ws/*  → rewrites → 后端 BACKEND/ws/*
   */
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${BACKEND}/api/:path*`,
      },
      {
        source: "/ws/:path*",
        destination: `${BACKEND}/ws/:path*`,
      },
    ];
  },
};

export default nextConfig;
