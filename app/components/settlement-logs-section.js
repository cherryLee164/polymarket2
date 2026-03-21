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

function formatMoney(value, digits = 3) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "--";
  }
  const sign = numeric > 0 ? "+" : "";
  return `${sign}$${numeric.toFixed(digits)}`;
}

function formatCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatShares(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "--";
  }
  return `${numeric.toFixed(3)} 份`;
}

function formatSellPrice(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "--";
  }
  return `${(numeric * 100).toFixed(1)}c`;
}

function renderPanelHeader(kicker, title, description) {
  return (
    <div className="max-w-3xl">
      <p className="font-display text-xs uppercase tracking-[0.4em] text-[var(--ink-soft)]">
        {kicker}
      </p>
      <h2 className="font-display mt-3 text-3xl font-semibold uppercase tracking-[0.08em] text-neutral-950">
        {title}
      </h2>
      <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">{description}</p>
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

function getStatusMeta(status) {
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
  return {
    label: "记录",
    className:
      "inline-flex rounded-full bg-[rgba(17,17,17,0.08)] px-3 py-1 text-xs font-semibold text-neutral-700",
  };
}

function renderSellItems(items) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) {
    return <span className="text-[var(--ink-soft)]">--</span>;
  }
  return (
    <div className="space-y-2">
      {rows.slice(0, 2).map((item) => (
        <div key={`${item.slug}-${item.outcome}-${item.orderId ?? item.txHash ?? "row"}`} className="text-xs leading-5 text-neutral-800">
          <p className="font-medium text-neutral-950">
            {(item.slug ?? item.title ?? "--") + (item.outcome ? ` / ${item.outcome}` : "")}
          </p>
          <p className="text-[var(--ink-soft)]">
            {formatShares(item.shares)} · {formatSellPrice(item.sellPrice)}
            {item.realizedUsd !== null && item.realizedUsd !== undefined
              ? ` · 回款 ${formatMoney(item.realizedUsd)}`
              : ""}
          </p>
        </div>
      ))}
    </div>
  );
}

export function SettlementLogsSectionPanel({
  currentQuery,
  settlementPage,
  settlementSummary,
}) {
  return (
    <section className="rounded-[2rem] border border-[var(--line)] bg-[var(--panel-strong)] p-6 shadow-[var(--shadow)]">
      {renderPanelHeader(
        "Settlement log",
        "结算日志",
        "这里只保留真正发生的结算动作记录。等待扫描、启动信息、待处理轮询不再展示。",
      )}

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {renderMetricCard(
          "最近余额",
          settlementSummary?.latestBalanceUsd !== null && settlementSummary?.latestBalanceUsd !== undefined
            ? formatMoney(settlementSummary.latestBalanceUsd)
            : "--",
          settlementSummary?.latestLoggedAt
            ? `最近结算：${formatDateTime(settlementSummary.latestLoggedAt)}`
            : "暂无结算记录",
          "accent",
        )}
        {renderMetricCard(
          "卖出记录",
          formatCount(settlementSummary?.soldCycles ?? 0),
          `${formatCount(settlementSummary?.cycleCount ?? 0)} 条结算日志`,
          "up",
        )}
        {renderMetricCard(
          "领取记录",
          formatCount(settlementSummary?.claimCycles ?? 0),
          "当前只统计真实领取完成记录",
          "neutral",
        )}
      </div>

      <div className="mt-8 overflow-x-auto rounded-[1.5rem] border border-[var(--line)] bg-white/72">
        <table className="min-w-full text-sm">
          <thead className="text-left text-[var(--ink-soft)]">
            <tr>
              <th className="px-5 pb-4 pt-5 font-medium">时间</th>
              <th className="px-3 pb-4 pt-5 font-medium">状态</th>
              <th className="px-3 pb-4 pt-5 font-medium">成交明细</th>
              <th className="px-3 pb-4 pt-5 font-medium">余额变化</th>
              <th className="px-5 pb-4 pt-5 font-medium">说明</th>
            </tr>
          </thead>
          <tbody>
            {settlementPage.items.length ? (
              settlementPage.items.map((entry) => {
                const statusMeta = getStatusMeta(entry.status);
                const delta = Number(entry.balanceDeltaUsd ?? 0);
                return (
                  <tr key={entry.id} className="border-t border-[var(--line)]">
                    <td className="px-5 py-4 whitespace-nowrap">
                      {formatDateTime(entry.loggedAt)}
                    </td>
                    <td className="px-3 py-4">
                      <span className={statusMeta.className}>{statusMeta.label}</span>
                    </td>
                    <td className="px-3 py-4">{renderSellItems(entry.soldItems)}</td>
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
                      <div className="max-w-[34rem] text-sm leading-6 text-neutral-950">
                        {entry.message}
                      </div>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td className="px-5 py-8 text-[var(--ink-soft)]" colSpan={5}>
                  当前还没有真实结算记录。
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
