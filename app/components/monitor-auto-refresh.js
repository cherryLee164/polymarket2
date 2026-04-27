"use client";

import { startTransition, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const REFRESH_INTERVALS = {
  "5m": 5000,
  "15m": 5000,
  "1h": 60000,
  "4h": 120000,
};

function getRefreshIntervalMs(variant) {
  return REFRESH_INTERVALS[String(variant || "").toLowerCase()] || 60000;
}

function formatIntervalLabel(intervalMs) {
  if (intervalMs < 60000) {
    return `${Math.round(intervalMs / 1000)}秒`;
  }
  return `${Math.round(intervalMs / 60000)}分钟`;
}

function formatRemainingLabel(remainingMs) {
  if (remainingMs < 60000) {
    return `${Math.max(1, Math.ceil(remainingMs / 1000))}秒`;
  }
  const minutes = Math.floor(remainingMs / 60000);
  const seconds = Math.ceil((remainingMs % 60000) / 1000);
  if (seconds >= 60) {
    return `${minutes + 1}分钟`;
  }
  if (seconds <= 0) {
    return `${Math.max(1, minutes)}分钟`;
  }
  return `${minutes}分${seconds}秒`;
}

export function MonitorAutoRefresh({ monitorVariant }) {
  const router = useRouter();
  const intervalMs = getRefreshIntervalMs(monitorVariant);
  const [remainingMs, setRemainingMs] = useState(intervalMs);

  useEffect(() => {
    const refreshTimer = setInterval(() => {
      startTransition(() => {
        router.refresh();
      });
      setRemainingMs(intervalMs);
    }, intervalMs);

    const countdownTimer = setInterval(() => {
      setRemainingMs((current) => {
        if (current <= 1000) {
          return intervalMs;
        }
        return current - 1000;
      });
    }, 1000);

    return () => {
      clearInterval(refreshTimer);
      clearInterval(countdownTimer);
    };
  }, [intervalMs, router]);

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[1.5rem] border border-[var(--line)] bg-white/72 px-4 py-3 text-sm text-[var(--ink-soft)] shadow-[var(--shadow)]">
      <span className="font-medium text-neutral-900">
        自动刷新：{String(monitorVariant || "").toUpperCase()}
      </span>
      <span>间隔 {formatIntervalLabel(intervalMs)}</span>
      <span>剩余 {formatRemainingLabel(remainingMs)}</span>
    </div>
  );
}
