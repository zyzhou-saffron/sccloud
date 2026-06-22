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

  // 外部 value 或 min/max 变化(重置 / 跨字段联动 / 加载到非法历史值)时: 同步显示,
  // 并在 value 越界时就地夹紧并上报(无需用户再失焦, 故加载的越界值不会被原样提交)。
  // 关键: 以 value(权威源)而非 text 为准 —— 避免 value 与边界同一批更新时读到上一渲染的陈旧 text。
  // 依赖 [value, min, max] 不含 text, 故打字过程(只改 text 不改 value)不会被打断。
  useEffect(() => {
    if (!Number.isFinite(value)) {
      setText("");
      return;
    }
    const lo = min ?? -Infinity;
    const hi = max ?? Infinity;
    if (value < lo || value > hi) {
      const clamped = Math.min(Math.max(value, lo), hi);
      setText(String(clamped));
      onChange(clamped);
    } else {
      setText(String(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, min, max]);

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
