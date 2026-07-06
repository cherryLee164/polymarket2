"use client";

import { useState } from "react";

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

export function WeatherSimulationSection({ simOrders, localDate }) {
  const [expandedSim, setExpandedSim] = useState(null); // "a" | "b" | null

  // 模式 A: 0度策略（来自 0:10 模拟下单）
  const simA = simOrders?.zeroOffset || {};
  const simARecords = simA.records || [];
  const simASummary = aggregateRows(simARecords);

  // 模式 B: 跟昨天偏移策略（来自 0:10 模拟下单）
  const simB = simOrders?.followYesterday || {};
  const simBRecords = simB.records || [];
  const simBSummary = aggregateRows(simBRecords);

  return (
    <div className="space-y-4">
      <section className="rounded-[1.8rem] border border-[var(--line)] bg-[linear-gradient(135deg,rgba(255,255,255,0.86),rgba(246,236,216,0.72))] p-4 shadow-[var(--shadow)]">
        <div className="flex flex-col gap-2">
          <p className="font-display text-xs uppercase tracking-[0.36em] text-[var(--ink-soft)]">Simulation</p>
          <h2 className="text-2xl font-semibold text-neutral-950">模拟策略收益对比</h2>
          <p className="text-sm text-[var(--ink-soft)]">每日 0:10 自动下单模拟，单笔 $1，观察哪个模式更优</p>
        </div>
      </section>

      {/* 两个模式并排 */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* 模式 A */}
        <section className="rounded-[1.6rem] border border-[var(--line)] bg-[var(--panel)] p-4 shadow-[var(--shadow)]">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-display text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">Strategy A</p>
              <h3 className="mt-1 text-xl font-semibold text-neutral-950">0 度策略</h3>
            </div>
            <button
              onClick={() => setExpandedSim(expandedSim === "a" ? null : "a")}
              className="rounded-full border border-[var(--line)] px-4 py-2 text-xs font-semibold text-neutral-800 transition hover:border-[var(--accent-strong)] hover:text-[var(--accent-strong)]"
            >
              {expandedSim === "a" ? "收起" : "展开明细"}
            </button>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <SimMetricCard label="收益" value={formatMoney(simASummary.netPnlUsd)} helper={`${simASummary.settledRecords} 已结算`} toneValue={simASummary.netPnlUsd} />
            <SimMetricCard label="ROI" value={formatPercent(simASummary.roi)} helper={`赢 ${simASummary.wins} / 输 ${simASummary.losses}`} toneValue={simASummary.roi} />
          </div>
          <p className="mt-3 text-xs text-[var(--ink-soft)]">买入预报温度对应的 NO 合约，{simARecords.length} 条记录</p>
        </section>

        {/* 模式 B */}
        <section className="rounded-[1.6rem] border border-[var(--line)] bg-[var(--panel)] p-4 shadow-[var(--shadow)]">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-display text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">Strategy B</p>
              <h3 className="mt-1 text-xl font-semibold text-neutral-950">跟昨天偏移</h3>
            </div>
            <button
              onClick={() => setExpandedSim(expandedSim === "b" ? null : "b")}
              className="rounded-full border border-[var(--line)] px-4 py-2 text-xs font-semibold text-neutral-800 transition hover:border-[var(--accent-strong)] hover:text-[var(--accent-strong)]"
            >
              {expandedSim === "b" ? "收起" : "展开明细"}
            </button>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <SimMetricCard label="收益" value={formatMoney(simBSummary.netPnlUsd)} helper={`${simBSummary.settledRecords} 已结算`} toneValue={simBSummary.netPnlUsd} />
            <SimMetricCard label="ROI" value={formatPercent(simBSummary.roi)} helper={`赢 ${simBSummary.wins} / 输 ${simBSummary.losses}`} toneValue={simBSummary.roi} />
          </div>
          <p className="mt-3 text-xs text-[var(--ink-soft)]">昨天偏移+2则今天买+2，{simBRecords.length} 条记录</p>
        </section>
      </div>

      {/* 展开的明细表 */}
      {expandedSim === "a" && (
        <SimulationTable title="0 度策略明细" rows={simARecords} isFollowYesterday={false} />
      )}
      {expandedSim === "b" && (
        <SimulationTable title="跟昨天偏移策略明细" rows={simBRecords} isFollowYesterday={true} />
      )}
    </div>
  );
}
