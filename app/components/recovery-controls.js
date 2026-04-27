"use client";

import { startTransition, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

function clampBaseMultiplier(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 1;
  }
  return Math.min(5, Math.max(1, Math.round(numeric)));
}

const ENTRY_MODE_OPTIONS = [
  {
    value: "limit-pair",
    label: "限价双边",
    helper: "事件开始前按当前规则挂上下双边限价单。",
  },
  {
    value: "trigger-threshold",
    label: "40c 触发",
    helper: "任一方向先到 40c 或以下就按规则下单。",
  },
];

function statusTone(state) {
  if (state === "running") {
    return "border-[rgba(31,139,94,0.28)] bg-[rgba(31,139,94,0.10)] text-[var(--signal-up)]";
  }
  if (state === "partial") {
    return "border-[rgba(212,126,57,0.28)] bg-[rgba(212,126,57,0.12)] text-[var(--accent-strong)]";
  }
  return "border-[rgba(192,49,36,0.24)] bg-[rgba(192,49,36,0.08)] text-[var(--signal-down)]";
}

export function RecoveryControls({ config, serviceStatus }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [entryMode, setEntryMode] = useState(config?.entryMode || "limit-pair");
  const [baseMultiplier, setBaseMultiplier] = useState(String(config?.baseMultiplier || 1));
  const [pending, setPending] = useState(false);
  const [actionPending, setActionPending] = useState("");

  useEffect(() => {
    setEntryMode(config?.entryMode || "limit-pair");
    setBaseMultiplier(String(config?.baseMultiplier || 1));
  }, [config]);

  async function handleSubmit(event) {
    event.preventDefault();
    if (pending) {
      return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/recovery", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          entryMode,
          baseMultiplier: clampBaseMultiplier(baseMultiplier),
        }),
      });
      if (!response.ok) {
        throw new Error("recovery-config-update-failed");
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
      const response = await fetch("/api/recovery", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) {
        throw new Error(`recovery-service-${action}-failed`);
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

  const currentMode =
    ENTRY_MODE_OPTIONS.find((item) => item.value === (config?.entryMode || "limit-pair")) ||
    ENTRY_MODE_OPTIONS[0];
  const currentBaseMultiplier = clampBaseMultiplier(config?.baseMultiplier || 1);
  const currentServiceState = serviceStatus?.state || "stopped";
  const currentServiceLabel = serviceStatus?.label || "已暂停";
  const currentServiceDetail = serviceStatus?.detail || "BTC 服务未启动";

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[1.6rem] border border-[var(--line)] bg-[rgba(255,255,255,0.74)] px-4 py-4">
        <div className="space-y-1 text-sm text-[var(--ink-soft)]">
          <div className="flex flex-wrap items-center gap-2">
            <span>当前状态：</span>
            <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${statusTone(currentServiceState)}`}>
              {currentServiceLabel}
            </span>
          </div>
          <div>{currentServiceDetail}</div>
          <div>当前模式：{currentMode.label}</div>
          <div>
            当前倍数：{currentBaseMultiplier} 倍，金额 {config?.baseLegUsd || currentBaseMultiplier} /{" "}
            {config?.recoveryLegUsd || currentBaseMultiplier * 2}
          </div>
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
          <div className="w-full max-w-xl rounded-[1.8rem] border border-[var(--line)] bg-[var(--panel)] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.18)]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-display text-2xl font-semibold text-neutral-950">BTC 恢复策略设置</h3>
                <p className="mt-2 text-sm text-[var(--ink-soft)]">
                  这里控制 BTC 的下单模式和初始倍数。初始填 1 就是 1 / 2，填 3 就是 3 / 6。
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

            <form className="mt-5 space-y-5" onSubmit={handleSubmit}>
              <div className="space-y-2">
                <div className="text-sm text-[var(--ink-soft)]">下单模式</div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {ENTRY_MODE_OPTIONS.map((item) => {
                    const active = entryMode === item.value;
                    return (
                      <button
                        key={item.value}
                        type="button"
                        onClick={() => setEntryMode(item.value)}
                        className={`rounded-[1.4rem] border px-4 py-4 text-left transition ${
                          active
                            ? "border-[var(--accent-strong)] bg-[rgba(212,126,57,0.12)]"
                            : "border-[var(--line)] bg-white hover:border-[var(--accent-strong)]"
                        }`}
                      >
                        <div className="text-base font-semibold text-neutral-950">{item.label}</div>
                        <div className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">{item.helper}</div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <label className="block">
                <span className="text-sm text-[var(--ink-soft)]">初始倍数</span>
                <input
                  type="number"
                  min="1"
                  max="5"
                  step="1"
                  value={baseMultiplier}
                  onChange={(event) => setBaseMultiplier(event.target.value)}
                  className="mt-2 w-full rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-base text-neutral-950 outline-none transition focus:border-[var(--accent-strong)]"
                />
              </label>

              <p className="text-sm leading-6 text-[var(--ink-soft)]">
                保存后会按 {clampBaseMultiplier(baseMultiplier)} / {clampBaseMultiplier(baseMultiplier) * 2} 运行。
                连亏触发恢复后保持第二档，直到该轮累计收益转正，再回到第一档。
              </p>

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
