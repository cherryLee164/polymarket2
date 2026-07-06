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

function formatPrice(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  const cents = numeric * 100;
  return `${cents.toFixed(1)}¢`;
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

function formatActualTemp(label, value, unit) {
  if (label) return label;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  const suffix = unit === "fahrenheit" ? "°F" : "°C";
  return `${Math.round(numeric)}${suffix}`;
}

function renderPnlClass(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) {
    return "text-neutral-900";
  }
  return numeric > 0 ? "text-[var(--signal-up)]" : "text-[var(--signal-down)]";
}

function deltaToneClass(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) {
    return "text-neutral-900";
  }
  return numeric > 0 ? "text-[var(--signal-down)]" : "text-[var(--signal-up)]";
}

function formatWeatherPhrase(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }
  if (/[A-Za-z]{3,}/.test(text)) return null; // 英文跳过
  // 截取第一个逗号或句号前的核心天气描述（如"大致多云"）
  const shortText = text.split(/[，。,.]/)[0];
  return shortText;
}

function formatWeatherPair(row) {
  const parts = [formatWeatherPhrase(row?.dayWeather), formatWeatherPhrase(row?.nightWeather)].filter(Boolean);
  return parts.length ? parts.join(" / ") : "--";
}

function computeDayPnl(rows) {
  const settled = rows.filter((r) => r.status === "resolved" && Number.isFinite(Number(r.impliedPnlUsd)));
  const netPnlUsd = settled.reduce((sum, r) => sum + Number(r.impliedPnlUsd || 0), 0);
  return { netPnlUsd, settledRecords: settled.length };
}

function PagePnlStrip({ pageDates }) {
  const daySummaries = pageDates.map(({ date, rows }) => ({
    date,
    ...computeDayPnl(rows),
  }));
  const pageTotal = daySummaries.reduce((sum, d) => sum + d.netPnlUsd, 0);
  const startDate = pageDates[0]?.date;
  const endDate = pageDates[pageDates.length - 1]?.date;

  return (
    <div className="border-b border-[var(--line)] px-5 py-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="font-display text-xs uppercase tracking-[0.38em] text-[var(--ink-soft)]">Daily PnL</p>
          <h3 className="mt-1 text-lg font-semibold text-neutral-950">
            {startDate && endDate ? `${formatDate(startDate)} - ${formatDate(endDate)}` : "逐日收益"}
          </h3>
        </div>
        <div className={`text-lg font-semibold ${renderPnlClass(pageTotal)}`}>
          本页合计 {formatMoney(pageTotal)}
        </div>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-7">
        {daySummaries.map((d) => (
          <article
            key={d.date}
            className="rounded-[1.05rem] border border-[var(--line)] bg-[rgba(255,255,255,0.7)] px-3 py-3"
          >
            <p className="text-sm text-[var(--ink-soft)]">{formatShortDate(d.date)}</p>
            <div className={`mt-1 text-xl font-semibold ${renderPnlClass(d.netPnlUsd)}`}>
              {formatMoney(d.netPnlUsd)}
            </div>
            <p className="mt-2 text-sm text-[var(--ink-soft)]">
              {d.settledRecords || 0} 笔
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}

// 月度总收益汇总条：基于当前页最后一天所属月份，从 allDateRows 聚合该月所有已结算记录的净收益
function MonthlyTotalBar({ allDateRows, endDate }) {
  const endYm = String(endDate || "").slice(0, 7); // "YYYY-MM"
  const monthTotal = computeMonthTotal(allDateRows, endYm);
  if (!monthTotal || monthTotal.settledRecords === 0) return null;
  const [y, m] = endYm.split("-");
  const monthLabel = `${Number(m)}月`;
  return (
    <div className="border-t-2 border-[var(--accent-strong)] bg-[rgba(255,246,224,0.7)] px-5 py-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="font-display text-xs uppercase tracking-[0.38em] text-[var(--ink-soft)]">Monthly PnL</p>
          <h3 className="mt-1 text-lg font-semibold text-neutral-950">
            {y}年{monthLabel}总收益
          </h3>
        </div>
        <div className="flex items-baseline gap-4">
          <span className="text-sm text-[var(--ink-soft)]">{monthTotal.settledRecords} 笔已结算</span>
          <span className={`text-2xl font-semibold ${renderPnlClass(monthTotal.netPnlUsd)}`}>
            {formatMoney(monthTotal.netPnlUsd)}
          </span>
        </div>
      </div>
    </div>
  );
}

function WeatherDayTable({ date, rows }) {
  return (
    <div>
      <div className="sticky top-0 z-10 border-b border-[var(--line)] bg-[rgba(246,236,216,0.85)] px-5 py-2 backdrop-blur">
        <span className="font-display text-lg font-semibold text-neutral-950">{formatDate(date)}</span>
        <span className="ml-3 text-sm text-[var(--ink-soft)]">{rows.length} 城</span>
      </div>
      <table className="min-w-full table-fixed text-left">
        <colgroup>
          <col className="w-[180px]" />
          <col className="w-[110px]" />
          <col className="w-[100px]" />
          <col className="w-[90px]" />
          <col className="w-[110px]" />
          <col className="w-[80px]" />
          <col className="w-[100px]" />
          <col className="w-[100px]" />
        </colgroup>
        <thead className="bg-[rgba(246,236,216,0.55)] text-sm text-[var(--ink-soft)]">
          <tr>
            <th className="px-3 py-3 font-medium">城市</th>
            <th className="px-3 py-3 font-medium">天气预报</th>
            <th className="px-3 py-3 font-medium">下单温度</th>
            <th className="px-3 py-3 font-medium">买 No</th>
            <th className="px-3 py-3 font-medium">实际温度</th>
            <th className="px-3 py-3 font-medium">温差</th>
            <th className="px-3 py-3 font-medium">预收益</th>
            <th className="px-3 py-3 font-medium">收益</th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row) => (
              <tr key={row.key} className="border-t border-[var(--line)] align-top">
                <td className="px-3 py-4">
                  <div className="font-semibold text-neutral-950 truncate">{row.cityZh}</div>
                  <div className="mt-0.5 text-xs text-[var(--ink-soft)] truncate">{row.forecastTarget}</div>
                  <div className="text-xs text-[var(--ink-soft)] leading-snug">{formatWeatherPair(row)}</div>
                  <div className="mt-0.5 text-xs text-[var(--accent-strong)]">下单 {row.orderTimeBeijing || "00:10"} 北京时间</div>
                </td>
                <td className="px-3 py-4">
                  <div className="text-base font-semibold text-neutral-950 whitespace-nowrap">
                    {row.forecastMinTempC}~{row.forecastMaxTempC}{row.unit === "fahrenheit" ? "°F" : "°C"}
                  </div>
                </td>
                <td className="px-3 py-4 text-base font-semibold text-neutral-950 whitespace-nowrap">
                  {row.targetTempC != null && Number.isFinite(Number(row.targetTempC)) ? `${row.targetTempC}${row.unit === "fahrenheit" ? "°F" : "°C"}` : "--"}
                </td>
                <td className="px-3 py-4">
                  <div className="text-base font-semibold text-neutral-950">{formatPrice(row.buyNoPrice)}</div>
                </td>
                <td className="px-3 py-4">
                  <div className="text-base font-semibold text-neutral-950 whitespace-nowrap">
                    {formatActualTemp(row?.actualTempLabel, row?.actualMaxTempC, row?.unit)}
                  </div>
                  <div className="mt-0.5 text-xs text-[var(--ink-soft)]">
                    {row.status === "resolved" ? "已结算" : "待结算"}
                  </div>
                </td>
                <td className={`px-3 py-4 text-base font-semibold ${deltaToneClass(row.temperatureDeltaC)}`}>
                  {formatDelta(row.temperatureDeltaC, row?.unit)}
                </td>
                <td className="px-3 py-4 text-base font-semibold text-emerald-700 whitespace-nowrap">
                  {row.expectedPnlUsd != null && Number.isFinite(Number(row.expectedPnlUsd)) ? formatMoney(row.expectedPnlUsd) : "--"}
                </td>
                <td className={`px-3 py-4 text-base font-semibold whitespace-nowrap ${renderPnlClass(row.impliedPnlUsd)}`}>
                  {row.status === "resolved" ? formatMoney(row.impliedPnlUsd) : "--"}
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td className="px-5 py-6 text-center text-sm text-[var(--ink-soft)]" colSpan={8}>
                暂无该日天气记录
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// 区域子 Tab 配置：与城市温差页保持一致
const REGION_TABS = [
  { value: "domestic", label: "国内" },
  { value: "asia-foreign", label: "亚洲" },
  { value: "europe", label: "欧洲" },
  { value: "north-america", label: "北美" },
  { value: "south-america", label: "南美" },
  { value: "africa", label: "非洲" },
  { value: "oceania", label: "大洋洲" },
];

function RegionTabBar({ allDateRows, activeRegion, setActiveRegion }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] px-5 py-3">
      {REGION_TABS.map((tab) => {
        // 统计该区域有多少个不同城市（去重），仅计入有下单数据的
        const citySlugs = new Set();
        for (const day of allDateRows) {
          for (const r of day.rows) {
            if ((r.region || "domestic") === tab.value && r.marketSlug) {
              citySlugs.add(r.citySlug);
            }
          }
        }
        const cityCount = citySlugs.size;
        const hasData = cityCount > 0;
        const isActive = tab.value === activeRegion;
        const tabClass = !hasData
          ? "cursor-not-allowed border-[var(--line)] bg-white/40 text-[var(--ink-soft)] opacity-60"
          : isActive
            ? "border-[var(--accent-strong)] bg-[var(--accent-strong)] text-white"
            : "border-[var(--line)] bg-white text-neutral-800 hover:border-[var(--accent-strong)] hover:text-[var(--accent-strong)]";
        return (
          <button
            key={tab.value}
            type="button"
            disabled={!hasData}
            onClick={() => hasData && setActiveRegion(tab.value)}
            className={`rounded-full border px-4 py-2 text-sm font-semibold transition ${tabClass}`}
          >
            {tab.label}
            {hasData && (
              <span className={`ml-1.5 text-xs ${isActive ? "text-white/80" : "text-[var(--ink-soft)]"}`}>
                {cityCount}城
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function PaginatedRecordTables({ allDateRows }) {
  const DATES_PER_PAGE = 7;

  // 默认选中第一个有数据的 Tab（仅计入有下单数据的）
  const firstAvailable = REGION_TABS.find(
    (tab) =>
      allDateRows.some((day) =>
        day.rows.some((r) => (r.region || "domestic") === tab.value && r.marketSlug),
      ),
  );
  const [activeRegion, setActiveRegion] = useState(firstAvailable?.value || "domestic");

  // 按当前 region 过滤，仅展示有下单数据（marketSlug）的日期
  const filteredDateRows = allDateRows
    .map((day) => ({
      date: day.date,
      rows: day.rows.filter(
        (r) => (r.region || "domestic") === activeRegion && r.marketSlug,
      ),
    }))
    .filter((day) => day.rows.length > 0);

  const totalPages = Math.max(1, Math.ceil(filteredDateRows.length / DATES_PER_PAGE));
  const [page, setPage] = useState(0);
  const start = page * DATES_PER_PAGE;
  const pageDates = filteredDateRows.slice(start, start + DATES_PER_PAGE);

  // 切换 Tab 时重置分页
  const handleTabChange = (value) => {
    setActiveRegion(value);
    setPage(0);
  };

  return (
    <section className="overflow-hidden rounded-[2rem] border border-[var(--line)] bg-[var(--panel)] shadow-[var(--shadow)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-4">
        <h3 className="font-display text-2xl font-semibold tracking-[0.05em] text-neutral-950">
          天气监控明细
        </h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={page <= 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="rounded-full border border-[var(--line)] px-3 py-1 text-xs font-semibold text-neutral-800 transition hover:border-[var(--accent-strong)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            上一页
          </button>
          <span className="text-sm text-[var(--ink-soft)]">
            {page + 1} / {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            className="rounded-full border border-[var(--line)] px-3 py-1 text-xs font-semibold text-neutral-800 transition hover:border-[var(--accent-strong)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            下一页
          </button>
        </div>
      </div>
      <RegionTabBar
        allDateRows={allDateRows}
        activeRegion={activeRegion}
        setActiveRegion={handleTabChange}
      />
      <div className="overflow-x-auto">
        {pageDates.length > 0 ? (
          <>
            <PagePnlStrip pageDates={pageDates} />
            {pageDates.map(({ date, rows }) => (
              <WeatherDayTable key={date} date={date} rows={rows} />
            ))}
          </>
        ) : (
          <div className="px-5 py-10 text-center text-sm text-[var(--ink-soft)]">
            该区域暂无天气记录
          </div>
        )}
      </div>
    </section>
  );
}
