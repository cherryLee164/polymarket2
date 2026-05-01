"use client";

import { startTransition, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const DEFAULT_CONFIG = {
  entryLeadMinutes: 60,
  limitPriceCents: 40,
  limitShares: 5,
};

function clampNumber(value, fallback, min, max, decimals = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  const bounded = Math.min(max, Math.max(min, numeric));
  const factor = 10 ** decimals;
  return Math.round(bounded * factor) / factor;
}

function normalizeConfig(config) {
  const entryLeadMinutes = clampNumber(
    config?.entryLeadMinutes,
    DEFAULT_CONFIG.entryLeadMinutes,
    1,
    240,
    0,
  );
  const limitPriceCents = clampNumber(
    config?.limitPriceCents,
    DEFAULT_CONFIG.limitPriceCents,
    1,
    99,
    2,
  );
  const limitShares = clampNumber(
    config?.limitShares,
    DEFAULT_CONFIG.limitShares,
    0.01,
    10000,
    4,
  );
  return {
    entryLeadMinutes,
    limitPriceCents,
    limitShares,
    estimatedOrderUsd: Number(((entryLeadMinutes ? limitPriceCents * limitShares : 0) / 100).toFixed(6)),
  };
}

function formatUsd(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "--";
  }
  return `$${numeric.toFixed(3)}`;
}

function serviceLabel(state) {
  if (state === "running") {
    return "运行中";
  }
  if (state === "partial") {
    return "部分运行";
  }
  return "已暂停";
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

function serviceDetail(serviceStatus) {
  const monitor = serviceStatus?.monitor;
  const recovery = serviceStatus?.recovery;
  if (!monitor && !recovery) {
    return serviceStatus?.detail || "BTC 服务未启动";
  }
  const monitorText = `监控 ${monitor?.runningCount ?? 0}/${monitor?.expectedCount ?? 4}`;
  const recoveryText = recovery?.workerRunning ? "4小时下单已启动" : "4小时下单已暂停";
  return `${monitorText}，${recoveryText}`;
}

export function RecoveryControls({ config, serviceStatus }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [entryLeadMinutes, setEntryLeadMinutes] = useState(String(DEFAULT_CONFIG.entryLeadMinutes));
  const [limitPriceCents, setLimitPriceCents] = useState(String(DEFAULT_CONFIG.limitPriceCents));
  const [limitShares, setLimitShares] = useState(String(DEFAULT_CONFIG.limitShares));
  const [pending, setPending] = useState(false);
  const [actionPending, setActionPending] = useState("");

  useEffect(() => {
    const normalized = normalizeConfig(config);
    setEntryLeadMinutes(String(normalized.entryLeadMinutes));
    setLimitPriceCents(String(normalized.limitPriceCents));
    setLimitShares(String(normalized.limitShares));
  }, [config]);

  const currentConfig = normalizeConfig(config);
  const draftConfig = normalizeConfig({
    entryLeadMinutes,
    limitPriceCents,
    limitShares,
  });
  const currentServiceState = serviceStatus?.state || "stopped";
  const currentServiceLabel = serviceLabel(currentServiceState);

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
          entryLeadMinutes: draftConfig.entryLeadMinutes,
          limitPriceCents: draftConfig.limitPriceCents,
          limitShares: draftConfig.limitShares,
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
          <div>{serviceDetail(serviceStatus)}</div>
          <div>
            当前配置：开场前 {currentConfig.entryLeadMinutes} 分钟，双边限价{" "}
            {currentConfig.limitPriceCents}c，每边 {currentConfig.limitShares} 份
          </div>
          <div>预计单边花费：{formatUsd(currentConfig.estimatedOrderUsd)}</div>
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
                <h3 className="font-display text-2xl font-semibold text-neutral-950">4小时限价单设置</h3>
                <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">
                  这里只控制固定挂单逻辑：到开场前指定时间后，上下两边都挂限价买单；失败由 worker 继续重试。
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
              <div className="grid gap-4 sm:grid-cols-3">
                <label className="block">
                  <span className="text-sm text-[var(--ink-soft)]">开场前分钟</span>
                  <input
                    type="number"
                    min="1"
                    max="240"
                    step="1"
                    value={entryLeadMinutes}
                    onChange={(event) => setEntryLeadMinutes(event.target.value)}
                    className="mt-2 w-full rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-base text-neutral-950 outline-none transition focus:border-[var(--accent-strong)]"
                  />
                </label>
                <label className="block">
                  <span className="text-sm text-[var(--ink-soft)]">限价价格 c</span>
                  <input
                    type="number"
                    min="1"
                    max="99"
                    step="0.1"
                    value={limitPriceCents}
                    onChange={(event) => setLimitPriceCents(event.target.value)}
                    className="mt-2 w-full rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-base text-neutral-950 outline-none transition focus:border-[var(--accent-strong)]"
                  />
                </label>
                <label className="block">
                  <span className="text-sm text-[var(--ink-soft)]">每边份额</span>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={limitShares}
                    onChange={(event) => setLimitShares(event.target.value)}
                    className="mt-2 w-full rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-base text-neutral-950 outline-none transition focus:border-[var(--accent-strong)]"
                  />
                </label>
              </div>

              <div className="rounded-[1.4rem] border border-[var(--line)] bg-white/70 px-4 py-4 text-sm leading-6 text-[var(--ink-soft)]">
                保存后配置：开场前 {draftConfig.entryLeadMinutes} 分钟开始，价格 {draftConfig.limitPriceCents}c，
                每边 {draftConfig.limitShares} 份；单边预计 {formatUsd(draftConfig.estimatedOrderUsd)}，
                双边预计 {formatUsd(draftConfig.estimatedOrderUsd * 2)}。
              </div>

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
