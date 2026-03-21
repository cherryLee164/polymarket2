import Link from "next/link";

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

function formatVariant(value) {
  const text = String(value ?? "").toLowerCase();
  if (text === "4h" || text.startsWith("btc-updown-4h-")) {
    return "4H";
  }
  if (text === "5m" || text.startsWith("btc-updown-5m-")) {
    return "5M";
  }
  if (text === "1h" || text.startsWith("bitcoin-up-or-down-")) {
    return "1H";
  }
  return String(value ?? "--").toUpperCase();
}

function getVariantSummary(summary, variant) {
  return (
    summary?.byVariant?.[variant] ?? {
      label: formatVariant(variant),
      hoursWithOrders: 0,
      settledHours: 0,
      totalNetPnlUsd: 0,
      today: { netPnlUsd: 0, hours: 0 },
    }
  );
}

function formatRuntimeStates(runtimeStates) {
  const rows = Array.isArray(runtimeStates) ? runtimeStates : [];
  if (!rows.length) {
    return {
      title: "暂无",
      helper: "当前没有运行中的下单进程",
    };
  }
  return {
    title: rows.map((row) => row?.label ?? formatVariant(row?.variant)).join(" / "),
    helper: rows
      .slice(0, 2)
      .map((row) => `${row?.label ?? formatVariant(row?.variant)}：${row?.slug ?? "--"}`)
      .join(" | "),
  };
}

function formatMonitorVariant(target) {
  return formatVariant(target?.monitorVariant ?? target?.slug ?? target);
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

  if (sameDay) {
    const exactHourBoundary =
      startDate.getMinutes() === 0 &&
      startDate.getSeconds() === 0 &&
      endDate.getMinutes() === 0 &&
      endDate.getSeconds() === 0;
    if (exactHourBoundary) {
      return `${DATE_FORMATTER.format(startDate)} ${startDate.getHours()}点到${endDate.getHours()}点`;
    }
    return `${DATE_FORMATTER.format(startDate)} ${CLOCK_FORMATTER.format(startDate)}到${CLOCK_FORMATTER.format(endDate)}`;
  }

  return `${DATE_FORMATTER.format(startDate)} ${CLOCK_FORMATTER.format(startDate)} -> ${DATE_FORMATTER.format(endDate)} ${CLOCK_FORMATTER.format(endDate)}`;
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

function renderMetricCard(label, value, helper, tone = "neutral") {
  const toneClass = {
    neutral: "text-neutral-950",
    accent: "text-[var(--accent-strong)]",
    up: "text-[var(--signal-up)]",
    down: "text-[var(--signal-down)]",
  }[tone];

  return (
    <article className="rounded-[2rem] border border-[var(--line)] bg-[var(--panel)] p-5 shadow-[var(--shadow)] backdrop-blur">
      <p className="text-xs uppercase tracking-[0.3em] text-[var(--ink-soft)]">{label}</p>
      <p className={`font-display mt-4 text-4xl font-semibold uppercase ${toneClass}`}>{value}</p>
      <p className="mt-2 text-sm text-[var(--ink-soft)]">{helper}</p>
    </article>
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

function renderHourStatus(hour) {
  const resolved = hour?.settlementStatus === "resolved";
  return (
    <span
      className={
        resolved
          ? "inline-flex rounded-full bg-[rgba(22,122,82,0.12)] px-3 py-1 text-xs font-semibold text-[var(--signal-up)]"
          : "inline-flex rounded-full bg-[rgba(17,17,17,0.08)] px-3 py-1 text-xs font-semibold text-neutral-700"
      }
    >
      {resolved ? "已结算" : "待结算"}
    </span>
  );
}

export function OverviewPanel({
  orderSnapshot,
  monitorSummaries,
  orderHours,
}) {
  const summary = orderSnapshot.summary;
  const hourSummary = getVariantSummary(summary, "1h");
  const fourHourSummary = getVariantSummary(summary, "4h");
  const runtimeSummary = formatRuntimeStates(orderSnapshot.runtimeStates);

  return (
    <section className="rounded-[2rem] border border-[var(--line)] bg-[var(--panel-strong)] p-6 shadow-[var(--shadow)]">
      {renderPanelHeader(
        "Unified desk",
        "后台总览",
        "这里继续作为统一后台入口。收益统计现在按 1H 和 4H 分开，订单明细页仍然保留混合展示。",
      )}

      <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {renderMetricCard(
          "今日总净值",
          formatMoney(summary?.today?.netPnlUsd ?? 0),
          `${summary?.today?.hours ?? 0} 个已结算窗口`,
          Number(summary?.today?.netPnlUsd ?? 0) >= 0 ? "up" : "down",
        )}
        {renderMetricCard(
          "1H 累计净值",
          formatMoney(hourSummary?.totalNetPnlUsd ?? 0),
          `${hourSummary?.settledHours ?? 0}/${hourSummary?.hoursWithOrders ?? 0} 个小时`,
          Number(hourSummary?.totalNetPnlUsd ?? 0) >= 0 ? "accent" : "down",
        )}
        {renderMetricCard(
          "4H 累计净值",
          formatMoney(fourHourSummary?.totalNetPnlUsd ?? 0),
          `${fourHourSummary?.settledHours ?? 0}/${fourHourSummary?.hoursWithOrders ?? 0} 个四小时`,
          Number(fourHourSummary?.totalNetPnlUsd ?? 0) >= 0 ? "up" : "down",
        )}
        {renderMetricCard("运行中的策略", runtimeSummary.title, runtimeSummary.helper)}
      </div>

      <div className="mt-8 grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <section className="rounded-[1.75rem] border border-[var(--line)] bg-white/70 p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">Monitor</p>
              <h3 className="font-display mt-2 text-2xl uppercase tracking-[0.06em]">最近监控结果</h3>
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
                {monitorSummaries.slice(0, 6).map((summaryRow) => (
                  <tr key={summaryRow.runId ?? summaryRow.fileName} className="border-t border-[var(--line)]">
                    <td className="py-3 pr-4 whitespace-nowrap">
                      {`${formatDateTime(summaryRow.eventStart)} -> ${formatDateTime(summaryRow.eventEnd)}`}
                    </td>
                    <td className="py-3 pr-3 uppercase">{formatMonitorVariant(summaryRow)}</td>
                    <td className="py-3 pr-3">{summaryRow?.thresholds?.up?.lt45 ? "达到" : "未达"}</td>
                    <td className="py-3 pr-3">{summaryRow?.thresholds?.up?.lt40 ? "达到" : "未达"}</td>
                    <td className="py-3 pr-3">{summaryRow?.thresholds?.down?.lt45 ? "达到" : "未达"}</td>
                    <td className="py-3">{summaryRow?.thresholds?.down?.lt40 ? "达到" : "未达"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-[1.75rem] border border-[var(--line)] bg-white/70 p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">Trading</p>
              <h3 className="font-display mt-2 text-2xl uppercase tracking-[0.06em]">最近下单窗口</h3>
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
              <article key={hour.hourKey} className="rounded-[1.25rem] border border-[var(--line)] bg-white/78 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">
                      {formatVariant(hour.variant)}
                    </p>
                    <p className="mt-1 font-medium text-neutral-950">{formatWindowLabel(hour.eventStart, hour.eventEnd)}</p>
                    <p className="mt-2 text-sm text-[var(--ink-soft)]">
                      {hour.placedSides?.join(" / ") || "--"} · 赢方 {hour.winnerSide ?? "--"}
                    </p>
                  </div>
                  <div className="text-right">
                    <p
                      className={
                        Number(hour.netPnlUsd ?? 0) >= 0
                          ? "font-display text-2xl font-semibold text-[var(--signal-up)]"
                          : "font-display text-2xl font-semibold text-[var(--signal-down)]"
                      }
                    >
                      {formatMoney(hour.netPnlUsd ?? 0)}
                    </p>
                    <p className="mt-1 text-sm text-[var(--ink-soft)]">
                      投入 {formatMoney(hour.totalSpentUsd ?? 0)} · 回收 {formatMoney(hour.totalPayoutUsd ?? 0)}
                    </p>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}

export function OrderHoursPanel({ currentQuery, summary, runtimeStates, hourPage }) {
  const hourSummary = getVariantSummary(summary, "1h");
  const fourHourSummary = getVariantSummary(summary, "4h");

  return (
    <section className="rounded-[2rem] border border-[var(--line)] bg-[var(--panel-strong)] p-6 shadow-[var(--shadow)]">
      {renderPanelHeader(
        "Settled windows",
        "下单窗口汇总",
        "这里继续看每个下单窗口的汇总，顶部收益现在拆成 1H 和 4H 两套；订单明细页保持混合展示。",
      )}

      <div className="mt-6 grid gap-4 md:grid-cols-4">
        {renderMetricCard(
          "1H 净值",
          formatMoney(hourSummary?.totalNetPnlUsd ?? 0),
          `${hourSummary?.settledHours ?? 0}/${hourSummary?.hoursWithOrders ?? 0} 个小时`,
          Number(hourSummary?.totalNetPnlUsd ?? 0) >= 0 ? "accent" : "down",
        )}
        {renderMetricCard(
          "4H 净值",
          formatMoney(fourHourSummary?.totalNetPnlUsd ?? 0),
          `${fourHourSummary?.settledHours ?? 0}/${fourHourSummary?.hoursWithOrders ?? 0} 个四小时`,
          Number(fourHourSummary?.totalNetPnlUsd ?? 0) >= 0 ? "up" : "down",
        )}
        {renderMetricCard(
          "今日总净值",
          formatMoney(summary?.today?.netPnlUsd ?? 0),
          `${summary?.today?.hours ?? 0} 个已结算窗口`,
          Number(summary?.today?.netPnlUsd ?? 0) >= 0 ? "up" : "down",
        )}
        {renderMetricCard(
          "运行中的策略",
          formatRuntimeStates(runtimeStates).title,
          formatRuntimeStates(runtimeStates).helper,
        )}
      </div>

      <div className="mt-8 overflow-x-auto rounded-[1.5rem] border border-[var(--line)] bg-white/72">
        <table className="min-w-full text-sm">
          <thead className="text-left text-[var(--ink-soft)]">
            <tr>
              <th className="px-5 pb-4 pt-5 font-medium">时间区间</th>
              <th className="px-3 pb-4 pt-5 font-medium">周期</th>
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
                  <td className="px-5 py-4 whitespace-nowrap">{formatWindowLabel(hour.eventStart, hour.eventEnd)}</td>
                  <td className="px-3 py-4 uppercase">{formatVariant(hour.variant)}</td>
                  <td className="px-3 py-4 uppercase">{hour.placedSides?.join(" / ") || "--"}</td>
                  <td className="px-3 py-4">{renderHourStatus(hour)}</td>
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
                <td className="px-5 py-8 text-[var(--ink-soft)]" colSpan={8}>
                  当前还没有任何下单窗口记录。
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
