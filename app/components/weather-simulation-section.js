"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { startTransition } from "react";

function formatMoney(value, digits = 3) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "--";
  }
  const sign = numeric > 0 ? "+" : "";
  return `${sign}$${numeric.toFixed(digits)}`;
}

function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "--";
  }
  const sign = numeric > 0 ? "+" : "";
  return `${sign}${(numeric * 100).toFixed(2)}%`;
}

function formatPrice(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${(numeric * 100).toFixed(1)}¢` : "--";
}

function formatShortDate(ymd) {
  const [, month, day] = String(ymd || "").split("-");
  if (!month || !day) {
    return ymd || "--";
  }
  return `${month}/${day}`;
}

function formatDelta(value, unit) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "--";
  }
  const rendered = Math.round(numeric);
  const sign = numeric > 0 ? "+" : "";
  const suffix = unit === "fahrenheit" ? "°F" : "°C";
  return `${sign}${rendered}${suffix}`;
}

function offsetLabel(value) {
  const numeric = Number(value) || 0;
  return `${numeric > 0 ? "+" : ""}${numeric}C`;
}

function toneClass(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) {
    return "text-neutral-950";
  }
  return numeric > 0 ? "text-[var(--signal-up)]" : "text-[var(--signal-down)]";
}

function aggregateRows(rows) {
  const settled = rows.filter((row) => row.status === "resolved" && Number.isFinite(Number(row.accountingPnlUsd)));
  const totalStakeUsd = settled.reduce((sum, row) => sum + Number(row.stakeUsd || 0), 0);
  const netPnlUsd = settled.reduce((sum, row) => sum + Number(row.accountingPnlUsd || 0), 0);
  return {
    records: rows.length,
    settledRecords: settled.length,
    pending: rows.length - settled.length,
    wins: settled.filter((row) => Number(row.accountingPnlUsd) > 0).length,
    losses: settled.filter((row) => Number(row.accountingPnlUsd) < 0).length,
    totalStakeUsd,
    netPnlUsd,
    roi: totalStakeUsd > 0 ? netPnlUsd / totalStakeUsd : null,
  };
}

// 按日期汇总每天的收益
function buildDailyPnl(rows) {
  const map = new Map();
  for (const row of rows) {
    const date = row.date || "";
    if (!date) continue;
    const acc = map.get(date) || { date, pnl: 0, settled: 0, pending: 0, stake: 0 };
    // 投入金额包含所有已下单订单（pending + settled）
    acc.stake += Number(row.stakeUsd || 0);
    if (row.status === "resolved" && Number.isFinite(Number(row.accountingPnlUsd))) {
      acc.pnl += Number(row.accountingPnlUsd);
      acc.settled += 1;
    } else {
      acc.pending += 1;
    }
    map.set(date, acc);
  }
  return [...map.values()]
    .map((item) => ({
      ...item,
      pnl: Math.round(item.pnl * 1e6) / 1e6,
      stake: Math.round(item.stake * 1e6) / 1e6,
    }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function DailyPnlList({ rows }) {
  const daily = buildDailyPnl(rows);
  if (!daily.length) {
    return <p className="mt-3 text-xs text-[var(--ink-soft)]">还没有记录</p>;
  }
  return (
    <div className="mt-3 max-h-[320px] overflow-y-auto rounded-[1rem] border border-[var(--line)]">
      <table className="min-w-full text-left text-sm">
        <thead className="sticky top-0 bg-[rgba(246,236,216,0.55)] text-xs text-[var(--ink-soft)]">
          <tr>
            <th className="px-3 py-2 font-medium">日期</th>
            <th className="px-3 py-2 font-medium">已结算</th>
            <th className="px-3 py-2 font-medium">待结算</th>
            <th className="px-3 py-2 font-medium">投入</th>
            <th className="px-3 py-2 font-medium">收益</th>
          </tr>
        </thead>
        <tbody>
          {daily.map((item) => (
            <tr key={item.date} className="border-t border-[var(--line)]">
              <td className="px-3 py-2 font-medium text-neutral-950">{formatShortDate(item.date)}</td>
              <td className="px-3 py-2 text-[var(--ink-soft)]">{item.settled}</td>
              <td className="px-3 py-2 text-[var(--ink-soft)]">{item.pending}</td>
              <td className="px-3 py-2 text-[var(--ink-soft)]">${item.stake.toFixed(2)}</td>
              <td className={`px-3 py-2 font-semibold ${toneClass(item.pnl)}`}>
                {item.settled > 0 ? formatMoney(item.pnl) : "--"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SimMetricCard({ label, value, helper, toneValue }) {
  return (
    <article className="rounded-[1.25rem] border border-[var(--line)] bg-[rgba(255,255,255,0.72)] px-4 py-3">
      <p className="text-xs text-[var(--ink-soft)]">{label}</p>
      <div className={`mt-1 text-2xl font-semibold ${toneClass(toneValue ?? value)}`}>{value}</div>
      {helper ? <p className="mt-1 text-xs text-[var(--ink-soft)]">{helper}</p> : null}
    </article>
  );
}

function SimulationTable({ title, rows, isFollowYesterday }) {
  return (
    <section className="overflow-hidden rounded-[1.6rem] border border-[var(--line)] bg-[var(--panel)] shadow-[var(--shadow)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
        <h3 className="font-display text-xl font-semibold tracking-[0.04em] text-neutral-950">{title}</h3>
        <p className="text-xs text-[var(--ink-soft)]">{rows.length} 条</p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-[rgba(246,236,216,0.55)] text-xs text-[var(--ink-soft)]">
            <tr>
              <th className="px-4 py-3 font-medium">日期</th>
              <th className="px-4 py-3 font-medium">城市</th>
              {isFollowYesterday && <th className="px-4 py-3 font-medium">昨天偏移</th>}
              <th className="px-4 py-3 font-medium">策略</th>
              <th className="px-4 py-3 font-medium">市场</th>
              <th className="px-4 py-3 font-medium">No 价格</th>
              <th className="px-4 py-3 font-medium">实际高温</th>
              <th className="px-4 py-3 font-medium">收益</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.slice(0, 100).map((row) => (
                <tr key={row.key} className="border-t border-[var(--line)] align-top">
                  <td className="px-4 py-3">{formatShortDate(row.date)}</td>
                  <td className="px-4 py-3">
                    <div className="font-semibold text-neutral-950">{row.cityZh}</div>
                    <div className="mt-1 text-xs text-[var(--ink-soft)]">{row.forecastTarget}</div>
                  </td>
                  {isFollowYesterday && (
                    <td className={`px-4 py-3 font-semibold ${toneClass(row.prevDateDeltaC)}`}>
                      {Number.isFinite(row.prevDateDeltaC) ? formatDelta(row.prevDateDeltaC, row?.unit) : "--"}
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <div className="font-semibold text-neutral-950">{offsetLabel(row.temperatureOffsetC)}</div>
                    <div className="mt-1 text-xs text-[var(--ink-soft)]">
                      预报 {row.forecastMaxTempC ?? "--"}{row?.unit === "fahrenheit" ? "°F" : "°C"} / 目标 {row.targetTempC ?? "--"}{row?.unit === "fahrenheit" ? "°F" : "°C"}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-semibold text-neutral-950">{row.marketTitle || "--"}</div>
                    <div className="mt-1 max-w-[320px] truncate text-xs text-[var(--ink-soft)]">{row.marketQuestion}</div>
                  </td>
                  <td className="px-4 py-3 font-semibold text-neutral-950">{formatPrice(row.buyNoPrice)}</td>
                  <td className="px-4 py-3">{row.actualTempLabel || (row.actualMaxTempC != null && Number.isFinite(Number(row.actualMaxTempC)) ? `${Math.round(Number(row.actualMaxTempC))}${row?.unit === "fahrenheit" ? "°F" : "°C"}` : "--")}</td>
                  <td className={`px-4 py-3 font-semibold ${toneClass(row.accountingPnlUsd)}`}>
                    {row.status === "resolved" ? formatMoney(row.accountingPnlUsd) : "--"}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="px-4 py-8 text-center text-sm text-[var(--ink-soft)]" colSpan={isFollowYesterday ? 8 : 7}>
                  还没有模拟记录。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const REGION_LABELS = {
  domestic: "国内",
  "asia-foreign": "亚洲",
  europe: "欧洲",
  "north-america": "北美",
  "south-america": "南美",
  africa: "非洲",
  oceania: "大洋洲",
};

function CityRankingTable({ ranking }) {
  const cities = Array.isArray(ranking) ? ranking : [];
  // 按地区汇总
  const byRegion = new Map();
  for (const item of cities) {
    const region = item.region || "domestic";
    const acc = byRegion.get(region) || {
      region,
      regionLabel: REGION_LABELS[region] || region,
      cities: 0,
      settledRecords: 0,
      wins: 0,
      losses: 0,
      totalStakeUsd: 0,
      netPnlUsd: 0,
    };
    acc.cities += 1;
    acc.settledRecords += item.settledRecords || 0;
    acc.wins += item.wins || 0;
    acc.losses += item.losses || 0;
    acc.totalStakeUsd += Number(item.totalStakeUsd) || 0;
    acc.netPnlUsd += Number(item.netPnlUsd) || 0;
    byRegion.set(region, acc);
  }
  const regionRows = [...byRegion.values()]
    .map((item) => ({
      ...item,
      totalStakeUsd: Math.round(item.totalStakeUsd * 1e6) / 1e6,
      netPnlUsd: Math.round(item.netPnlUsd * 1e6) / 1e6,
      roi: item.totalStakeUsd > 0 ? item.netPnlUsd / item.totalStakeUsd : null,
    }))
    .sort((left, right) => Number(right.netPnlUsd) - Number(left.netPnlUsd));

  return (
    <section className="overflow-hidden rounded-[1.6rem] border border-[var(--line)] bg-[var(--panel)] shadow-[var(--shadow)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
        <h3 className="font-display text-xl font-semibold tracking-[0.04em] text-neutral-950">城市收益排名</h3>
        <p className="text-xs text-[var(--ink-soft)]">{cities.length} 个城市</p>
      </div>

      {/* 地区汇总 */}
      {regionRows.length > 0 && (
        <div className="border-b border-[var(--line)] px-4 py-3">
          <p className="mb-2 text-xs font-medium tracking-[0.16em] text-[var(--ink-soft)]">地区汇总</p>
          <div className="flex flex-wrap gap-2">
            {regionRows.map((row) => (
              <div
                key={row.region}
                className="flex items-center gap-2 rounded-full border border-[var(--line)] bg-[rgba(255,255,255,0.6)] px-3 py-1.5"
              >
                <span className="text-sm font-semibold text-neutral-950">{row.regionLabel}</span>
                <span className="text-xs text-[var(--ink-soft)]">{row.cities}城</span>
                <span className={`text-sm font-semibold ${toneClass(row.netPnlUsd)}`}>
                  {formatMoney(row.netPnlUsd)}
                </span>
                {Number.isFinite(row.roi) && (
                  <span className={`text-xs ${toneClass(row.roi)}`}>{formatPercent(row.roi)}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 城市排名表格 */}
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-[rgba(246,236,216,0.55)] text-xs text-[var(--ink-soft)]">
            <tr>
              <th className="px-4 py-3 font-medium">#</th>
              <th className="px-4 py-3 font-medium">城市</th>
              <th className="px-4 py-3 font-medium">地区</th>
              <th className="px-4 py-3 font-medium">已结算</th>
              <th className="px-4 py-3 font-medium">胜/负</th>
              <th className="px-4 py-3 font-medium">投入</th>
              <th className="px-4 py-3 font-medium">净收益</th>
              <th className="px-4 py-3 font-medium">ROI</th>
            </tr>
          </thead>
          <tbody>
            {cities.length ? (
              cities.map((row, index) => (
                <tr key={row.citySlug} className="border-t border-[var(--line)] align-top">
                  <td className="px-4 py-3 font-semibold text-[var(--ink-soft)]">{index + 1}</td>
                  <td className="px-4 py-3">
                    <div className="font-semibold text-neutral-950">{row.cityZh}</div>
                    <div className="mt-0.5 text-xs text-[var(--ink-soft)]">{row.cityEn}</div>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <span className="rounded-full bg-[rgba(246,236,216,0.5)] px-2 py-1 text-[var(--ink-soft)]">
                      {REGION_LABELS[row.region] || row.region}
                    </span>
                  </td>
                  <td className="px-4 py-3">{row.settledRecords}</td>
                  <td className="px-4 py-3">
                    <span className="text-[var(--signal-up)]">{row.wins}</span>
                    <span className="text-[var(--ink-soft)]"> / </span>
                    <span className="text-[var(--signal-down)]">{row.losses}</span>
                  </td>
                  <td className="px-4 py-3">${Number(row.totalStakeUsd || 0).toFixed(2)}</td>
                  <td className={`px-4 py-3 font-semibold ${toneClass(row.netPnlUsd)}`}>
                    {formatMoney(row.netPnlUsd)}
                  </td>
                  <td className={`px-4 py-3 ${toneClass(row.roi)}`}>{formatPercent(row.roi)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="px-4 py-8 text-center text-sm text-[var(--ink-soft)]" colSpan={8}>
                  还没有已结算的模拟记录。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function WeatherSimulationSection({ simOrders, localDate, serviceStatus }) {
  const router = useRouter();
  const [expandedSim, setExpandedSim] = useState(null); // "a" | "b" | null
  const [actionPending, setActionPending] = useState("");
  const [boostAmount, setBoostAmount] = useState("1");
  const [boostStatus, setBoostStatus] = useState("");
  const [daysRange, setDaysRange] = useState(7); // 默认显示 7 天

  const currentServiceState = serviceStatus?.state || "stopped";

  // 7 天日期范围筛选
  const cutoffDate = useMemo(() => {
    if (!localDate) return null;
    const d = new Date(localDate + "T00:00:00+08:00");
    d.setDate(d.getDate() - (daysRange - 1));
    return d.toISOString().slice(0, 10);
  }, [localDate, daysRange]);

  // 模式 A: 0度策略（来自 0:10 模拟下单）
  const simA = simOrders?.zeroOffset || {};
  const simARecordsAll = simA.records || [];
  const simARecords = cutoffDate
    ? simARecordsAll.filter((r) => String(r.date || "") >= cutoffDate)
    : simARecordsAll;
  const simASummary = aggregateRows(simARecords);

  // 模式 B: 跟昨天偏移策略（来自 0:10 模拟下单）
  const simB = simOrders?.followYesterday || {};
  const simBRecordsAll = simB.records || [];
  const simBRecords = cutoffDate
    ? simBRecordsAll.filter((r) => String(r.date || "") >= cutoffDate)
    : simBRecordsAll;
  const simBSummary = aggregateRows(simBRecords);

  async function handleServiceAction(action) {
    if (actionPending) return;
    setActionPending(action);
    try {
      const response = await fetch("/api/weather", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) throw new Error(`weather-service-${action}-failed`);
      startTransition(() => { router.refresh(); });
    } catch (error) {
      console.error(error);
    } finally {
      setActionPending("");
    }
  }

  async function handleBoost() {
    if (actionPending === "boost") return;
    const amount = Number(boostAmount) || 1;
    setActionPending("boost");
    setBoostStatus("");
    try {
      const response = await fetch("/api/weather", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "boost", amount }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "boost-failed");
      setBoostStatus(`加仓已启动：每个城市 $${amount}，日志：${data?.logFile || ""}`);
    } catch (error) {
      setBoostStatus(`加仓失败：${error?.message || error}`);
    } finally {
      setActionPending("");
    }
  }

  return (
    <div className="space-y-4">
      {/* 标题栏 + 控制按钮 */}
      <section className="rounded-[1.8rem] border border-[var(--line)] bg-[linear-gradient(135deg,rgba(255,255,255,0.86),rgba(246,236,216,0.72))] p-4 shadow-[var(--shadow)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="font-display text-xs uppercase tracking-[0.36em] text-[var(--ink-soft)]">Simulation</p>
            <h2 className="text-2xl font-semibold text-neutral-950">模拟策略收益对比</h2>
            <p className="text-sm text-[var(--ink-soft)]">每日 0:10 自动下单模拟，单笔 $1，观察哪个模式更优</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* 天数筛选 */}
            <div className="flex items-center gap-1 rounded-full border border-[var(--line)] bg-white/60 p-1">
              {[7, 14, 30].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDaysRange(d)}
                  className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                    daysRange === d
                      ? "bg-[var(--accent-strong)] text-white"
                      : "text-[var(--ink-soft)] hover:text-neutral-950"
                  }`}
                >
                  {d}天
                </button>
              ))}
            </div>
            {/* 启动/暂停/加仓 */}
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
            <div className="flex items-center gap-1">
              <input
                type="number"
                min="1"
                max="10"
                step="1"
                value={boostAmount}
                onChange={(e) => setBoostAmount(e.target.value)}
                className="w-14 rounded-full border border-[var(--line)] bg-white px-3 py-2 text-sm text-neutral-950 outline-none focus:border-[var(--accent-strong)]"
              />
              <button
                type="button"
                onClick={handleBoost}
                disabled={Boolean(actionPending)}
                className="rounded-full border border-[rgba(184,87,38,0.28)] bg-[rgba(184,87,38,0.10)] px-4 py-2 text-sm font-semibold text-[var(--accent-strong)] transition disabled:cursor-not-allowed disabled:opacity-60"
              >
                {actionPending === "boost" ? "加仓中..." : "加仓"}
              </button>
            </div>
          </div>
        </div>
        {boostStatus ? (
          <p className="mt-2 text-xs text-[var(--accent-strong)]">{boostStatus}</p>
        ) : null}
      </section>

      {/* 两个模式并排 */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* 模式 A */}
        <section className="rounded-[1.6rem] border border-[var(--line)] bg-[var(--panel)] p-4 shadow-[var(--shadow)]">
          <div>
            <p className="font-display text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">Strategy A</p>
            <h3 className="mt-1 text-xl font-semibold text-neutral-950">0 度策略</h3>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <SimMetricCard label="收益" value={formatMoney(simASummary.netPnlUsd)} helper={`${simASummary.settledRecords} 已结算`} toneValue={simASummary.netPnlUsd} />
            <SimMetricCard label="ROI" value={formatPercent(simASummary.roi)} helper={`赢 ${simASummary.wins} / 输 ${simASummary.losses}`} toneValue={simASummary.roi} />
          </div>
          <p className="mt-3 text-xs text-[var(--ink-soft)]">买入预报温度对应的 NO 合约，近{daysRange}天 {simARecords.length} 条记录</p>
          <DailyPnlList rows={simARecords} />
        </section>

        {/* 模式 B */}
        <section className="rounded-[1.6rem] border border-[var(--line)] bg-[var(--panel)] p-4 shadow-[var(--shadow)]">
          <div>
            <p className="font-display text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">Strategy B</p>
            <h3 className="mt-1 text-xl font-semibold text-neutral-950">跟昨天偏移</h3>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <SimMetricCard label="收益" value={formatMoney(simBSummary.netPnlUsd)} helper={`${simBSummary.settledRecords} 已结算`} toneValue={simBSummary.netPnlUsd} />
            <SimMetricCard label="ROI" value={formatPercent(simBSummary.roi)} helper={`赢 ${simBSummary.wins} / 输 ${simBSummary.losses}`} toneValue={simBSummary.roi} />
          </div>
          <p className="mt-3 text-xs text-[var(--ink-soft)]">昨天偏移+2则今天买+2，近{daysRange}天 {simBRecords.length} 条记录</p>
          <DailyPnlList rows={simBRecords} />
        </section>
      </div>
    </div>
  );
}
