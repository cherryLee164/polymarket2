import Link from "next/link";

import { getWeatherRotationSimulationSnapshot } from "@/lib/weather-rotation-sim-data";

export const dynamic = "force-dynamic";
export const revalidate = 0;

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

function formatTemp(value, unit) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "--";
  }
  return `${numeric.toFixed(0)}°${String(unit || "c").toUpperCase()}`;
}

function formatDate(ymd) {
  const [year, month, day] = String(ymd || "").split("-");
  if (!year || !month || !day) {
    return ymd || "--";
  }
  return `${year}/${month}/${day}`;
}

function toneClass(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) {
    return "text-neutral-950";
  }
  return numeric > 0 ? "text-[var(--signal-up)]" : "text-[var(--signal-down)]";
}

function statusLabel(row) {
  if (row.status === "resolved") {
    return row.resolvedOutcome === "no" ? "No 赢" : "No 输";
  }
  if (row.status === "skipped") {
    return "跳过";
  }
  if (row.status === "error") {
    return "错误";
  }
  return "待结算";
}

function MetricCard({ label, value, helper, toneValue }) {
  return (
    <article className="rounded-[1.5rem] border border-[var(--line)] bg-[rgba(255,255,255,0.74)] p-4 shadow-[0_18px_48px_rgba(33,24,10,0.08)]">
      <p className="text-xs tracking-[0.16em] text-[var(--ink-soft)]">{label}</p>
      <div className={`mt-2 text-3xl font-semibold ${toneClass(toneValue ?? value)}`}>{value}</div>
      {helper ? <p className="mt-2 text-sm text-[var(--ink-soft)]">{helper}</p> : null}
    </article>
  );
}

function LegCard({ title, summary, helper }) {
  return (
    <article className="rounded-[1.6rem] border border-[var(--line)] bg-[rgba(255,250,239,0.76)] p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-display text-xs uppercase tracking-[0.36em] text-[var(--ink-soft)]">Leg</p>
          <h3 className="mt-2 text-2xl font-semibold text-neutral-950">{title}</h3>
          <p className="mt-1 text-sm text-[var(--ink-soft)]">{helper}</p>
        </div>
        <div className={`text-2xl font-semibold ${toneClass(summary?.pnlUsd)}`}>
          {formatMoney(summary?.pnlUsd)}
        </div>
      </div>
      <div className="mt-5 grid gap-2 text-sm text-[var(--ink-soft)] sm:grid-cols-4">
        <div>记录 {summary?.records || 0}</div>
        <div>结算 {summary?.settled || 0}</div>
        <div>胜 {summary?.wins || 0} / 负 {summary?.losses || 0}</div>
        <div>ROI {formatPercent(summary?.roi)}</div>
      </div>
    </article>
  );
}

function CycleTable({ cycles }) {
  return (
    <section className="overflow-hidden rounded-[1.8rem] border border-[var(--line)] bg-[var(--panel)] shadow-[var(--shadow)]">
      <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4">
        <h2 className="font-display text-2xl font-semibold tracking-[0.05em]">轮动日汇总</h2>
        <p className="text-sm text-[var(--ink-soft)]">海外 18:00 + 次日国内 06:00</p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-[rgba(246,236,216,0.58)] text-[var(--ink-soft)]">
            <tr>
              <th className="px-5 py-3 font-medium">轮动日</th>
              <th className="px-5 py-3 font-medium">总收益</th>
              <th className="px-5 py-3 font-medium">海外</th>
              <th className="px-5 py-3 font-medium">国内</th>
              <th className="px-5 py-3 font-medium">记录</th>
              <th className="px-5 py-3 font-medium">ROI</th>
            </tr>
          </thead>
          <tbody>
            {cycles.length ? (
              cycles.map((cycle) => (
                <tr key={cycle.cycleDate} className="border-t border-[var(--line)]">
                  <td className="px-5 py-4 font-semibold">{formatDate(cycle.cycleDate)}</td>
                  <td className={`px-5 py-4 font-semibold ${toneClass(cycle.summary.pnlUsd)}`}>
                    {formatMoney(cycle.summary.pnlUsd)}
                  </td>
                  <td className={toneClass(cycle.overseas.pnlUsd)}>{formatMoney(cycle.overseas.pnlUsd)}</td>
                  <td className={toneClass(cycle.domestic.pnlUsd)}>{formatMoney(cycle.domestic.pnlUsd)}</td>
                  <td className="px-5 py-4">{cycle.summary.records}</td>
                  <td className="px-5 py-4">{formatPercent(cycle.summary.roi)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="px-5 py-8 text-center text-[var(--ink-soft)]" colSpan={6}>
                  还没有轮动模拟记录。到 18:00 北京时间会开始记录海外模拟单。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RecordTable({ records }) {
  return (
    <section className="overflow-hidden rounded-[1.8rem] border border-[var(--line)] bg-[var(--panel)] shadow-[var(--shadow)]">
      <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4">
        <h2 className="font-display text-2xl font-semibold tracking-[0.05em]">模拟明细</h2>
        <p className="text-sm text-[var(--ink-soft)]">固定每城 $1，只买预测高温档的 No</p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-[rgba(246,236,216,0.58)] text-[var(--ink-soft)]">
            <tr>
              <th className="px-5 py-3 font-medium">日期</th>
              <th className="px-5 py-3 font-medium">腿</th>
              <th className="px-5 py-3 font-medium">城市</th>
              <th className="px-5 py-3 font-medium">预报高温</th>
              <th className="px-5 py-3 font-medium">No 价格</th>
              <th className="px-5 py-3 font-medium">预收益</th>
              <th className="px-5 py-3 font-medium">状态</th>
              <th className="px-5 py-3 font-medium">收益</th>
            </tr>
          </thead>
          <tbody>
            {records.length ? (
              records.slice(0, 160).map((row) => (
                <tr key={row.key} className="border-t border-[var(--line)] align-top">
                  <td className="px-5 py-4">{formatDate(row.date)}</td>
                  <td className="px-5 py-4">{row.legLabel}</td>
                  <td className="px-5 py-4">
                    <div className="font-semibold text-neutral-950">{row.cityZh || row.cityEn}</div>
                    <div className="mt-1 text-xs text-[var(--ink-soft)]">{row.station}</div>
                  </td>
                  <td className="px-5 py-4 font-semibold">{formatTemp(row.forecastMax, row.unit)}</td>
                  <td className="px-5 py-4">{formatPrice(row.buyNoPrice)}</td>
                  <td className={`px-5 py-4 font-semibold ${toneClass(row.estimatedNoWinPnlUsd)}`}>
                    {formatMoney(row.estimatedNoWinPnlUsd)}
                  </td>
                  <td className="px-5 py-4">
                    <div className="font-semibold">{statusLabel(row)}</div>
                    {row.skipReason ? <div className="mt-1 text-xs text-[var(--ink-soft)]">{row.skipReason}</div> : null}
                    {row.error ? <div className="mt-1 max-w-[280px] truncate text-xs text-[var(--signal-down)]">{row.error}</div> : null}
                  </td>
                  <td className={`px-5 py-4 font-semibold ${toneClass(row.accountingPnlUsd)}`}>
                    {row.status === "resolved" ? formatMoney(row.accountingPnlUsd) : "--"}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="px-5 py-8 text-center text-[var(--ink-soft)]" colSpan={8}>
                  暂无模拟明细。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default async function WeatherRotationPage() {
  const snapshot = await getWeatherRotationSimulationSnapshot({ sync: true });
  const overall = snapshot.summary.overall;

  return (
    <main className="notranslate min-h-screen bg-transparent text-neutral-950" translate="no">
      <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 px-5 py-8 lg:px-8">
        <header className="overflow-hidden rounded-[2.3rem] border border-[var(--line)] bg-[linear-gradient(135deg,rgba(255,255,255,0.94),rgba(255,246,224,0.88))] shadow-[var(--shadow)]">
          <div className="grid gap-6 p-6 lg:grid-cols-[1fr_auto] lg:p-7">
            <div>
              <p className="font-display text-sm uppercase tracking-[0.55em] text-[var(--ink-soft)]">
                Weather Rotation Lab
              </p>
              <h1 className="font-display mt-4 text-4xl font-semibold tracking-[0.04em] md:text-5xl">
                国内海外轮动模拟
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-[var(--ink-soft)]">
                独立模拟模块：18:00 北京时间记录海外城市，次日 06:00 记录国内城市。固定每城 $1，不改现有天气实盘。
              </p>
            </div>
            <div className="flex flex-col items-start gap-3 lg:items-end">
              <Link href="/?surface=weather&weatherTab=simulation" className="rounded-full border border-[var(--line)] px-5 py-3 text-sm font-semibold transition hover:border-[var(--accent-strong)]">
                返回天气后台
              </Link>
              <div className="rounded-full bg-[var(--accent-soft)] px-4 py-2 text-sm text-[var(--accent-strong)]">
                当前窗口：{snapshot.activeLeg?.label || "未到采集窗口"}
              </div>
            </div>
          </div>
        </header>

        <section className="grid gap-3 md:grid-cols-4">
          <MetricCard label="累计收益" value={formatMoney(overall.pnlUsd)} helper={`${overall.settled} 已结算 / ${overall.records} 记录`} toneValue={overall.pnlUsd} />
          <MetricCard label="累计 ROI" value={formatPercent(overall.roi)} helper={`固定每城 ${formatMoney(snapshot.stakeUsd)}`} toneValue={overall.roi} />
          <MetricCard label="待结算" value={`${overall.pending}`} helper={`跳过 ${overall.skipped} / 错误 ${overall.errors}`} />
          <MetricCard label="No 价格上限" value={formatPrice(snapshot.maxNoPrice)} helper="超过上限不模拟下单" />
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <LegCard title="海外 18:00" helper={`${snapshot.cities.overseas.length} 个候选城市，美东/美中/南美东部`} summary={snapshot.summary.byLeg.overseas} />
          <LegCard title="国内 06:00" helper={`${snapshot.cities.domestic.length} 个国内城市，独立于现有实盘`} summary={snapshot.summary.byLeg.domestic} />
        </section>

        <CycleTable cycles={snapshot.summary.byCycle} />
        <RecordTable records={snapshot.records} />
      </div>
    </main>
  );
}
