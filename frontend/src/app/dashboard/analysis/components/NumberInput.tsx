"use client";

import React, { useEffect, useState } from "react";

/**
 * 受控数字输入：允许自由输入，但在失焦/回车时把值强制夹到 [min, max]。
 * 解决原生 <input type="number"> 的 min/max 只约束步进箭头、不拦截手动输入的问题
 * (用户可直接敲 99999999)。空值/非法 → 回退到下界。
 * min/max 可传动态值(如另一字段)以实现"最小不得大于最大"等跨字段约束。
 */
export default function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  className,
  style,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
}) {
  const [text, setText] = useState<string>(Number.isFinite(value) ? String(value) : "");

  // 外部值变化(重置/跨字段联动)时同步显示
  useEffect(() => {
    setText(Number.isFinite(value) ? String(value) : "");
  }, [value]);

  // min/max 动态变化(跨字段联动 / 加载到非法历史值)时, 若当前值越界则就地夹紧并上报,
  // 不必等用户再次失焦。只依赖 [min, max] —— 避免在 value/text 变化(打字)时反复夹紧打断输入。
  useEffect(() => {
    const n = Number(text);
    if (!Number.isFinite(n)) return;
    const lo = min ?? -Infinity;
    const hi = max ?? Infinity;
    if (n >= lo && n <= hi) return;
    const clamped = Math.min(Math.max(n, lo), hi);
    setText(String(clamped));
    if (clamped !== value) onChange(clamped);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [min, max]);

  const commit = () => {
    let n = Number(text);
    if (text.trim() === "" || !Number.isFinite(n)) {
      n = min ?? 0; // 空/非法 → 下界
    }
    if (min != null && n < min) n = min;
    if (max != null && n > max) n = max;
    setText(String(n));
    if (n !== value) onChange(n);
  };

  return (
    <input
      type="number"
      value={text}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      className={className}
      style={style}
    />
  );
}
