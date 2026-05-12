import Link from "next/link";

const MONITOR_THRESHOLDS = [45, 40, 35, 30];
const MONITOR_VARIANT_TABS = [
  { id: "15m", label: "15M 监控" },
  { id: "1h", label: "1H 监控" },
  { id: "4h", label: "4H 监控" },
];
const DISPLAY_TIME_ZONE = "Asia/Shanghai";
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
});
const CLOCK_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: DISPLAY_TIME_ZONE,
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
});

function buildHref(currentQuery, patch) {
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

function formatCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatRatioPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "--";
  }
  return `${(numeric * 100).toFixed(1)}%`;
}

function formatDateTime(value) {
  if (!value) {
    return "--";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return DATE_TIME_FORMATTER.format(parsed);
}

function formatShortClock(value) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return CLOCK_FORMATTER.format(parsed);
}

function formatWindowLabel(start, end) {
  if (!start || !end) {
    return `${formatDateTime(start)} -> ${formatDateTime(end)}`;
  }
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return `${formatDateTime(start)} -> ${formatDateTime(end)}`;
  }
  const sameDay =
    startDate.getFullYear() === endDate.getFullYear() &&
    startDate.getMonth() === endDate.getMonth() &&
    startDate.getDate() === endDate.getDate();
  const dateLabel = DATE_FORMATTER.format(startDate);
  const exactHourBoundary =
    startDate.getMinutes() === 0 &&
    startDate.getSeconds() === 0 &&
    endDate.getMinutes() === 0 &&
    endDate.getSeconds() === 0;
  if (sameDay && exactHourBoundary) {
    return `${dateLabel} ${startDate.getHours()}点到${endDate.getHours()}点`;
  }
  if (sameDay) {
    return `${dateLabel} ${CLOCK_FORMATTER.format(startDate)} -> ${CLOCK_FORMATTER.format(endDate)}`;
  }
  return `${dateLabel} ${CLOCK_FORMATTER.format(startDate)} -> ${DATE_FORMATTER.format(
    endDate,
  )} ${CLOCK_FORMATTER.format(endDate)}`;
}

function formatMonitorVariant(target) {
  if (!target) {
    return "--";
  }
  if (target.monitorVariant) {
    return String(target.monitorVariant).toUpperCase();
  }
  const hours = Number(target.monitorWindowHours ?? 1);
  if (Math.abs(hours - 0.25) < 0.0001) {
    return "15M";
  }
  if (Math.abs(hours - 5 / 60) < 0.0001) {
    return "5M";
  }
  return `${hours}H`;
}

function formatFirstTriggerLine(summary, side) {
  const sideLabel = side === "up" ? "上" : "下";
  const hits = summary?.firstThresholdHits?.[side];
  if (!hits || typeof hits !== "object") {
    return `${sideLabel}侧无触发`;
  }
  const parts = MONITOR_THRESHOLDS.map((threshold) => {
    const hitAt = formatShortClock(hits[`lt${threshold}`]);
    return hitAt ? `${threshold}@${hitAt}` : null;
  }).filter(Boolean);
  return parts.length ? `${sideLabel} ${parts.join(" / ")}` : `${sideLabel}侧无触发`;
}

function getSamplingHealthTone(summary) {
  const status = summary?.samplingHealth?.status;
  if (status === "risky") {
    return "text-[var(--signal-down)]";
  }
  if (status === "watch") {
    return "text-[var(--accent-strong)]";
  }
  return "text-[var(--ink-soft)]";
}

function formatSamplingHealthLine(summary) {
  const health = summary?.samplingHealth;
  if (!health) {
    return "采样健康度暂无数据";
  }
  const parts = [
    `采样 ${health.actualSamples ?? summary?.sampleCount ?? 0}/${health.expectedSamplesFullWindow ?? "--"}`,
  ];
  if (Number.isFinite(health.windowCoverageRatio)) {
    parts.push(`覆盖 ${formatRatioPercent(health.windowCoverageRatio)}`);
  }
  if (Number.isFinite(health.longestGapSeconds)) {
    parts.push(`最大断点 ${health.longestGapSeconds.toFixed(1)}s`);
  }
  if (Number(health.estimatedMissedSamples ?? 0) > 0) {
    parts.push(`漏点约 ${health.estimatedMissedSamples}`);
  }
  return parts.join(" / ");
}

function formatThresholdCell(summary, side, threshold) {
  const hit = summary?.thresholds?.[side]?.[`lt${threshold}`] ?? false;
  return (
    <span
      className={
        hit
          ? "inline-flex min-w-12 items-center justify-center rounded-full bg-[rgba(22,122,82,0.12)] px-3 py-1 text-xs font-semibold text-[var(--signal-up)]"
          : "inline-flex min-w-12 items-center justify-center rounded-full bg-[rgba(180,58,47,0.08)] px-3 py-1 text-xs font-semibold text-[var(--signal-down)]"
      }
    >
      {hit ? "达到" : "未达"}
    </span>
  );
}

function renderPanelHeader(kicker, title, description, action = null) {
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="max-w-3xl">
        <p className="font-display text-xs uppercase tracking-[0.4em] text-[var(--ink-soft)]">
          {kicker}
        </p>
        <h2 className="font-display mt-3 text-3xl font-semibold uppercase tracking-[0.08em] text-neutral-950">
          {title}
        </h2>
        <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">{description}</p>
      </div>
      {action}
    </div>
  );
}

function renderMetricCard({ label, value, helper, tone = "neutral", compact = false, valueClassName = "" }) {
  const toneClass = {
    neutral: "text-neutral-950",
    accent: "text-[var(--accent-strong)]",
    up: "text-[var(--signal-up)]",
    down: "text-[var(--signal-down)]",
  }[tone];

  return (
    <article
      className={
        compact
          ? "rounded-[1.6rem] border border-[var(--line)] bg-[var(--panel)] px-5 py-4 shadow-[var(--shadow)] backdrop-blur"
          : "rounded-[1.85rem] border border-[var(--line)] bg-[var(--panel)] px-5 py-5 shadow-[var(--shadow)] backdrop-blur"
      }
    >
      <p className="text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">{label}</p>
      <p
        className={`font-display mt-3 font-semibold uppercase ${toneClass} ${
          compact ? "text-3xl" : "text-[1.9rem] leading-[1.15] md:text-[2.2rem]"
        } ${valueClassName}`}
      >
        {value}
      </p>
      {helper ? <p className="mt-2 text-sm text-[var(--ink-soft)]">{helper}</p> : null}
    </article>
  );
}

function renderThresholdSummaryCard({ label, stats, tone = "neutral" }) {
  const toneClass = {
    neutral: "text-neutral-950",
    accent: "text-[var(--accent-strong)]",
    up: "text-[var(--signal-up)]",
    down: "text-[var(--signal-down)]",
  }[tone];
  const total = Number(stats?.totalSummaries ?? 0);

  return (
    <article className="rounded-[1.6rem] border border-[var(--line)] bg-[var(--panel)] px-5 py-4 shadow-[var(--shadow)] backdrop-blur">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">{label}</p>
        <div className="rounded-full border border-[var(--line)] bg-white/72 px-3 py-1 text-[11px] text-[var(--ink-soft)]">
          当前筛选
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {MONITOR_THRESHOLDS.map((threshold) => {
          const item = stats?.[`lt${threshold}`] ?? { count: 0, ratio: 0 };
          const ratioPercent = Math.max(0, Math.min(100, Number(item.ratio ?? 0) * 100));
          return (
            <div
              key={`${label}-${threshold}`}
              className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-2xl bg-white/72 px-3 py-2"
            >
              <span className="text-xs font-semibold text-[var(--ink-soft)]">{`<=${threshold}`}</span>
              <div className="h-2 overflow-hidden rounded-full bg-[rgba(132,103,66,0.12)]">
                <div
                  className={
                    tone === "down"
                      ? "h-full rounded-full bg-[linear-gradient(90deg,rgba(180,58,47,0.85),rgba(224,126,94,0.92))]"
                      : "h-full rounded-full bg-[linear-gradient(90deg,rgba(22,122,82,0.84),rgba(112,173,124,0.9))]"
                  }
                  style={{ width: `${ratioPercent}%` }}
                />
              </div>
              <div className="min-w-[6.8rem] text-right text-xs text-[var(--ink-soft)]">
                <span className={`font-semibold ${toneClass}`}>{formatCount(item.count)}</span>
                <span>{` / ${total} / ${formatRatioPercent(item.ratio)}`}</span>
              </div>
            </div>
          );
        })}
      </div>
    </article>
  );
}

function renderTabBar(currentQuery, selectedMonitorVariant) {
  return (
    <div className="mt-6 flex flex-wrap gap-3">
      {MONITOR_VARIANT_TABS.map((tab) => {
        const active = tab.id === selectedMonitorVariant;
        return (
          <Link
            key={tab.id}
            className={
              active
                ? "rounded-full bg-[linear-gradient(135deg,var(--accent),var(--accent-strong))] px-5 py-3 text-sm font-semibold text-[var(--accent-ink)] shadow-[0_12px_30px_rgba(184,87,38,0.22)]"
                : "rounded-full border border-[var(--line)] px-5 py-3 text-sm font-semibold text-neutral-700 transition hover:border-[var(--accent-strong)] hover:text-[var(--accent-strong)]"
            }
            href={buildHref(currentQuery, {
              monitorVariant: tab.id,
              monitorPage: 1,
            })}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}

function renderPagination(currentQuery, key, pagination) {
  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border-t border-[var(--line)] pt-5 text-sm text-[var(--ink-soft)]">
      <div>
        第 {pagination.page} / {pagination.totalPages} 页，共 {pagination.totalItems} 条
      </div>
      <div className="flex items-center gap-3">
        {pagination.hasPreviousPage ? (
          <Link
            className="rounded-full border border-[var(--line)] px-4 py-2 font-medium transition hover:border-[var(--accent-strong)] hover:text-[var(--accent-strong)]"
            href={buildHref(currentQuery, { [key]: pagination.page - 1 })}
          >
            上一页
          </Link>
        ) : (
          <span className="rounded-full border border-[var(--line)] px-4 py-2 text-neutral-400">上一页</span>
        )}
        {pagination.hasNextPage ? (
          <Link
            className="rounded-full bg-[linear-gradient(135deg,var(--accent),var(--accent-strong))] px-4 py-2 font-medium text-[var(--accent-ink)] shadow-[0_12px_28px_rgba(184,87,38,0.22)] transition hover:brightness-105"
            href={buildHref(currentQuery, { [key]: pagination.page + 1 })}
          >
            下一页
          </Link>
        ) : (
          <span className="rounded-full border border-[var(--line)] px-4 py-2 text-neutral-400">下一页</span>
        )}
      </div>
    </div>
  );
}

export function MonitorSectionPanel({
  currentQuery,
  filters,
  pagination,
  summaries,
  activeRun,
  activeRuns,
  thresholdAggregate,
  selectedMonitorVariant,
}) {
  return (
    <section className="rounded-[2rem] border border-[var(--line)] bg-[var(--panel-strong)] p-6 shadow-[var(--shadow)]">
      {renderPanelHeader(
        "Monitor matrix",
        "监控列表",
        "这里只保留监控数据。按周期查看 5 分钟、15 分钟、1 小时、4 小时的阈值命中情况和采样健康度。",
        <form
          className="grid gap-3 rounded-[1.5rem] border border-[var(--line)] bg-white/70 p-4 sm:grid-cols-[1fr_1fr_auto_auto]"
          method="GET"
        >
          <input name="monitorVariant" type="hidden" value={selectedMonitorVariant} />
          <label className="flex flex-col gap-2 text-xs uppercase tracking-[0.22em] text-[var(--ink-soft)]">
            开始日期
            <input
              className="rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[var(--accent-strong)]"
              defaultValue={filters.startDate}
              name="startDate"
              type="date"
            />
          </label>
          <label className="flex flex-col gap-2 text-xs uppercase tracking-[0.22em] text-[var(--ink-soft)]">
            结束日期
            <input
              className="rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[var(--accent-strong)]"
              defaultValue={filters.endDate}
              name="endDate"
              type="date"
            />
          </label>
          <button
            className="rounded-full bg-[linear-gradient(135deg,var(--accent),var(--accent-strong))] px-5 py-3 text-sm font-semibold text-[var(--accent-ink)] shadow-[0_12px_28px_rgba(184,87,38,0.22)] transition hover:brightness-105"
            type="submit"
          >
            查询
          </button>
          <Link
            className="rounded-full border border-[var(--line)] bg-[rgba(255,255,255,0.86)] px-5 py-3 text-center text-sm font-semibold text-[var(--ink-soft)] transition hover:border-[var(--accent-strong)] hover:text-[var(--accent-strong)]"
            href={buildHref(currentQuery, {
              startDate: "",
              endDate: "",
              monitorPage: 1,
            })}
          >
            重置
          </Link>
        </form>,
      )}

      {renderTabBar(currentQuery, selectedMonitorVariant)}

      <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-[0.78fr_0.94fr_0.64fr_0.64fr]">
        {renderMetricCard({
          label: "活跃周期",
          value: activeRuns?.length
            ? activeRuns.map((run) => formatMonitorVariant(run)).join(" / ")
            : "--",
          helper: "",
          compact: true,
          valueClassName: "tracking-[0.06em]",
        })}
        {renderMetricCard({
          label: "最新市场",
          value: activeRun?.slug ?? "--",
          helper: activeRun?.lastSampleAt
            ? `${formatMonitorVariant(activeRun)} / ${formatDateTime(activeRun.lastSampleAt)}`
            : "当前没有活跃监控文件",
          compact: false,
          valueClassName: "break-words text-[1.05rem] leading-[1.24] md:text-[1.28rem] normal-case",
        })}
        {renderThresholdSummaryCard({
          label: "双边达标汇总",
          stats: thresholdAggregate?.both,
          tone: "up",
        })}
        {renderThresholdSummaryCard({
          label: "单边未达标",
          stats: thresholdAggregate?.missingEither,
          tone: "down",
        })}
      </div>

      <div className="mt-8 overflow-x-auto rounded-[1.5rem] border border-[var(--line)] bg-white/72">
        <table className="min-w-full text-sm">
          <thead className="text-left text-[var(--ink-soft)]">
            <tr>
              <th className="px-5 pb-4 pt-5 font-medium">时间区间</th>
              {MONITOR_THRESHOLDS.map((threshold) => (
                <th key={`up-${threshold}`} className="px-3 pb-4 pt-5 font-medium">
                  上{threshold}
                </th>
              ))}
              {MONITOR_THRESHOLDS.map((threshold) => (
                <th key={`down-${threshold}`} className="px-3 pb-4 pt-5 font-medium">
                  下{threshold}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {summaries.length ? (
              summaries.map((summary) => (
                <tr key={summary.runId ?? summary.fileName} className="border-t border-[var(--line)]">
                  <td className="px-5 py-4 align-top">
                    <div className="min-w-[22rem]">
                      <p className="font-medium text-neutral-950">
                        {formatWindowLabel(summary.eventStart, summary.eventEnd)}
                      </p>
                      <p className="mt-1 text-xs text-[var(--ink-soft)]">
                        {formatFirstTriggerLine(summary, "up")}
                      </p>
                      <p className="mt-1 text-xs text-[var(--ink-soft)]">
                        {formatFirstTriggerLine(summary, "down")}
                      </p>
                      <p className={`mt-1 text-xs ${getSamplingHealthTone(summary)}`}>
                        {formatSamplingHealthLine(summary)}
                      </p>
                    </div>
                  </td>
                  {MONITOR_THRESHOLDS.map((threshold) => (
                    <td key={`up-${threshold}`} className="px-3 py-4">
                      {formatThresholdCell(summary, "up", threshold)}
                    </td>
                  ))}
                  {MONITOR_THRESHOLDS.map((threshold) => (
                    <td key={`down-${threshold}`} className="px-3 py-4">
                      {formatThresholdCell(summary, "down", threshold)}
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td className="px-5 py-8 text-[var(--ink-soft)]" colSpan={1 + MONITOR_THRESHOLDS.length * 2}>
                  当前筛选范围内没有监控汇总记录。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {renderPagination(currentQuery, "monitorPage", pagination)}
    </section>
  );
}
