"use client";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-4">
      <div
        className="w-16 h-16 rounded-full flex items-center justify-center"
        style={{ background: "var(--clr-gold-soft)" }}
      >
        <svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--clr-amber)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </div>
      <h2
        className="text-lg font-semibold"
        style={{ color: "var(--clr-text)" }}
      >
        页面加载失败
      </h2>
      <p className="text-sm" style={{ color: "var(--clr-text-muted)" }}>
        {error.message || "发生了未知错误，请稍后重试"}
      </p>
      <div className="flex gap-3 mt-2">
        <a
          href="/dashboard/analysis"
          className="px-5 py-2 rounded-lg text-sm font-medium transition-all hover:opacity-90"
          style={{ border: "1px solid var(--clr-border)", background: "var(--clr-bg-alt)", color: "var(--clr-text)" }}
        >
          返回分析页
        </a>
        <button
          onClick={reset}
          className="px-5 py-2 rounded-lg text-sm font-medium text-white transition-all hover:opacity-90 cursor-pointer"
          style={{ background: "var(--clr-amber)" }}
        >
          重试
        </button>
      </div>
    </div>
  );
}
