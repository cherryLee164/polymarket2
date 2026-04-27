"use client";

import { startTransition, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

function clampBaseStake(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 1;
  }
  return Math.min(5, Math.max(1, Math.round(numeric)));
}

function statusTone(state) {
  if (state === "running") {
    return "border-[rgba(31,139,94,0.28)] bg-[rgba(31,139,94,0.10)] text-[var(--signal-up)]";
  }
  if (state === "partial") {
    return "border-[rgba(212,126,57,0.28)] bg-[rgba(212,126,57,0.12)] text-[var(--accent-strong)]";
  }
  return "border-[rgba(192,49,36,0.24)] bg-[rgba(192,49,36,0.08)] text-[var(--signal-down)]";
}

export function WeatherLiveControls({ currentBaseStake, sequenceLabel, serviceStatus }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState(String(currentBaseStake || 1));
  const [pending, setPending] = useState(false);
  const [actionPending, setActionPending] = useState("");

  useEffect(() => {
    setInputValue(String(currentBaseStake || 1));
  }, [currentBaseStake]);

  async function handleSubmit(event) {
    event.preventDefault();
    if (pending) {
      return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/weather", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          liveBaseStake: clampBaseStake(inputValue),
        }),
      });
      if (!response.ok) {
        throw new Error("weather-config-update-failed");
      }
      setOpen(false);
      startTransition(() => {
        router.refresh();
      });
    } catch (error) {
      console.error(error);
    } finally {
      setPending(false);
    }
  }

  async function handleServiceAction(action) {
    if (actionPending) {
      return;
    }
    setActionPending(action);
    try {
      const response = await fetch("/api/weather", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) {
        throw new Error(`weather-service-${action}-failed`);
      }
      startTransition(() => {
        router.refresh();
      });
    } catch (error) {
      console.error(error);
    } finally {
      setActionPending("");
    }
  }

  const currentServiceState = serviceStatus?.state || "stopped";
  const currentServiceLabel = serviceStatus?.label || "已暂停";
  const currentServiceDetail = serviceStatus?.detail || "天气同步未启动";

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[1.6rem] border border-[var(--line)] bg-[rgba(255,255,255,0.74)] px-4 py-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--ink-soft)]">
            <span>当前状态：</span>
            <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${statusTone(currentServiceState)}`}>
              {currentServiceLabel}
            </span>
          </div>
          <p className="text-sm text-[var(--ink-soft)]">{currentServiceDetail}</p>
          <p className="text-xs tracking-[0.28em] text-[var(--ink-soft)]">天气实盘设置</p>
          <p className="text-sm text-[var(--ink-soft)]">当前初始 {currentBaseStake}，序列 {sequenceLabel}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => handleServiceAction("start")}
            disabled={Boolean(actionPending) || currentServiceState === "running"}
            className="rounded-full border border-[rgba(31,139,94,0.28)] bg-[rgba(31,139,94,0.10)] px-4 py-2 text-sm font-semibold text-[var(--signal-up)] transition disabled:cursor-not-allowed disabled:opacity-60"
          >
            {actionPending === "start" ? "启动中..." : "启动"}
          </button>
          <button
            type="button"
            onClick={() => handleServiceAction("stop")}
            disabled={Boolean(actionPending) || currentServiceState === "stopped"}
            className="rounded-full border border-[rgba(192,49,36,0.24)] bg-[rgba(192,49,36,0.08)] px-4 py-2 text-sm font-semibold text-[var(--signal-down)] transition disabled:cursor-not-allowed disabled:opacity-60"
          >
            {actionPending === "stop" ? "暂停中..." : "暂停"}
          </button>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-full border border-[var(--line)] px-4 py-2 text-sm font-semibold text-neutral-800 transition hover:border-[var(--accent-strong)] hover:text-[var(--accent-strong)]"
          >
            设置
          </button>
        </div>
      </div>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4">
          <div className="w-full max-w-md rounded-[1.8rem] border border-[var(--line)] bg-[var(--panel)] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.18)]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-display text-2xl font-semibold text-neutral-950">天气实盘设置</h3>
                <p className="mt-2 text-sm text-[var(--ink-soft)]">
                  输入初始倍数，范围 1 到 5。保存后按 n / 2n / 3n 生效。
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-full border border-[var(--line)] px-3 py-1 text-sm text-[var(--ink-soft)]"
              >
                关闭
              </button>
            </div>

            <form className="mt-5 space-y-4" onSubmit={handleSubmit}>
              <label className="block">
                <span className="text-sm text-[var(--ink-soft)]">初始倍数</span>
                <input
                  type="number"
                  min="1"
                  max="5"
                  step="1"
                  value={inputValue}
                  onChange={(event) => setInputValue(event.target.value)}
                  className="mt-2 w-full rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-base text-neutral-950 outline-none transition focus:border-[var(--accent-strong)]"
                />
              </label>

              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-full border border-[var(--line)] px-4 py-2 text-sm font-semibold text-neutral-800"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={pending}
                  className="rounded-full bg-[linear-gradient(135deg,var(--accent),var(--accent-strong))] px-5 py-2 text-sm font-semibold text-[var(--accent-ink)] shadow-[0_12px_30px_rgba(184,87,38,0.18)] disabled:opacity-70"
                >
                  {pending ? "保存中..." : "保存"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
