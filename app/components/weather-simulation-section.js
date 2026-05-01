import Link from "next/link";

import { getWeatherDashboardSnapshot } from "@/lib/weather-trading-data";

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
  return Number.isFinite(numeric) ? `${(numeric * 100).toFixed(1)}c` : "--";
}

function formatDate(ymd) {
  const [year, month, day] = String(ymd || "").split("-");
  if (!year || !month || !day) {
    return ymd || "--";
  }
  return `${year}/${month}/${day}`;
}

function formatShortDate(ymd) {
  const [, month, day] = String(ymd || "").split("-");
  if (!month || !day) {
    return ymd || "--";
  }
  return `${month}/${day}`;
}

function thresholdKey(value) {
  const numeric = Number(value);
  return String(Math.round((Number.isFinite(numeric) ? numeric : 0.9) * 10000)).padStart(4, "0");
}

function thresholdLabel(value) {
  const numeric = Number(value);
  return `${Math.round((Number.isFinite(numeric) ? numeric : 0.9) * 100)}+`;
}

function toneClass(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) {
    return "text-neutral-950";
  }
  return numeric > 0 ? "text-[var(--signal-up)]" : "text-[var(--signal-down)]";
}

function buildHomeHref(currentQuery, patch) {
  const params = new URLSearchParams();
  const merged = { ...currentQuery, ...patch };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    params.set(key, String(value));
  }
  const queryString = params.toString();
  return queryString ? `/?${queryString}` : "/";
}

function buildPlannedStrategyRows(simulation) {
  const existing = simulation?.strategyRows || [];
  if (existing.length) {
    return existing;
  }
  const thresholds = simulation?.thresholds?.length ? simulation.thresholds : [0.85, 0.88, 0.9, 0.92, 0.95, 0.97];
  const slots = simulation?.captureSlots || [];
  return slots.flatMap((slot) =>
    thresholds.map((threshold) => ({
      key: `${slot.id}:${thresholdKey(threshold)}`,
      slotId: slot.id,
      slotLabel: slot.label,
      slotHour: slot.hour,
      slotMinute: slot.minute || 0,
      thresholdNoPrice: threshold,
      thresholdLabel: thresholdLabel(threshold),
      label: `${slot.label} No ${thresholdLabel(threshold)}`,
      summary: {
        records: 0,
        settledRecords: 0,
        pending: 0,
        wins: 0,
        losses: 0,
        totalStakeUsd: 0,
        netPnlUsd: 0,
        roi: null,
      },
    })),
  );
}

function strategyKeyForRecord(row) {
  return `${row.captureSlotId}:${thresholdKey(row.thresholdNoPrice)}`;
}

function aggregateCityRows(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = row.citySlug || row.cityZh || "city";
    const current = map.get(key) || {
      citySlug: row.citySlug,
      cityZh: row.cityZh || row.cityEn || row.citySlug,
      records: 0,
      settledRecords: 0,
      pending: 0,
      wins: 0,
      losses: 0,
      totalStakeUsd: 0,
      netPnlUsd: 0,
    };
    current.records += 1;
    if (row.status === "resolved" && Number.isFinite(Number(row.accountingPnlUsd))) {
      current.settledRecords += 1;
      current.totalStakeUsd += Number(row.stakeUsd || 0);
      current.netPnlUsd += Number(row.accountingPnlUsd || 0);
      if (Number(row.accountingPnlUsd) > 0) {
        current.wins += 1;
      } else if (Number(row.accountingPnlUsd) < 0) {
        current.losses += 1;
      }
    } else {
      current.pending += 1;
    }
    map.set(key, current);
  }
  return [...map.values()]
    .map((row) => ({
      ...row,
      totalStakeUsd: Number(row.totalStakeUsd.toFixed(6)),
      netPnlUsd: Number(row.netPnlUsd.toFixed(6)),
      roi: row.totalStakeUsd > 0 ? Number((row.netPnlUsd / row.totalStakeUsd).toFixed(6)) : null,
    }))
    .sort((left, right) => {
      if (Number(right.netPnlUsd) !== Number(left.netPnlUsd)) {
        return Number(right.netPnlUsd) - Number(left.netPnlUsd);
      }
      return String(left.cityZh || "").localeCompare(String(right.cityZh || ""), "zh-CN");
    });
}

function CompactMetric({ label, value, helper, toneValue }) {
  return (
    <article className="rounded-[1.25rem] border border-[var(--line)] bg-[rgba(255,255,255,0.72)] px-4 py-3">
      <p className="text-xs text-[var(--ink-soft)]">{label}</p>
      <div className={`mt-1 text-2xl font-semibold ${toneClass(toneValue ?? value)}`}>{value}</div>
      {helper ? <p className="mt-1 text-xs text-[var(--ink-soft)]">{helper}</p> : null}
    </article>
  );
}

function StrategyTabs({ rows, activeKey, currentQuery }) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {rows.map((row) => {
        const active = row.key === activeKey;
        return (
          <Link
            key={row.key}
            href={buildHomeHref(currentQuery, {
              surface: "weather",
              weatherTab: "simulation",
              weatherSimTab: row.key,
            })}
            className={`min-w-[150px] rounded-[1.2rem] border px-4 py-3 text-left transition ${
              active
                ? "border-[var(--accent-strong)] bg-[rgba(214,122,67,0.18)]"
                : "border-[var(--line)] bg-white/60 hover:border-[var(--accent-strong)]"
            }`}
          >
            <div className="text-base font-semibold text-neutral-950">{row.label}</div>
            <div className="mt-1 text-xs text-[var(--ink-soft)]">
              {row.summary.records || 0} 单 / ROI {formatPercent(row.summary.roi)}
            </div>
          </Link>
        );
      })}
    </div>
  );
}

function SimulationTable({ rows }) {
  return (
    <section className="overflow-hidden rounded-[1.6rem] border border-[var(--line)] bg-[var(--panel)] shadow-[var(--shadow)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
        <h3 className="font-display text-xl font-semibold tracking-[0.04em] text-neutral-950">模拟明细</h3>
        <p className="text-xs text-[var(--ink-soft)]">{rows.length} 条</p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-[rgba(246,236,216,0.55)] text-xs text-[var(--ink-soft)]">
            <tr>
              <th className="px-4 py-3 font-medium">日期</th>
              <th className="px-4 py-3 font-medium">城市</th>
              <th className="px-4 py-3 font-medium">市场</th>
              <th className="px-4 py-3 font-medium">No 价格</th>
              <th className="px-4 py-3 font-medium">投入</th>
              <th className="px-4 py-3 font-medium">状态</th>
              <th className="px-4 py-3 font-medium">收益</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.slice(0, 80).map((row) => (
                <tr key={row.key} className="border-t border-[var(--line)] align-top">
                  <td className="px-4 py-3">{formatShortDate(row.date)}</td>
                  <td className="px-4 py-3">
                    <div className="font-semibold text-neutral-950">{row.cityZh || row.cityEn}</div>
                    <div className="mt-1 text-xs text-[var(--ink-soft)]">{row.forecastTarget}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-semibold text-neutral-950">{row.marketTitle || "--"}</div>
                    <div className="mt-1 max-w-[320px] truncate text-xs text-[var(--ink-soft)]">{row.marketQuestion}</div>
                  </td>
                  <td className="px-4 py-3 font-semibold text-neutral-950">{formatPrice(row.buyNoPrice)}</td>
                  <td className="px-4 py-3">{formatMoney(row.stakeUsd)}</td>
                  <td className="px-4 py-3">{row.status === "resolved" ? row.resolvedOutcome || "resolved" : "待结算"}</td>
                  <td className={`px-4 py-3 font-semibold ${toneClass(row.accountingPnlUsd)}`}>
                    {row.status === "resolved" ? formatMoney(row.accountingPnlUsd) : "--"}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="px-4 py-8 text-center text-sm text-[var(--ink-soft)]" colSpan={7}>
                  还没有采样数据。当前配置会从下一个 10:00 / 11:00 / 12:00 / 13:00 窗口开始记录 No 85/88/90/92/95/97 模拟单。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CityRanking({ rows }) {
  return (
    <section className="rounded-[1.6rem] border border-[var(--line)] bg-[var(--panel)] p-4 shadow-[var(--shadow)]">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="font-display text-xs uppercase tracking-[0.34em] text-[var(--ink-soft)]">City ROI</p>
          <h3 className="mt-2 text-xl font-semibold text-neutral-950">城市模拟排行</h3>
        </div>
        <p className="text-xs text-[var(--ink-soft)]">按当前切换策略统计</p>
      </div>
      <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {rows.length ? (
          rows.map((row) => (
            <article key={row.citySlug || row.cityZh} className="rounded-[1.15rem] border border-[var(--line)] bg-white/70 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold text-neutral-950">{row.cityZh}</div>
                  <div className="mt-1 text-xs text-[var(--ink-soft)]">
                    {row.records} 单 / {row.settledRecords} 已结算
                  </div>
                </div>
                <div className={`text-lg font-semibold ${toneClass(row.netPnlUsd)}`}>{formatMoney(row.netPnlUsd)}</div>
              </div>
              <div className="mt-2 text-xs text-[var(--ink-soft)]">
                胜 {row.wins} / 负 {row.losses} / ROI {formatPercent(row.roi)}
              </div>
            </article>
          ))
        ) : (
          <div className="rounded-[1.15rem] border border-dashed border-[var(--line)] bg-white/50 px-4 py-6 text-sm text-[var(--ink-soft)] md:col-span-2 xl:col-span-3">
            暂无城市排行，等第一个采样窗口产生模拟单后显示。
          </div>
        )}
      </div>
    </section>
  );
}

export async function WeatherSimulationPanel({ currentQuery = {} }) {
  const snapshot = await getWeatherDashboardSnapshot({ sync: false });
  const simulation = snapshot.thresholdSim || {};
  const strategyRows = buildPlannedStrategyRows(simulation);
  const activeKey =
    strategyRows.find((row) => row.key === currentQuery.weatherSimTab)?.key ||
    strategyRows[0]?.key ||
    "";
  const activeStrategy = strategyRows.find((row) => row.key === activeKey) || strategyRows[0] || {};
  const selectedRows = (simulation.records || []).filter((row) => strategyKeyForRecord(row) === activeKey);
  const todayRows = selectedRows.filter((row) => row.date === snapshot.localDate);
  const cityRows = aggregateCityRows(selectedRows);
  const overall = activeStrategy.summary || {};
  const allOverall = simulation.summary?.overall || {};

  return (
    <div className="space-y-4">
      <section className="rounded-[1.8rem] border border-[var(--line)] bg-[linear-gradient(135deg,rgba(255,255,255,0.86),rgba(255,246,224,0.72))] p-4 shadow-[var(--shadow)]">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="font-display text-xs uppercase tracking-[0.36em] text-[var(--ink-soft)]">Weather Simulation</p>
            <h2 className="mt-2 text-2xl font-semibold text-neutral-950">天气多阈值模拟观察</h2>
            <p className="mt-1 text-sm text-[var(--ink-soft)]">
              从今天开始记录，实际会从下一个未经过的时间窗口生效；赢按预收益，输按投注金额。
            </p>
          </div>
          <div className="text-xs text-[var(--ink-soft)]">
            当前日期 {formatDate(snapshot.localDate)} / 单笔模拟 {formatMoney(simulation.stakeUsd || 1)}
          </div>
        </div>

        <div className="mt-4">
          <StrategyTabs rows={strategyRows} activeKey={activeKey} currentQuery={currentQuery} />
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-4">
        <CompactMetric label="当前策略收益" value={formatMoney(overall.netPnlUsd)} helper={activeStrategy.label} toneValue={overall.netPnlUsd} />
        <CompactMetric label="当前策略 ROI" value={formatPercent(overall.roi)} helper={`${overall.settledRecords || 0} 已结算`} toneValue={overall.roi} />
        <CompactMetric label="今日模拟单" value={`${todayRows.length}`} helper={`${formatDate(snapshot.localDate)} 待观察`} toneValue={0} />
        <CompactMetric label="全部模拟收益" value={formatMoney(allOverall.netPnlUsd)} helper={`${allOverall.totalRecords || 0} 单累计`} toneValue={allOverall.netPnlUsd} />
      </section>

      <CityRanking rows={cityRows} />
      <SimulationTable rows={selectedRows} />
    </div>
  );
}
