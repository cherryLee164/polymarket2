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

function formatShortDate(ymd) {
  const [, month, day] = String(ymd || "").split("-");
  if (!month || !day) {
    return ymd || "--";
  }
  return `${month}/${day}`;
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

function aggregateCityRows(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.citySlug}:${row.temperatureOffsetC}`;
    const current = map.get(key) || {
      citySlug: row.citySlug,
      cityZh: row.cityZh || row.cityEn || row.citySlug,
      temperatureOffsetC: row.temperatureOffsetC,
      rows: [],
    };
    current.rows.push(row);
    map.set(key, current);
  }
  return [...map.values()]
    .map((item) => ({
      ...item,
      summary: aggregateRows(item.rows),
    }))
    .sort((left, right) => {
      if (Number(right.summary.netPnlUsd) !== Number(left.summary.netPnlUsd)) {
        return Number(right.summary.netPnlUsd) - Number(left.summary.netPnlUsd);
      }
      return String(left.cityZh || "").localeCompare(String(right.cityZh || ""), "zh-CN");
    });
}

function MetricCard({ label, value, helper, toneValue }) {
  return (
    <article className="rounded-[1.25rem] border border-[var(--line)] bg-[rgba(255,255,255,0.72)] px-4 py-3">
      <p className="text-xs text-[var(--ink-soft)]">{label}</p>
      <div className={`mt-1 text-2xl font-semibold ${toneClass(toneValue ?? value)}`}>{value}</div>
      {helper ? <p className="mt-1 text-xs text-[var(--ink-soft)]">{helper}</p> : null}
    </article>
  );
}

function StrategyCards({ rows }) {
  return (
    <section className="grid gap-3 md:grid-cols-3">
      {rows.map((row) => {
        const summary = row.summary || {};
        return (
          <article
            key={row.key}
            className={`rounded-[1.45rem] border px-4 py-4 shadow-[var(--shadow)] ${
              row.selected
                ? "border-[var(--accent-strong)] bg-[rgba(214,122,67,0.14)]"
                : "border-[var(--line)] bg-[var(--panel)]"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">Offset</p>
                <h3 className="mt-2 text-2xl font-semibold text-neutral-950">{row.label}</h3>
              </div>
              <span className="rounded-full border border-[var(--line)] bg-white/70 px-3 py-1 text-xs font-semibold text-neutral-800">
                {row.selected ? "已选" : "观察"}
              </span>
            </div>
            <div className={`mt-4 text-3xl font-semibold ${toneClass(summary.netPnlUsd)}`}>
              {formatMoney(summary.netPnlUsd)}
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-[var(--ink-soft)]">
              <div>ROI {formatPercent(summary.roi)}</div>
              <div>赢 {summary.wins || 0}</div>
              <div>输 {summary.losses || 0}</div>
            </div>
            <p className="mt-3 text-xs text-[var(--ink-soft)]">
              {summary.settledRecords || 0} 已结算 / {summary.pending || 0} 待结算
            </p>
            <p className="mt-2 text-xs text-[var(--ink-soft)]">
              实盘序列 {row.liveConfig?.sequenceLabel || "--"}
            </p>
          </article>
        );
      })}
    </section>
  );
}

function CityRanking({ rows }) {
  return (
    <section className="rounded-[1.6rem] border border-[var(--line)] bg-[var(--panel)] p-4 shadow-[var(--shadow)]">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="font-display text-xs uppercase tracking-[0.34em] text-[var(--ink-soft)]">City Offset ROI</p>
          <h3 className="mt-2 text-xl font-semibold text-neutral-950">城市策略排名</h3>
        </div>
        <p className="text-xs text-[var(--ink-soft)]">按城市和温度偏移独立统计</p>
      </div>
      <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {rows.length ? (
          rows.slice(0, 18).map((row) => (
            <article key={`${row.citySlug}:${row.temperatureOffsetC}`} className="rounded-[1.15rem] border border-[var(--line)] bg-white/70 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold text-neutral-950">
                    {row.cityZh} {offsetLabel(row.temperatureOffsetC)}
                  </div>
                  <div className="mt-1 text-xs text-[var(--ink-soft)]">
                    {row.summary.records} 单 / {row.summary.settledRecords} 已结算
                  </div>
                </div>
                <div className={`text-lg font-semibold ${toneClass(row.summary.netPnlUsd)}`}>
                  {formatMoney(row.summary.netPnlUsd)}
                </div>
              </div>
              <div className="mt-2 text-xs text-[var(--ink-soft)]">
                ROI {formatPercent(row.summary.roi)} / 赢 {row.summary.wins} / 输 {row.summary.losses}
              </div>
            </article>
          ))
        ) : (
          <div className="rounded-[1.15rem] border border-dashed border-[var(--line)] bg-white/50 px-4 py-6 text-sm text-[var(--ink-soft)] md:col-span-2 xl:col-span-3">
            暂无可统计的 offset 模拟记录。
          </div>
        )}
      </div>
    </section>
  );
}

function SimulationTable({ rows }) {
  return (
    <section className="overflow-hidden rounded-[1.6rem] border border-[var(--line)] bg-[var(--panel)] shadow-[var(--shadow)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
        <h3 className="font-display text-xl font-semibold tracking-[0.04em] text-neutral-950">策略明细</h3>
        <p className="text-xs text-[var(--ink-soft)]">{rows.length} 条</p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-[rgba(246,236,216,0.55)] text-xs text-[var(--ink-soft)]">
            <tr>
              <th className="px-4 py-3 font-medium">日期</th>
              <th className="px-4 py-3 font-medium">城市</th>
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
                    <div className="font-semibold text-neutral-950">{row.cityZh || row.cityEn}</div>
                    <div className="mt-1 text-xs text-[var(--ink-soft)]">{row.forecastTarget}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-semibold text-neutral-950">{offsetLabel(row.temperatureOffsetC)}</div>
                    <div className="mt-1 text-xs text-[var(--ink-soft)]">
                      预报 {row.forecastMaxTempC ?? "--"}C / 目标 {row.targetTempC ?? "--"}C
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-semibold text-neutral-950">{row.marketTitle || "--"}</div>
                    <div className="mt-1 max-w-[320px] truncate text-xs text-[var(--ink-soft)]">{row.marketQuestion}</div>
                  </td>
                  <td className="px-4 py-3 font-semibold text-neutral-950">{formatPrice(row.buyNoPrice)}</td>
                  <td className="px-4 py-3">{row.actualMaxTempC ?? "--"}C</td>
                  <td className={`px-4 py-3 font-semibold ${toneClass(row.accountingPnlUsd)}`}>
                    {row.status === "resolved" ? formatMoney(row.accountingPnlUsd) : "--"}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="px-4 py-8 text-center text-sm text-[var(--ink-soft)]" colSpan={7}>
                  还没有 offset 候选记录。下一次天气抓取后会开始统计 -1 / 0 / +1。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export async function WeatherSimulationPanel() {
  const snapshot = await getWeatherDashboardSnapshot({ sync: false });
  const simulation = snapshot.offsetSimulation || snapshot.thresholdSim || {};
  const selectedOffsets = new Set(simulation.selectedOffsets || [0]);
  const selectedRows = (simulation.records || []).filter((row) => selectedOffsets.has(Number(row.temperatureOffsetC)));
  const selectedSummary = aggregateRows(selectedRows);
  const todayRows = selectedRows.filter((row) => row.date === snapshot.localDate);
  const cityRows = aggregateCityRows(simulation.records || []);

  return (
    <div className="space-y-4">
      <section className="rounded-[1.8rem] border border-[var(--line)] bg-[linear-gradient(135deg,rgba(255,255,255,0.86),rgba(255,246,224,0.72))] p-4 shadow-[var(--shadow)]">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="font-display text-xs uppercase tracking-[0.36em] text-[var(--ink-soft)]">Weather Offset Simulation</p>
            <h2 className="mt-2 text-2xl font-semibold text-neutral-950">天气 -1 / 0 / +1 策略收益</h2>
            <p className="mt-1 text-sm text-[var(--ink-soft)]">
              每个温度偏移独立统计，实战递进也按城市和 offset 分开计算。
            </p>
          </div>
          <div className="text-xs text-[var(--ink-soft)]">
            当前模式 {simulation.executionMode === "simulation" ? "模拟" : "实战"} / 单笔 {formatMoney(simulation.stakeUsd || 1)}
          </div>
        </div>
      </section>

      <StrategyCards rows={simulation.strategyRows || []} />

      <section className="grid gap-3 md:grid-cols-4">
        <MetricCard label="已选组合收益" value={formatMoney(selectedSummary.netPnlUsd)} helper={`${selectedSummary.settledRecords} 已结算`} toneValue={selectedSummary.netPnlUsd} />
        <MetricCard label="已选组合 ROI" value={formatPercent(selectedSummary.roi)} helper={`${selectedSummary.records} 单累计`} toneValue={selectedSummary.roi} />
        <MetricCard label="今日已选候选" value={`${todayRows.length}`} helper={snapshot.localDate} toneValue={0} />
        <MetricCard label="全部 offset 收益" value={formatMoney(simulation.summary?.overall?.netPnlUsd)} helper={`${simulation.summary?.overall?.records || 0} 单累计`} toneValue={simulation.summary?.overall?.netPnlUsd} />
      </section>

      <CityRanking rows={cityRows} />
      <SimulationTable rows={simulation.records || []} />
    </div>
  );
}
