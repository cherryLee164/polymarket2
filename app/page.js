import Link from "next/link";
import { getMonitorSnapshot } from "@/lib/monitor-data";
import { getOrderSnapshot } from "@/lib/order-data";
import { MonitorSectionPanel } from "@/app/components/monitor-section";
import { OverviewPanel, OrderHoursPanel } from "@/app/components/order-summary-sections";
import { SettlementLogsSectionPanel } from "@/app/components/settlement-logs-section";

export const dynamic = "force-dynamic";

const MONITOR_THRESHOLDS = [45, 40, 35, 30];
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
const VIEWS = [
  { id: "overview", label: "总览" },
  { id: "monitor", label: "监控列表" },
  { id: "hours", label: "下单小时" },
  { id: "orders", label: "订单明细" },
  { id: "settlements", label: "结算日志" },
];
const MONITOR_VARIANT_TABS = [
  { id: "5m", label: "5M 监控" },
  { id: "15m", label: "15M 监控" },
  { id: "1h", label: "1H 监控" },
  { id: "4h", label: "4H 监控" },
];

function getParam(searchParams, key, fallback = "") {
  const value = searchParams?.[key];
  if (Array.isArray(value)) {
    return value[0] ?? fallback;
  }
  return value ?? fallback;
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

function formatMoney(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "--";
  }
  const sign = numeric > 0 ? "+" : "";
  return `${sign}$${numeric.toFixed(3)}`;
}

function formatCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
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

function formatFirstTriggerLine(summary, side) {
  const sideLabel = side === "up" ? "上" : "下";
  const hits = summary?.firstThresholdHits?.[side];
  if (!hits || typeof hits !== "object") {
    return `${sideLabel} 无触发`;
  }
  const parts = MONITOR_THRESHOLDS.map((threshold) => {
    const hitAt = formatShortClock(hits[`lt${threshold}`]);
    return hitAt ? `${threshold}@${hitAt}` : null;
  }).filter(Boolean);
  return parts.length ? `${sideLabel} ${parts.join(" · ")}` : `${sideLabel} 无触发`;
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
    return "健康度暂无";
  }
  const parts = [
    `采样 ${health.actualSamples ?? summary?.sampleCount ?? 0}/${health.expectedSamplesFullWindow ?? "--"}`,
  ];
  if (Number.isFinite(health.windowCoverageRatio)) {
    parts.push(`覆盖 ${(health.windowCoverageRatio * 100).toFixed(1)}%`);
  }
  if (Number.isFinite(health.longestGapSeconds)) {
    parts.push(`最大断点 ${health.longestGapSeconds.toFixed(1)}s`);
  }
  if (Number(health.estimatedMissedSamples ?? 0) > 0) {
    parts.push(`漏点约 ${health.estimatedMissedSamples}`);
  }
  return parts.join(" · ");
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

function formatRatioPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "--";
  }
  return `${(numeric * 100).toFixed(1)}%`;
}

function formatRange(start, end) {
  return `${formatDateTime(start)} -> ${formatDateTime(end)}`;
}

function getSettlementStatusMeta(status) {
  if (status === "sold") {
    return {
      label: "已卖出",
      className:
        "inline-flex rounded-full bg-[rgba(22,122,82,0.12)] px-3 py-1 text-xs font-semibold text-[var(--signal-up)]",
    };
  }
  if (status === "claimed") {
    return {
      label: "已领取",
      className:
        "inline-flex rounded-full bg-[rgba(184,87,38,0.12)] px-3 py-1 text-xs font-semibold text-[var(--accent-strong)]",
    };
  }
  if (status === "claim-error" || status === "error") {
    return {
      label: "异常",
      className:
        "inline-flex rounded-full bg-[rgba(180,58,47,0.08)] px-3 py-1 text-xs font-semibold text-[var(--signal-down)]",
    };
  }
  if (status === "watching") {
    return {
      label: "待处理",
      className:
        "inline-flex rounded-full bg-[rgba(17,17,17,0.08)] px-3 py-1 text-xs font-semibold text-neutral-700",
    };
  }
  if (status === "startup") {
    return {
      label: "启动",
      className:
        "inline-flex rounded-full bg-[rgba(17,17,17,0.06)] px-3 py-1 text-xs font-semibold text-neutral-700",
    };
  }
  return {
    label: "空闲",
    className:
      "inline-flex rounded-full bg-[rgba(17,17,17,0.06)] px-3 py-1 text-xs font-semibold text-neutral-500",
  };
}

function formatWindowLabel(start, end) {
  if (!start || !end) {
    return formatRange(start, end);
  }

  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return formatRange(start, end);
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

  const formatClock = (value) => CLOCK_FORMATTER.format(value);

  if (sameDay) {
    return `${dateLabel} ${formatClock(startDate)}到${formatClock(endDate)}`;
  }

  return `${dateLabel} ${formatClock(startDate)} -> ${DATE_FORMATTER.format(
    endDate,
  )} ${formatClock(endDate)}`;
}

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
        <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">
          {description}
        </p>
      </div>
      {action}
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
          <span className="rounded-full border border-[var(--line)] px-4 py-2 text-neutral-400">
            上一页
          </span>
        )}
        {pagination.hasNextPage ? (
          <Link
            className="rounded-full bg-[linear-gradient(135deg,var(--accent),var(--accent-strong))] px-4 py-2 font-medium text-[var(--accent-ink)] shadow-[0_12px_28px_rgba(184,87,38,0.22)] transition hover:brightness-105"
            href={buildHref(currentQuery, { [key]: pagination.page + 1 })}
          >
            下一页
          </Link>
        ) : (
          <span className="rounded-full border border-[var(--line)] px-4 py-2 text-neutral-400">
            下一页
          </span>
        )}
      </div>
    </div>
  );
}

function renderMetricCard(label, value, helper, tone = "neutral") {
  const toneClass = {
    neutral: "text-neutral-950",
    accent: "text-[var(--accent-strong)]",
    up: "text-[var(--signal-up)]",
    down: "text-[var(--signal-down)]",
  }[tone];

  return (
    <article className="rounded-[2rem] border border-[var(--line)] bg-[var(--panel)] p-5 shadow-[var(--shadow)] backdrop-blur">
      <p className="text-xs uppercase tracking-[0.3em] text-[var(--ink-soft)]">
        {label}
      </p>
      <p className={`font-display mt-4 text-4xl font-semibold uppercase ${toneClass}`}>
        {value}
      </p>
      <p className="mt-2 text-sm text-[var(--ink-soft)]">{helper}</p>
    </article>
  );
}

function renderMonitorMetricCard({
  label,
  value,
  helper,
  tone = "neutral",
  valueClassName = "",
  compact = false,
}) {
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
      <p className="text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">
        {label}
      </p>
      <p
        className={`font-display mt-3 font-semibold uppercase ${toneClass} ${
          compact ? "text-3xl" : "text-[1.9rem] leading-[1.15] md:text-[2.2rem]"
        } ${valueClassName}`}
      >
        {value}
      </p>
      {helper ? (
        <p className="mt-2 text-sm text-[var(--ink-soft)]">{helper}</p>
      ) : null}
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
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">
            {label}
          </p>
          <p className={`font-display mt-3 text-3xl font-semibold ${toneClass}`}>
            {formatCount(total)}
          </p>
        </div>
        <div className="rounded-full border border-[var(--line)] bg-white/72 px-3 py-1 text-[11px] text-[var(--ink-soft)]">
          当前筛选
        </div>
      </div>
      <div className="mt-4 space-y-2">
        {MONITOR_THRESHOLDS.map((threshold) => {
          const item = stats?.[`lt${threshold}`] ?? {
            count: 0,
            ratio: 0,
          };
          const ratioPercent = Math.max(
            0,
            Math.min(100, Number(item.ratio ?? 0) * 100),
          );

          return (
            <div
              key={`${label}-${threshold}`}
              className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-2xl bg-white/72 px-3 py-2"
            >
              <span className="text-xs font-semibold text-[var(--ink-soft)]">
                {`<=${threshold}`}
              </span>
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
                <span className={`font-semibold ${toneClass}`}>
                  {formatCount(item.count)}
                </span>
                <span>{` / ${total} · ${formatRatioPercent(item.ratio)}`}</span>
              </div>
            </div>
          );
        })}
      </div>
    </article>
  );
}

function OverviewSection({
  activeRun,
  activeRuns,
  orderSnapshot,
  monitorSummaries,
  orderHours,
}) {
  const summary = orderSnapshot.summary;

  return (
    <section className="rounded-[2rem] border border-[var(--line)] bg-[var(--panel-strong)] p-6 shadow-[var(--shadow)]">
      {renderPanelHeader(
        "Unified desk",
        "后台总览",
        "这个页面现在就是统一后台入口。监控、下单、盈亏汇总都放在一个控制台里，后面做 5 分钟、15 分钟、4 小时策略时也沿用同一套结构。"
      )}

      <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {renderMetricCard(
          "今日盈亏",
          formatMoney(summary?.today?.netPnlUsd ?? 0),
          `${summary?.today?.hours ?? 0} 个已结算小时`,
          Number(summary?.today?.netPnlUsd ?? 0) >= 0 ? "up" : "down",
        )}
        {renderMetricCard(
          "昨日盈亏",
          formatMoney(summary?.yesterday?.netPnlUsd ?? 0),
          `${summary?.yesterday?.hours ?? 0} 个已结算小时`,
          Number(summary?.yesterday?.netPnlUsd ?? 0) >= 0 ? "neutral" : "down",
        )}
        {renderMetricCard(
          "累计净值",
          formatMoney(summary?.totalNetPnlUsd ?? 0),
          `${summary?.settledHours ?? 0} / ${summary?.hoursWithOrders ?? 0} 小时已结算`,
          Number(summary?.totalNetPnlUsd ?? 0) >= 0 ? "accent" : "down",
        )}
        {renderMetricCard(
          "运行中的小时",
          orderSnapshot.runtimeState?.orderUsd
            ? `$${orderSnapshot.runtimeState.orderUsd}`
            : "暂无",
          orderSnapshot.runtimeState?.slug
            ? `当前策略：${orderSnapshot.runtimeState.slug}`
            : activeRun?.slug
              ? `监控同步中：${activeRun.slug}`
              : "当前没有活跃监控文件",
        )}
      </div>

      <div className="mt-8 grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <section className="rounded-[1.75rem] border border-[var(--line)] bg-white/70 p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">
                Monitor
              </p>
              <h3 className="font-display mt-2 text-2xl uppercase tracking-[0.06em]">
                最近监控结果
              </h3>
            </div>
            <Link
              className="rounded-full border border-[var(--line)] px-4 py-2 text-sm font-medium transition hover:border-[var(--accent-strong)] hover:text-[var(--accent-strong)]"
              href="/?view=monitor"
            >
              查看全部
            </Link>
          </div>

          <div className="mt-5 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-[var(--ink-soft)]">
                <tr>
                  <th className="pb-3 pr-4 font-medium">时间</th>
                  <th className="pb-3 pr-3 font-medium">周期</th>
                  <th className="pb-3 pr-3 font-medium">上 45</th>
                  <th className="pb-3 pr-3 font-medium">上 40</th>
                  <th className="pb-3 pr-3 font-medium">下 45</th>
                  <th className="pb-3 font-medium">下 40</th>
                </tr>
              </thead>
              <tbody>
                {monitorSummaries.slice(0, 6).map((summary) => (
                  <tr
                    key={summary.runId ?? summary.fileName}
                    className="border-t border-[var(--line)]"
                  >
                    <td className="py-3 pr-4 whitespace-nowrap">
                      {formatRange(summary.eventStart, summary.eventEnd)}
                    </td>
                    <td className="py-3 pr-3 uppercase">
                      {formatMonitorVariant(summary)}
                    </td>
                    <td className="py-3 pr-3">
                      {formatThresholdCell(summary, "up", 45)}
                    </td>
                    <td className="py-3 pr-3">
                      {formatThresholdCell(summary, "up", 40)}
                    </td>
                    <td className="py-3 pr-3">
                      {formatThresholdCell(summary, "down", 45)}
                    </td>
                    <td className="py-3">
                      {formatThresholdCell(summary, "down", 40)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-[1.75rem] border border-[var(--line)] bg-white/70 p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">
                Orders
              </p>
              <h3 className="font-display mt-2 text-2xl uppercase tracking-[0.06em]">
                最近下单小时
              </h3>
            </div>
            <Link
              className="rounded-full border border-[var(--line)] px-4 py-2 text-sm font-medium transition hover:border-[var(--accent-strong)] hover:text-[var(--accent-strong)]"
              href="/?view=hours"
            >
              查看全部
            </Link>
          </div>

          <div className="mt-5 space-y-3">
            {orderHours.slice(0, 5).map((hour) => (
              <div
                key={hour.hourKey}
                className="rounded-[1.25rem] border border-[var(--line)] bg-[rgba(255,255,255,0.78)] p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.24em] text-[var(--ink-soft)]">
                      {hour.placedSides?.join(" / ") || "未下单"}
                    </p>
                    <p className="mt-1 text-sm font-medium text-neutral-950">
                      {formatWindowLabel(hour.eventStart, hour.eventEnd)}
                    </p>
                  </div>
                  <span
                    className={
                      hour.settlementStatus === "resolved"
                        ? "rounded-full bg-[rgba(22,122,82,0.12)] px-3 py-1 text-xs font-semibold text-[var(--signal-up)]"
                        : "rounded-full bg-[rgba(17,17,17,0.08)] px-3 py-1 text-xs font-semibold text-neutral-700"
                    }
                  >
                    {hour.settlementStatus === "resolved" ? "已结算" : "待结算"}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-3 text-sm text-[var(--ink-soft)]">
                  <span>投入 {formatMoney(hour.totalSpentUsd ?? 0)}</span>
                  <span>回收 {formatMoney(hour.totalPayoutUsd ?? 0)}</span>
                  <span>净值 {formatMoney(hour.netPnlUsd ?? 0)}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}

function MonitorSection({
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
        "按周期查看 5 分钟、15 分钟、1 小时、4 小时的有效监控结果。这里只展示满足覆盖阈值的统计，默认最近 15 天，最新在前。",
        <form className="grid gap-3 rounded-[1.5rem] border border-[var(--line)] bg-white/70 p-4 sm:grid-cols-[1fr_1fr_auto_auto]" method="GET">
          <input name="view" type="hidden" value="monitor" />
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
              view: "monitor",
              startDate: "",
              endDate: "",
              monitorPage: 1,
            })}
          >
            重置
          </Link>
        </form>,
      )}

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
                view: "monitor",
                monitorVariant: tab.id,
                monitorPage: 1,
              })}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-[0.78fr_0.94fr_0.64fr_0.64fr]">
        {renderMonitorMetricCard({
          label: "活跃周期",
          value: activeRuns?.length
            ? activeRuns.map((run) => formatMonitorVariant(run)).join(" / ")
            : "--",
          helper: "",
          tone: "neutral",
          valueClassName: "tracking-[0.06em]",
          compact: true,
        })}
        {renderMonitorMetricCard({
          label: "最新市场",
          value: activeRun?.slug ?? "--",
          helper: activeRun?.lastSampleAt
            ? `${formatMonitorVariant(activeRun)} · ${formatDateTime(activeRun.lastSampleAt)}`
            : "当前没有活跃监控文件",
          tone: "neutral",
          valueClassName:
            "break-words text-[1.05rem] leading-[1.24] md:text-[1.28rem] normal-case",
          compact: false,
        })}
        {renderMonitorMetricCard({
          label: "采样数",
          value: formatCount(activeRun?.sampleCount ?? 0),
          helper: activeRun?.priceSource ?? "clob-buy",
          tone: "neutral",
          valueClassName: "",
          compact: true,
        })}
        {renderMonitorMetricCard({
          label: "记录数",
          value: pagination.totalItems,
          helper: "按时间倒序排列",
          tone: "neutral",
          valueClassName: "",
          compact: true,
        })}
      </div>

      <div className="mt-8 overflow-x-auto rounded-[1.5rem] border border-[var(--line)] bg-white/72">
        <table className="min-w-full text-sm">
          <thead className="text-left text-[var(--ink-soft)]">
            <tr>
              <th className="px-5 pb-4 pt-5 font-medium">时间区间</th>
              {MONITOR_THRESHOLDS.map((threshold) => (
                <th key={`up-${threshold}`} className="px-3 pb-4 pt-5 font-medium">
                  上 {threshold}
                </th>
              ))}
              {MONITOR_THRESHOLDS.map((threshold) => (
                <th key={`down-${threshold}`} className="px-3 pb-4 pt-5 font-medium">
                  下 {threshold}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {summaries.length ? (
              summaries.map((summary) => (
                <tr
                  key={summary.runId ?? summary.fileName}
                  className="border-t border-[var(--line)]"
                >
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
                <td
                  className="px-5 py-8 text-[var(--ink-soft)]"
                  colSpan={1 + MONITOR_THRESHOLDS.length * 2}
                >
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

void OverviewSection;
void OrderHoursSection;
void MonitorSection;

function OrderHoursSection({ currentQuery, summary, runtimeState, hourPage }) {
  return (
    <section className="rounded-[2rem] border border-[var(--line)] bg-[var(--panel-strong)] p-6 shadow-[var(--shadow)]">
      {renderPanelHeader(
        "Settled hours",
        "下单小时汇总",
        "按小时看这套策略到底做了什么。这里会记录投入、回收、净值、赢方和是否配对成功，后面做 4 小时 / 15 分钟 / 5 分钟时也沿用这张表。",
      )}

      <div className="mt-6 grid gap-4 md:grid-cols-4">
        {renderMetricCard(
          "今日净值",
          formatMoney(summary?.today?.netPnlUsd ?? 0),
          `${summary?.today?.hours ?? 0} 个小时`,
          Number(summary?.today?.netPnlUsd ?? 0) >= 0 ? "up" : "down",
        )}
        {renderMetricCard(
          "累计净值",
          formatMoney(summary?.totalNetPnlUsd ?? 0),
          `${summary?.totalOrders ?? 0} 笔成交`,
          Number(summary?.totalNetPnlUsd ?? 0) >= 0 ? "accent" : "down",
        )}
        {renderMetricCard(
          "运行中",
          runtimeState?.slug ?? "暂无",
          runtimeState?.orderUsd ? `当前档位 $${runtimeState.orderUsd}` : "当前没有运行中的下单小时",
        )}
        {renderMetricCard(
          "结算进度",
          `${summary?.settledHours ?? 0}/${summary?.hoursWithOrders ?? 0}`,
          "已结算小时 / 有下单小时",
        )}
      </div>

      <div className="mt-8 overflow-x-auto rounded-[1.5rem] border border-[var(--line)] bg-white/72">
        <table className="min-w-full text-sm">
          <thead className="text-left text-[var(--ink-soft)]">
            <tr>
              <th className="px-5 pb-4 pt-5 font-medium">时间区间</th>
              <th className="px-3 pb-4 pt-5 font-medium">方向</th>
              <th className="px-3 pb-4 pt-5 font-medium">状态</th>
              <th className="px-3 pb-4 pt-5 font-medium">赢方</th>
              <th className="px-3 pb-4 pt-5 font-medium">投入</th>
              <th className="px-3 pb-4 pt-5 font-medium">回收</th>
              <th className="px-5 pb-4 pt-5 font-medium">净值</th>
            </tr>
          </thead>
          <tbody>
            {hourPage.items.length ? (
              hourPage.items.map((hour) => (
                <tr key={hour.hourKey} className="border-t border-[var(--line)]">
                  <td className="px-5 py-4 whitespace-nowrap">
                    {formatWindowLabel(hour.eventStart, hour.eventEnd)}
                  </td>
                  <td className="px-3 py-4 uppercase">
                    {hour.placedSides?.join(" / ") || "--"}
                  </td>
                  <td className="px-3 py-4">
                    <span
                      className={
                        hour.settlementStatus === "resolved"
                          ? "inline-flex rounded-full bg-[rgba(22,122,82,0.12)] px-3 py-1 text-xs font-semibold text-[var(--signal-up)]"
                          : "inline-flex rounded-full bg-[rgba(17,17,17,0.08)] px-3 py-1 text-xs font-semibold text-neutral-700"
                      }
                    >
                      {hour.settlementStatus === "resolved" ? "已结算" : "待结算"}
                    </span>
                  </td>
                  <td className="px-3 py-4 uppercase">{hour.winnerSide ?? "--"}</td>
                  <td className="px-3 py-4">{formatMoney(hour.totalSpentUsd ?? 0)}</td>
                  <td className="px-3 py-4">{formatMoney(hour.totalPayoutUsd ?? 0)}</td>
                  <td
                    className={
                      Number(hour.netPnlUsd ?? 0) >= 0
                        ? "px-5 py-4 font-semibold text-[var(--signal-up)]"
                        : "px-5 py-4 font-semibold text-[var(--signal-down)]"
                    }
                  >
                    {formatMoney(hour.netPnlUsd ?? 0)}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="px-5 py-8 text-[var(--ink-soft)]" colSpan={7}>
                  当前还没有任何下单小时记录。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {renderPagination(currentQuery, "hourPage", hourPage.pagination)}
    </section>
  );
}

function OrderDetailsSection({ currentQuery, orderPage, summary }) {
  return (
    <section className="rounded-[2rem] border border-[var(--line)] bg-[var(--panel-strong)] p-6 shadow-[var(--shadow)]">
      {renderPanelHeader(
        "Execution ledger",
        "订单明细",
        "这里恢复成逐笔订单明细。每一笔 Up / Down 都单独展示，方便直接看触发方式、成交金额、份额、均价和最终净值。",
      )}

      <div className="mt-6 grid gap-4 md:grid-cols-4">
        {renderMetricCard("成交笔数", summary?.totalOrders ?? 0, "累计已记录订单")}
        {renderMetricCard("累计投入", formatMoney(summary?.totalSpentUsd ?? 0), "按成交成本汇总")}
        {renderMetricCard("累计回收", formatMoney(summary?.totalPayoutUsd ?? 0), "已结算部分")}
        {renderMetricCard(
          "胜负小时",
          `${summary?.winningHours ?? 0}/${summary?.losingHours ?? 0}`,
          "盈利小时 / 亏损小时",
        )}
      </div>

      <div className="mt-8 overflow-x-auto rounded-[1.5rem] border border-[var(--line)] bg-white/72">
        <table className="min-w-full text-sm">
          <thead className="text-left text-[var(--ink-soft)]">
            <tr>
              <th className="px-5 pb-4 pt-5 font-medium">下单时间</th>
              <th className="px-3 pb-4 pt-5 font-medium">方向</th>
              <th className="px-3 pb-4 pt-5 font-medium">触发</th>
              <th className="px-3 pb-4 pt-5 font-medium">金额</th>
              <th className="px-3 pb-4 pt-5 font-medium">份额</th>
              <th className="px-3 pb-4 pt-5 font-medium">均价</th>
              <th className="px-3 pb-4 pt-5 font-medium">赢方</th>
              <th className="px-5 pb-4 pt-5 font-medium">净值</th>
            </tr>
          </thead>
          <tbody>
            {orderPage.items.length ? (
              orderPage.items.map((order) => (
                <tr
                  key={`${order.orderId ?? "order"}-${order.side}-${order.requestedAt ?? order.eventStart}`}
                  className="border-t border-[var(--line)]"
                >
                  <td className="px-5 py-4 whitespace-nowrap">
                    {formatDateTime(order.requestedAt)}
                  </td>
                  <td className="px-3 py-4 uppercase">{order.side}</td>
                  <td className="px-3 py-4">{order.triggerType ?? "--"}</td>
                  <td className="px-3 py-4">{formatMoney(order.costUsd ?? 0)}</td>
                  <td className="px-3 py-4">{order.sharesBought ?? "--"}</td>
                  <td className="px-3 py-4">
                    {order.avgPriceCents ? `${order.avgPriceCents}c` : "--"}
                  </td>
                  <td className="px-3 py-4 uppercase">{order.winnerSide ?? "--"}</td>
                  <td
                    className={
                      order.netPnlUsd === null || order.netPnlUsd === undefined
                        ? "px-5 py-4 font-semibold text-neutral-700"
                        : Number(order.netPnlUsd ?? 0) >= 0
                          ? "px-5 py-4 font-semibold text-[var(--signal-up)]"
                          : "px-5 py-4 font-semibold text-[var(--signal-down)]"
                    }
                  >
                    <div className="min-w-[120px]">
                      <p>
                        {order.netPnlUsd === null || order.netPnlUsd === undefined
                          ? "待结算"
                          : formatMoney(order.netPnlUsd)}
                      </p>
                    </div>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="px-5 py-8 text-[var(--ink-soft)]" colSpan={8}>
                  当前还没有订单明细。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {renderPagination(currentQuery, "orderPage", orderPage.pagination)}
    </section>
  );
}

function SettlementLogsSection({ currentQuery, settlementPage, settlementSummary }) {
  return (
    <section className="rounded-[2rem] border border-[var(--line)] bg-[var(--panel-strong)] p-6 shadow-[var(--shadow)]">
      {renderPanelHeader(
        "Settlement log",
        "结算日志",
        "这里记录自动卖出和自动领取每一轮到底做了什么。优先显示 API 卖出结果，其次显示领取尝试、余额变化和异常信息，方便你快速判断自动结算链路是不是正常运行。",
      )}

      <div className="mt-6 grid gap-4 md:grid-cols-4">
        {renderMetricCard(
          "最近余额",
          settlementSummary?.latestBalanceUsd !== null && settlementSummary?.latestBalanceUsd !== undefined
            ? formatMoney(settlementSummary.latestBalanceUsd)
            : "--",
          settlementSummary?.latestLoggedAt
            ? `最近轮询：${formatDateTime(settlementSummary.latestLoggedAt)}`
            : "暂无结算轮询记录",
          "accent",
        )}
        {renderMetricCard(
          "卖出轮次",
          settlementSummary?.soldCycles ?? 0,
          `${settlementSummary?.cycleCount ?? 0} 次结算轮询`,
          "up",
        )}
        {renderMetricCard(
          "领取轮次",
          settlementSummary?.claimCycles ?? 0,
          `${settlementSummary?.trackedConditionCount ?? 0} 个条件在跟踪`,
        )}
        {renderMetricCard(
          "异常记录",
          settlementSummary?.errorCount ?? 0,
          `${settlementSummary?.trackedAssetCount ?? 0} 个资产 cooldown 记录`,
          (settlementSummary?.errorCount ?? 0) > 0 ? "down" : "neutral",
        )}
      </div>

      <div className="mt-8 overflow-x-auto rounded-[1.5rem] border border-[var(--line)] bg-white/72">
        <table className="min-w-full text-sm">
          <thead className="text-left text-[var(--ink-soft)]">
            <tr>
              <th className="px-5 pb-4 pt-5 font-medium">时间</th>
              <th className="px-3 pb-4 pt-5 font-medium">状态</th>
              <th className="px-3 pb-4 pt-5 font-medium">卖出</th>
              <th className="px-3 pb-4 pt-5 font-medium">领取</th>
              <th className="px-3 pb-4 pt-5 font-medium">待处理</th>
              <th className="px-3 pb-4 pt-5 font-medium">余额变化</th>
              <th className="px-5 pb-4 pt-5 font-medium">说明</th>
            </tr>
          </thead>
          <tbody>
            {settlementPage.items.length ? (
              settlementPage.items.map((entry) => {
                const statusMeta = getSettlementStatusMeta(entry.status);
                const delta = Number(entry.balanceDeltaUsd ?? 0);
                return (
                  <tr key={entry.id} className="border-t border-[var(--line)]">
                    <td className="px-5 py-4 whitespace-nowrap">
                      {formatDateTime(entry.loggedAt)}
                    </td>
                    <td className="px-3 py-4">
                      <span className={statusMeta.className}>{statusMeta.label}</span>
                    </td>
                    <td className="px-3 py-4">
                      {entry.soldCount > 0 ? (
                        <div className="space-y-1">
                          {entry.soldItems.slice(0, 2).map((item) => (
                            <p key={`${item.slug}-${item.outcome}-${item.orderId}`} className="text-xs leading-5 text-neutral-800">
                              {(item.slug ?? item.title ?? "--") + (item.outcome ? ` / ${item.outcome}` : "")}
                              {item.sellPrice ? ` @ ${item.sellPrice}` : ""}
                            </p>
                          ))}
                        </div>
                      ) : (
                        <span className="text-[var(--ink-soft)]">
                          {entry.candidateCount > 0 ? `${entry.candidateCount} 个候选` : "--"}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-4">
                      {entry.claimCount > 0 ? (
                        <span className="text-[var(--accent-strong)]">已领取</span>
                      ) : entry.browserAttempted ? (
                        <span className="text-[var(--signal-down)]">已尝试</span>
                      ) : (
                        <span className="text-[var(--ink-soft)]">--</span>
                      )}
                    </td>
                    <td className="px-3 py-4">
                      {entry.redeemableCount > 0 ? `${entry.redeemableCount} 条` : "--"}
                    </td>
                    <td
                      className={
                        entry.balanceDeltaUsd === null
                          ? "px-3 py-4 text-[var(--ink-soft)]"
                          : delta > 0
                            ? "px-3 py-4 font-semibold text-[var(--signal-up)]"
                            : delta < 0
                              ? "px-3 py-4 font-semibold text-[var(--signal-down)]"
                              : "px-3 py-4 text-[var(--ink-soft)]"
                      }
                    >
                      {entry.balanceDeltaUsd === null ? "--" : formatMoney(entry.balanceDeltaUsd)}
                    </td>
                    <td className="px-5 py-4">
                      <div className="max-w-[34rem]">
                        <p className="text-sm leading-6 text-neutral-950">{entry.message}</p>
                        {entry.browserErrorPreview ? (
                          <p className="mt-1 text-xs leading-5 text-[var(--signal-down)]">
                            {entry.browserErrorPreview}
                          </p>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td className="px-5 py-8 text-[var(--ink-soft)]" colSpan={7}>
                  当前还没有结算日志。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {renderPagination(currentQuery, "settlePage", settlementPage.pagination)}
    </section>
  );
}

void SettlementLogsSection;

export default async function Home({ searchParams }) {
  const resolvedSearchParams = await searchParams;
  const currentView = getParam(resolvedSearchParams, "view", "overview");
  const selectedMonitorVariant =
    currentView === "monitor"
      ? getParam(resolvedSearchParams, "monitorVariant", "1h")
      : getParam(resolvedSearchParams, "monitorVariant", "");
  const currentQuery = {
    view: currentView,
    startDate: getParam(resolvedSearchParams, "startDate"),
    endDate: getParam(resolvedSearchParams, "endDate"),
    monitorVariant: selectedMonitorVariant,
    monitorPage:
      getParam(resolvedSearchParams, "monitorPage") ||
      getParam(resolvedSearchParams, "page"),
    hourPage: getParam(resolvedSearchParams, "hourPage"),
    orderPage: getParam(resolvedSearchParams, "orderPage"),
    settlePage: getParam(resolvedSearchParams, "settlePage"),
  };

  const monitorSnapshot = getMonitorSnapshot({
    startDate: currentQuery.startDate,
    endDate: currentQuery.endDate,
    page: currentQuery.monitorPage,
    monitorVariant: currentView === "monitor" ? selectedMonitorVariant : undefined,
  });
  const monitorActiveRun =
    monitorSnapshot.activeRuns.find((run) => run.monitorVariant === selectedMonitorVariant) ??
    monitorSnapshot.activeRun;
  const orderSnapshot = getOrderSnapshot({
    hourPage: currentQuery.hourPage,
    orderPage: currentQuery.orderPage,
    settlePage: currentQuery.settlePage,
  });

  const monitorSummaries = monitorSnapshot.summaryPage.items;
  const monitorSummaryMode = monitorSnapshot.summaryPage.mode ?? "monitor";
  const monitorPaperSummary = monitorSnapshot.summaryPage.paperSummary ?? null;
  const monitorPagination = monitorSnapshot.summaryPage.pagination;
  const monitorFilters = monitorSnapshot.summaryPage.filters;
  const monitorThresholdAggregate = monitorSnapshot.summaryPage.thresholdAggregate;

  return (
    <main className="notranslate min-h-screen bg-transparent text-neutral-950" translate="no">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-8 px-5 py-8 lg:px-8">
        <header className="overflow-hidden rounded-[2.5rem] border border-[var(--line)] bg-[linear-gradient(135deg,rgba(255,255,255,0.85),rgba(255,246,224,0.9))] shadow-[var(--shadow)]">
          <div className="grid gap-8 p-6 lg:grid-cols-[1.2fr_0.8fr] lg:p-10">
            <div>
              <p className="font-display text-sm uppercase tracking-[0.55em] text-[var(--ink-soft)]">
                Polymarket ops console
              </p>
              <h1 className="font-display mt-4 max-w-4xl text-5xl font-semibold uppercase tracking-[0.06em] text-neutral-950 md:text-7xl">
                统一后台管理页
              </h1>
              <p className="mt-5 max-w-3xl text-base leading-7 text-[var(--ink-soft)]">
                你现在访问的不再只是一个监控表，而是一个统一后台。监控列表、下单小时、订单明细、盈亏汇总都放在这里。后面扩到 5 分钟、15 分钟、4 小时，也沿用这套管理结构。
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              {renderMetricCard(
                "监控记录",
                monitorPagination.totalItems,
                `默认最近 15 天，当前页 ${monitorPagination.page}`,
              )}
              {renderMetricCard(
                "下单小时",
                orderSnapshot.summary.hoursWithOrders ?? 0,
                `${orderSnapshot.summary.settledHours ?? 0} 个已结算`,
              )}
              {renderMetricCard(
                "今日净值",
                formatMoney(orderSnapshot.summary?.today?.netPnlUsd ?? 0),
                "自动按后台日志时区汇总",
                Number(orderSnapshot.summary?.today?.netPnlUsd ?? 0) >= 0 ? "up" : "down",
              )}
              {renderMetricCard(
                "累计净值",
                formatMoney(orderSnapshot.summary?.totalNetPnlUsd ?? 0),
                `${orderSnapshot.summary?.totalOrders ?? 0} 笔订单`,
                Number(orderSnapshot.summary?.totalNetPnlUsd ?? 0) >= 0 ? "accent" : "down",
              )}
            </div>
          </div>
        </header>

        <nav className="sticky top-3 z-10 flex flex-wrap gap-3 rounded-[2rem] border border-[var(--line)] bg-[rgba(255,249,237,0.82)] p-3 backdrop-blur">
          {VIEWS.map((item) => {
            const active = item.id === currentView;
            return (
              <Link
                key={item.id}
                className={
                  active
                    ? "rounded-full bg-[linear-gradient(135deg,var(--accent),var(--accent-strong))] px-5 py-3 text-sm font-semibold text-[var(--accent-ink)] shadow-[0_12px_30px_rgba(184,87,38,0.24)]"
                    : "rounded-full border border-[var(--line)] px-5 py-3 text-sm font-semibold text-neutral-700 transition hover:border-[var(--accent-strong)] hover:text-[var(--accent-strong)]"
                }
                href={buildHref(currentQuery, {
                  view: item.id,
                  monitorPage: 1,
                  hourPage: 1,
                  orderPage: 1,
                  settlePage: 1,
                })}
              >
                {item.label}
              </Link>
            );
          })}
          <div className="ml-auto flex items-center gap-3 text-sm text-[var(--ink-soft)]">
            <span>
              监控接口：<code className="rounded bg-black/5 px-2 py-1">/api/monitor</code>
            </span>
            <span>
              订单接口：<code className="rounded bg-black/5 px-2 py-1">/api/orders</code>
            </span>
          </div>
        </nav>

        {currentView === "overview" ? (
          <OverviewPanel
            monitorSummaries={monitorSummaries}
            orderHours={orderSnapshot.hourPage.items}
            orderSnapshot={orderSnapshot}
          />
        ) : null}

        {currentView === "monitor" ? (
          <MonitorSectionPanel
            activeRun={monitorActiveRun}
            activeRuns={monitorSnapshot.activeRuns}
            currentQuery={currentQuery}
            filters={monitorFilters}
            pagination={monitorPagination}
            selectedMonitorVariant={selectedMonitorVariant}
            summaries={monitorSummaries}
            summaryMode={monitorSummaryMode}
            paperSummary={monitorPaperSummary}
            thresholdAggregate={monitorThresholdAggregate}
          />
        ) : null}

        {currentView === "hours" ? (
          <OrderHoursPanel
            currentQuery={currentQuery}
            hourPage={orderSnapshot.hourPage}
            runtimeStates={orderSnapshot.runtimeStates}
            summary={orderSnapshot.summary}
          />
        ) : null}

        {currentView === "orders" ? (
          <OrderDetailsSection
            currentQuery={currentQuery}
            orderPage={orderSnapshot.orderPage}
            summary={orderSnapshot.summary}
          />
        ) : null}

        {currentView === "settlements" ? (
          <SettlementLogsSectionPanel
            currentQuery={currentQuery}
            settlementPage={orderSnapshot.settlementPage}
            settlementSummary={orderSnapshot.settlementSummary}
          />
        ) : null}
      </div>
    </main>
  );
}
