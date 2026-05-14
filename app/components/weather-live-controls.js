"use client";

import { startTransition, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const OFFSET_OPTIONS = [
  { value: -1, key: "-1", label: "-1C" },
  { value: 0, key: "0", label: "0C" },
  { value: 1, key: "1", label: "+1C" },
];
const DEFAULT_MULTIPLIERS = [1, 2, 2, 2, 3];

function clampBaseStake(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 1;
  }
  return Math.min(5, Math.max(1, Math.round(numeric)));
}

function parseMultipliers(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,\-\s]+/);
  const parsed = raw
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0 && item <= 20)
    .slice(0, 8);
  return parsed.length ? parsed : [...DEFAULT_MULTIPLIERS];
}

function sequenceLabel(baseStake, multipliers) {
  const base = clampBaseStake(baseStake);
  return parseMultipliers(multipliers)
    .map((item) => Number((item * base).toFixed(3)))
    .map((item) => (Number.isInteger(item) ? String(item) : String(item)))
    .join("-");
}

function normalizeStrategies(offsetStrategies = {}, temperatureOffsets = [0], currentBaseStake = 1) {
  const enabled = new Set((Array.isArray(temperatureOffsets) ? temperatureOffsets : [0]).map((item) => Number(item)));
  const normalized = {};
  for (const option of OFFSET_OPTIONS) {
    const raw = offsetStrategies?.[option.key] || {};
    normalized[option.key] = {
      offset: option.value,
      enabled: Boolean(raw.enabled ?? enabled.has(option.value)),
      baseStake: clampBaseStake(raw.baseStake ?? currentBaseStake),
      multiplierText: parseMultipliers(raw.multipliers || DEFAULT_MULTIPLIERS).join("-"),
    };
  }
  if (!Object.values(normalized).some((item) => item.enabled)) {
    normalized["0"].enabled = true;
  }
  return normalized;
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

export function WeatherLiveControls({
  currentBaseStake,
  serviceStatus,
  executionMode = "live",
  temperatureOffsets = [0],
  offsetStrategies = {},
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [modeValue, setModeValue] = useState(executionMode === "simulation" ? "simulation" : "live");
  const [strategyValues, setStrategyValues] = useState(() =>
    normalizeStrategies(offsetStrategies, temperatureOffsets, currentBaseStake),
  );
  const [pending, setPending] = useState(false);
  const [actionPending, setActionPending] = useState("");

  useEffect(() => {
    setModeValue(executionMode === "simulation" ? "simulation" : "live");
    setStrategyValues(normalizeStrategies(offsetStrategies, temperatureOffsets, currentBaseStake));
  }, [currentBaseStake, executionMode, offsetStrategies, temperatureOffsets]);

  function updateStrategy(key, patch) {
    setStrategyValues((current) => {
      const next = {
        ...current,
        [key]: {
          ...current[key],
          ...patch,
        },
      };
      if (!Object.values(next).some((item) => item.enabled)) {
        next[key].enabled = true;
      }
      return next;
    });
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (pending) {
      return;
    }
    const normalizedStrategies = Object.fromEntries(
      Object.entries(strategyValues).map(([key, strategy]) => [
        key,
        {
          offset: Number(strategy.offset),
          enabled: Boolean(strategy.enabled),
          baseStake: clampBaseStake(strategy.baseStake),
          multipliers: parseMultipliers(strategy.multiplierText),
        },
      ]),
    );
    setPending(true);
    try {
      const response = await fetch("/api/weather", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          executionMode: modeValue,
          offsetStrategies: normalizedStrategies,
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
  const enabledStrategies = OFFSET_OPTIONS.filter((option) => offsetStrategies?.[option.key]?.enabled);
  const summaryLabel = enabledStrategies.length
    ? enabledStrategies
        .map((option) => {
          const strategy = offsetStrategies?.[option.key] || {};
          return `${option.label}:${strategy.sequenceLabel || sequenceLabel(strategy.baseStake || 1, strategy.multipliers)}`;
        })
        .join(" / ")
    : "0C";

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[1.6rem] border border-[var(--line)] bg-[rgba(255,255,255,0.74)] px-4 py-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--ink-soft)]">
            <span>当前状态:</span>
            <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${statusTone(currentServiceState)}`}>
              {currentServiceLabel}
            </span>
            <span className="rounded-full border border-[var(--line)] px-3 py-1 text-xs font-semibold text-neutral-800">
              {executionMode === "simulation" ? "模拟" : "实战"}
            </span>
          </div>
          <p className="text-sm text-[var(--ink-soft)]">{currentServiceDetail}</p>
          <p className="text-xs tracking-[0.28em] text-[var(--ink-soft)]">天气实盘设置</p>
          <p className="text-sm text-[var(--ink-soft)]">{summaryLabel}</p>
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
          <div className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-[1.8rem] border border-[var(--line)] bg-[var(--panel)] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.18)]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-display text-2xl font-semibold text-neutral-950">天气实盘设置</h3>
                <p className="mt-2 text-sm text-[var(--ink-soft)]">
                  -1C、0C、+1C 独立启用，初始额度和递进倍数互不影响。
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
              <div>
                <span className="text-sm text-[var(--ink-soft)]">运行模式</span>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {["simulation", "live"].map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setModeValue(mode)}
                      className={`rounded-2xl border px-4 py-3 text-sm font-semibold transition ${
                        modeValue === mode
                          ? "border-[var(--accent-strong)] bg-[rgba(214,122,67,0.16)] text-neutral-950"
                          : "border-[var(--line)] bg-white text-[var(--ink-soft)]"
                      }`}
                    >
                      {mode === "simulation" ? "模拟" : "实战"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid gap-3 lg:grid-cols-3">
                {OFFSET_OPTIONS.map((option) => {
                  const strategy = strategyValues[option.key];
                  const active = Boolean(strategy?.enabled);
                  return (
                    <section
                      key={option.key}
                      className={`rounded-[1.35rem] border p-4 ${
                        active
                          ? "border-[var(--accent-strong)] bg-[rgba(214,122,67,0.12)]"
                          : "border-[var(--line)] bg-white/70"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-xs uppercase tracking-[0.24em] text-[var(--ink-soft)]">Offset</p>
                          <h4 className="mt-1 text-2xl font-semibold text-neutral-950">{option.label}</h4>
                        </div>
                        <button
                          type="button"
                          onClick={() => updateStrategy(option.key, { enabled: !active })}
                          className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                            active
                              ? "border-[var(--accent-strong)] bg-white text-neutral-950"
                              : "border-[var(--line)] text-[var(--ink-soft)]"
                          }`}
                        >
                          {active ? "启用" : "停用"}
                        </button>
                      </div>

                      <label className="mt-4 block">
                        <span className="text-sm text-[var(--ink-soft)]">初始额度</span>
                        <input
                          type="number"
                          min="1"
                          max="5"
                          step="1"
                          value={strategy?.baseStake || 1}
                          onChange={(event) => updateStrategy(option.key, { baseStake: event.target.value })}
                          className="mt-2 w-full rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-base text-neutral-950 outline-none transition focus:border-[var(--accent-strong)]"
                        />
                      </label>

                      <label className="mt-3 block">
                        <span className="text-sm text-[var(--ink-soft)]">递进倍数</span>
                        <input
                          type="text"
                          value={strategy?.multiplierText || DEFAULT_MULTIPLIERS.join("-")}
                          onChange={(event) => updateStrategy(option.key, { multiplierText: event.target.value })}
                          className="mt-2 w-full rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-base text-neutral-950 outline-none transition focus:border-[var(--accent-strong)]"
                        />
                      </label>
                      <p className="mt-3 text-xs text-[var(--ink-soft)]">
                        实际序列 {sequenceLabel(strategy?.baseStake || 1, strategy?.multiplierText)}
                      </p>
                    </section>
                  );
                })}
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
