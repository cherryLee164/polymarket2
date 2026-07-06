"use client";

import { useState } from "react";

function formatShortDate(ymd) {
  const [, month, day] = String(ymd || "").split("-");
  if (!month || !day) {
    return ymd || "--";
  }
  return `${month}/${day}`;
}

function formatDate(ymd) {
  const [year, month, day] = String(ymd || "").split("-");
  if (!year || !month || !day) {
    return ymd || "--";
  }
  return `${year}/${month}/${day}`;
}

function formatTemp(value, unit) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "--";
  }
  const suffix = unit === "fahrenheit" ? "°F" : "°C";
  return `${Math.round(numeric)}${suffix}`;
}

function formatActualTemp(label, value, unit) {
  // 优先显示 Polymarket 原始 bucket label（如 "70-71°F"），跟网站一致
  if (label) return label;
  return formatTemp(value, unit);
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

function deltaToneClass(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) {
    return "border-[var(--line)] bg-white text-neutral-900";
  }
  if (numeric > 3) {
    return "border-[rgba(180,58,47,0.22)] bg-[rgba(180,58,47,0.10)] text-[var(--signal-down)]";
  }
  if (numeric > 0) {
    return "border-[rgba(214,122,67,0.22)] bg-[rgba(214,122,67,0.11)] text-[var(--accent-strong)]";
  }
  return "border-[rgba(22,122,82,0.18)] bg-[rgba(22,122,82,0.08)] text-[var(--signal-up)]";
}

function cellByDate(row, date) {
  return row?.cells?.find((cell) => cell.date === date) || null;
}

const PAGE_SIZE = 7;

// 区域 Tab 配置：value 对应 city config 的 region 字段
// 未来加其他州只需在这里追加一项，并在 weather-data.js 配置对应城市
// orderTimeBeijing 为该区域城市下单时间范围（北京时间），供人工下单参考
const REGION_TABS = [
  {
    value: "domestic",
    label: "国内",
    subtitle: "每格 = 实际高温 - 预报高温",
    orderTimeBeijing: "00:10",
  },
  {
    value: "asia-foreign",
    label: "亚洲",
    subtitle: "预报源：Open-Meteo · 结算源：Wunderground 机场站",
    orderTimeBeijing: "00:10",
  },
  {
    value: "europe",
    label: "欧洲",
    subtitle: "预报源：Open-Meteo · 结算源：Wunderground 机场站",
    orderTimeBeijing: "00:10",
  },
  {
    value: "north-america",
    label: "北美",
    subtitle: "预报源：Open-Meteo · 结算源：Wunderground/NWS 机场站",
    orderTimeBeijing: "00:10",
  },
  {
    value: "south-america",
    label: "南美",
    subtitle: "预报源：Open-Meteo · 结算源：Wunderground 机场站",
    orderTimeBeijing: "00:10",
  },
  {
    value: "africa",
    label: "非洲",
    subtitle: "预报源：Open-Meteo · 结算源：Wunderground 机场站",
    orderTimeBeijing: "00:10",
  },
  {
    value: "oceania",
    label: "大洋洲",
    subtitle: "预报源：Open-Meteo · 结算源：Wunderground 机场站",
    orderTimeBeijing: "00:10",
  },
];

function CityRegionStrips({ allDates, allRows, title, subtitle, orderTimeBeijing }) {
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil((allDates || []).length / PAGE_SIZE));
  const startIndex = page * PAGE_SIZE;
  const pageDates = (allDates || []).slice(startIndex, startIndex + PAGE_SIZE);
  const pageStartDate = pageDates[0];
  const pageEndDate = pageDates[pageDates.length - 1];

  return (
    <section className="rounded-[2rem] border border-[var(--line)] bg-[var(--panel)] p-5 shadow-[var(--shadow)]">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-display text-xs uppercase tracking-[0.38em] text-[var(--ink-soft)]">Forecast Error</p>
          <h2 className="font-display mt-3 text-2xl font-semibold tracking-[0.05em] text-neutral-950">
            {title}
          </h2>
          <p className="mt-1 text-sm text-[var(--ink-soft)]">
            {pageDates.length > 0
              ? `${formatDate(pageEndDate)} - ${formatDate(pageStartDate)}（第 ${page + 1} / ${totalPages} 页）`
              : "无数据"}
          </p>
          {orderTimeBeijing && (
            <p className="mt-2 inline-block rounded-full border border-[var(--accent-strong)] bg-[rgba(214,122,67,0.08)] px-3 py-1 text-xs font-semibold text-[var(--accent-strong)]">
              跑预测时间 {orderTimeBeijing} 北京时间
            </p>
          )}
        </div>
        <p className="text-sm text-[var(--ink-soft)]">{subtitle}</p>
      </div>

      <div className="mt-5 space-y-3">
        {(allRows || []).map((row) => (
          <article
            key={row.citySlug}
            className="rounded-[1.55rem] border border-[var(--line)] bg-[rgba(255,255,255,0.72)] px-4 py-4"
          >
            <div className="grid gap-4 xl:grid-cols-[220px_minmax(0,1fr)] xl:items-center">
              <div>
                <div className="text-xl font-semibold text-neutral-950">{row.cityZh}</div>
                <div className="mt-1 max-w-sm truncate text-sm text-[var(--ink-soft)]">{row.forecastTarget}</div>
                <div className="mt-3 text-xs text-[var(--ink-soft)]">
                  {row.todayWeather ? `今日天气：${row.todayWeather}` : "暂无天气描述"}
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
                {pageDates.map((date) => {
                  const cell = cellByDate(row, date);
                  const resolved = Number.isFinite(Number(cell?.deltaC));
                  return (
                    <div
                      key={`${row.citySlug}:${date}`}
                      className={`rounded-[1.15rem] border px-3 py-3 ${resolved ? deltaToneClass(cell.deltaC) : "border-dashed border-[var(--line)] bg-white/45 text-[var(--ink-soft)]"}`}
                    >
                      <div className="text-xs font-medium opacity-70">{formatShortDate(date)}</div>
                      <div className="mt-1 text-2xl font-semibold">{resolved ? formatDelta(cell.deltaC, cell?.unit) : "--"}</div>
                      <div className="mt-1 text-xs leading-5 opacity-75">
                        实 {formatActualTemp(cell?.actualTempLabel, cell?.actualMaxTempC, cell?.unit)} / 预 {formatTemp(cell?.forecastMaxTempC, cell?.unit)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </article>
        ))}
      </div>

      {totalPages > 1 && (
        <div className="mt-6 flex items-center justify-center gap-3">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="rounded-full border border-[var(--line)] bg-white px-5 py-2 text-sm font-semibold text-neutral-800 transition hover:border-[var(--accent-strong)] hover:text-[var(--accent-strong)] disabled:opacity-40 disabled:hover:border-[var(--line)] disabled:hover:text-neutral-800"
          >
            上一页
          </button>
          <span className="text-sm text-[var(--ink-soft)]">
            第 {page + 1} / {totalPages} 页
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="rounded-full border border-[var(--line)] bg-white px-5 py-2 text-sm font-semibold text-neutral-800 transition hover:border-[var(--accent-strong)] hover:text-[var(--accent-strong)] disabled:opacity-40 disabled:hover:border-[var(--line)] disabled:hover:text-neutral-800"
          >
            下一页
          </button>
        </div>
      )}
    </section>
  );
}

function RegionPlaceholder({ label, subtitle, orderTimeBeijing }) {
  return (
    <section className="rounded-[2rem] border border-dashed border-[var(--line)] bg-[var(--panel)] p-10 text-center shadow-[var(--shadow)]">
      <p className="font-display text-xs uppercase tracking-[0.38em] text-[var(--ink-soft)]">Coming Soon</p>
      <h2 className="font-display mt-3 text-2xl font-semibold tracking-[0.05em] text-neutral-950">
        {label}城市温差
      </h2>
      {orderTimeBeijing && (
        <p className="mt-2 inline-block rounded-full border border-[var(--accent-strong)] bg-[rgba(214,122,67,0.08)] px-3 py-1 text-xs font-semibold text-[var(--accent-strong)]">
          跑预测时间 {orderTimeBeijing} 北京时间
        </p>
      )}
      <p className="mt-3 text-sm text-[var(--ink-soft)]">{subtitle}</p>
    </section>
  );
}

export function CityTemperatureStrips({ allDates, allRows }) {
  // 默认选中第一个有数据的 Tab，否则选国内
  const firstAvailable = REGION_TABS.find(
    (tab) => !tab.placeholder && (allRows || []).some((row) => row.region === tab.value),
  );
  const [activeRegion, setActiveRegion] = useState(firstAvailable?.value || "domestic");

  const activeTab = REGION_TABS.find((tab) => tab.value === activeRegion) || REGION_TABS[0];
  const activeRows = (allRows || []).filter((row) => row.region === activeRegion);

  return (
    <div className="space-y-4">
      {/* 区域子 Tab */}
      <div className="flex flex-wrap items-center gap-2">
        {REGION_TABS.map((tab) => {
          const tabRowCount = tab.placeholder
            ? 0
            : (allRows || []).filter((row) => row.region === tab.value).length;
          const isActive = tab.value === activeRegion;
          const isPlaceholder = Boolean(tab.placeholder);
          const tabClass = isPlaceholder
            ? "cursor-not-allowed border-[var(--line)] bg-white/40 text-[var(--ink-soft)] opacity-60"
            : isActive
              ? "border-[var(--accent-strong)] bg-[var(--accent-strong)] text-white"
              : "border-[var(--line)] bg-white text-neutral-800 hover:border-[var(--accent-strong)] hover:text-[var(--accent-strong)]";
          return (
            <button
              key={tab.value}
              type="button"
              disabled={isPlaceholder}
              onClick={() => !isPlaceholder && setActiveRegion(tab.value)}
              className={`rounded-full border px-5 py-2 text-sm font-semibold transition ${tabClass}`}
            >
              {tab.label}
              {!isPlaceholder && tabRowCount > 0 && (
                <span className={`ml-2 text-xs ${isActive ? "text-white/80" : "text-[var(--ink-soft)]"}`}>
                  {tabRowCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* 当前 Tab 内容 */}
      {activeTab.placeholder ? (
        <RegionPlaceholder
          label={activeTab.label}
          subtitle={activeTab.subtitle}
          orderTimeBeijing={activeTab.orderTimeBeijing}
        />
      ) : (
        <CityRegionStrips
          allDates={allDates}
          allRows={activeRows}
          title={`${activeTab.label}城市温差`}
          subtitle={activeTab.subtitle}
          orderTimeBeijing={activeTab.orderTimeBeijing}
        />
      )}
    </div>
  );
}
