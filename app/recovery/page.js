import Link from "next/link";

import { RecoveryControls } from "@/app/components/recovery-controls";
import { getRecoverySnapshot } from "@/lib/recovery-data";

export const dynamic = "force-dynamic";

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatUsd(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "--";
  }
  const sign = numeric > 0 ? "+" : "";
  return `${sign}$${numeric.toFixed(3)}`;
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

function formatWindow(start, end) {
  return `${formatDateTime(start)} -> ${formatDateTime(end)}`;
}

function formatDate(value) {
  const [year, month, day] = String(value || "").split("-");
  if (!year || !month || !day) {
    return value || "--";
  }
  return `${year}/${month}/${day}`;
}

function formatShortDate(value) {
  const [, month, day] = String(value || "").split("-");
  if (!month || !day) {
    return value || "--";
  }
  return `${month}/${day}`;
}

function toneClass(value) {
  const numeric = Number(value);
  if (numeric > 0) {
    return "text-[var(--signal-up)]";
  }
  if (numeric < 0) {
    return "text-[var(--signal-down)]";
  }
  return "text-neutral-950";
}

function formatSide(value) {
  if (value === "up") {
    return "看涨";
  }
  if (value === "down") {
    return "看跌";
  }
  return "--";
}

function formatStatus(value) {
  const map = {
    active: "运行中",
    paused: "冷却中",
    stopped: "已停止",
    watching: "观察中",
    live: "进行中",
    resolved: "已结算",
    skipped: "已跳过",
    "late-no-entry": "超时未进场",
    "ended-no-entry": "整窗未进场",
    "paused-skip": "暂停跳过",
    "balance-skip": "余额跳过",
    "awaiting-resolution": "等待结算",
    "waiting-retry": "等待重试",
    matched: "已成交",
    placing: "下单中",
    idle: "未启动",
    "unfilled-no-retry": "未成交",
    "limit-open": "限价挂单中",
    "waiting-start-delay": "等待挂单窗口",
    "prestart-entry-window-closed": "预挂窗口关闭",
    "external-position-skip": "外部仓位干扰",
  };
  return map[value] || value || "--";
}

function formatReason(value) {
  const map = {
    "bankroll-cooldown": "本轮本金已亏完，冷却后重开",
    "max-tranches-exhausted": "三轮本金已用完",
    "wallet-balance-below-minimum-4.00": "钱包余额低于 $4",
    "first-entry-deadline-passed": "首单超过半窗",
    "window-ended-no-entry": "整窗未触发进场",
    "entry-window-closed": "进场窗口关闭",
    "prestart-entry-window-closed": "预挂单窗口关闭",
    "limit-order-failed-waiting-retry": "限价挂单失败，等待重试",
    "trigger-order-failed-waiting-retry": "40c 触发下单失败，等待重试",
    "market-top-up-failed-waiting-retry": "补单失败，等待重试",
    "external-position-interference": "检测到外部手动仓位",
  };
  return map[value] || value || "--";
}

function formatTriggerType(value) {
  const map = {
    "limit-pair": "限价双边",
    "trigger-threshold": "40c 触发",
  };
  return map[value] || value || "--";
}

function formatPlacedSides(source) {
  const upPlaced = Boolean(source?.upPlaced ?? source?.orders?.up?.placed);
  const downPlaced = Boolean(source?.downPlaced ?? source?.orders?.down?.placed);
  const sides = [];
  if (upPlaced) {
    sides.push("看涨");
  }
  if (downPlaced) {
    sides.push("看跌");
  }
  return sides.length ? sides.join(" / ") : "--";
}

function formatVariantLabel(value) {
  const map = {
    "4h": "4小时",
    "1h": "1小时",
    "15m": "15分钟",
  };
  return map[value] || value || "--";
}

function MetricCard({ label, value, helper }) {
  return (
    <article className="rounded-[1.8rem] border border-[var(--line)] bg-[var(--panel)] px-5 py-5 shadow-[var(--shadow)]">
      <p className="text-sm text-[var(--ink-soft)]">{label}</p>
      <div className={`mt-3 text-4xl font-semibold ${toneClass(value)}`}>{formatUsd(value)}</div>
      <p className="mt-3 text-sm text-[var(--ink-soft)]">{helper}</p>
    </article>
  );
}

function DailyPnlStrip({ title, rows }) {
  return (
    <section className="rounded-[2rem] border border-[var(--line)] bg-[var(--panel)] p-5 shadow-[var(--shadow)]">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="font-display text-xs uppercase tracking-[0.38em] text-[var(--ink-soft)]">Daily PnL</p>
          <h2 className="mt-3 text-2xl font-semibold text-neutral-950">{title}</h2>
        </div>
        <p className="text-sm text-[var(--ink-soft)]">最近 7 天，按已结算事件统计</p>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
        {rows.map((row) => (
          <article
            key={row.date}
            className="rounded-[1.4rem] border border-[var(--line)] bg-[rgba(255,255,255,0.72)] px-4 py-4"
          >
            <p className="text-sm text-[var(--ink-soft)]">{formatShortDate(row.date)}</p>
            <div className={`mt-2 text-2xl font-semibold ${toneClass(row.pnlUsd)}`}>{formatUsd(row.pnlUsd)}</div>
            <p className="mt-2 text-sm text-[var(--ink-soft)]">
              {formatDate(row.date)}，{row.events || 0} 笔
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}

export default async function RecoveryPage() {
  const snapshot = await getRecoverySnapshot();
  const pnlSummary = snapshot.pnlSummary || {};
  const eventRows = snapshot.eventRows || [];
  const tradeRows = snapshot.tradeRows || [];
  const dailyBreakdown = pnlSummary.dailyBreakdown || [];

  return (
    <main className="min-h-screen bg-[var(--background)] px-4 py-6 text-[var(--ink)] sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1680px] space-y-6">
        <header className="rounded-[2.2rem] border border-[var(--line)] bg-[var(--panel)] px-6 py-6 shadow-[var(--shadow)]">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="font-display text-xs uppercase tracking-[0.42em] text-[var(--ink-soft)]">
                Recovery Surface
              </p>
              <h1 className="font-display mt-4 text-5xl font-semibold tracking-[0.06em]">
                4 小时恢复页
              </h1>
              <p className="mt-4 max-w-4xl text-base leading-8 text-[var(--ink-soft)]">
                这里保留 BTC recovery 的核心盈亏、模式设置和事件台账。
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link
                href="/"
                className="rounded-full border border-[var(--line)] px-5 py-3 text-sm font-semibold text-[var(--ink)]"
              >
                返回首页
              </Link>
              <Link
                href="/api/recovery"
                className="rounded-full bg-[linear-gradient(135deg,var(--accent),var(--accent-strong))] px-5 py-3 text-sm font-semibold text-[var(--accent-ink)] shadow-[0_12px_30px_rgba(184,87,38,0.22)]"
              >
                /api/recovery
              </Link>
            </div>
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-3">
          <MetricCard label="总盈亏" value={pnlSummary.totalPnlUsd} helper="所有已结算事件累计" />
          <MetricCard
            label="今日盈亏"
            value={pnlSummary.todayPnlUsd}
            helper={`${pnlSummary.todayKey || "--"}，${pnlSummary.todayEvents || 0} 笔已结算`}
          />
          <MetricCard
            label="7 天盈亏"
            value={pnlSummary.sevenDayPnlUsd}
            helper={`${pnlSummary.sevenDayStartKey || "--"} 至 ${pnlSummary.todayKey || "--"}`}
          />
        </section>

        <DailyPnlStrip title="BTC 近 7 天逐日收益" rows={dailyBreakdown} />

        <RecoveryControls config={snapshot.config} serviceStatus={snapshot.serviceStatus} />

        <section className="rounded-[2rem] border border-[var(--line)] bg-[var(--panel)] p-6 shadow-[var(--shadow)]">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="font-display text-xs uppercase tracking-[0.4em] text-[var(--ink-soft)]">Events</p>
              <h2 className="font-display mt-3 text-3xl font-semibold tracking-[0.08em]">事件台账</h2>
            </div>
            <p className="text-sm text-[var(--ink-soft)]">最近 80 条事件记录</p>
          </div>
          <div className="mt-6 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-[var(--ink-soft)]">
                <tr>
                  <th className="px-3 py-3 font-medium">时间窗</th>
                  <th className="px-3 py-3 font-medium">周期</th>
                  <th className="px-3 py-3 font-medium">状态</th>
                  <th className="px-3 py-3 font-medium">方向</th>
                  <th className="px-3 py-3 font-medium">投入</th>
                  <th className="px-3 py-3 font-medium">盈亏</th>
                  <th className="px-3 py-3 font-medium">原因</th>
                </tr>
              </thead>
              <tbody>
                {eventRows.map((row) => (
                  <tr
                    key={`${row.variant}:${row.eventKey}:${row.finalizedAt || row.sortMs || row.slug}`}
                    className="border-t border-[var(--line)] align-top"
                  >
                    <td className="px-3 py-4">
                      <div className="font-semibold">{row.slug}</div>
                      <div className="mt-1 text-[var(--ink-soft)]">{formatWindow(row.eventStart, row.eventEnd)}</div>
                    </td>
                    <td className="px-3 py-4">{formatVariantLabel(row.variant)}</td>
                    <td className="px-3 py-4">{formatStatus(row.status)}</td>
                    <td className="px-3 py-4">{formatPlacedSides(row)}</td>
                    <td className="px-3 py-4">{formatUsd(row.spentUsd)}</td>
                    <td className={`px-3 py-4 font-semibold ${toneClass(row.pnlUsd)}`}>{formatUsd(row.pnlUsd)}</td>
                    <td className="px-3 py-4 text-[var(--ink-soft)]">{formatReason(row.statusReason)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-[2rem] border border-[var(--line)] bg-[var(--panel)] p-6 shadow-[var(--shadow)]">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="font-display text-xs uppercase tracking-[0.4em] text-[var(--ink-soft)]">Trades</p>
              <h2 className="font-display mt-3 text-3xl font-semibold tracking-[0.08em]">下单台账</h2>
            </div>
            <p className="text-sm text-[var(--ink-soft)]">最近 120 条成交记录</p>
          </div>
          <div className="mt-6 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-[var(--ink-soft)]">
                <tr>
                  <th className="px-3 py-3 font-medium">时间</th>
                  <th className="px-3 py-3 font-medium">周期</th>
                  <th className="px-3 py-3 font-medium">方向</th>
                  <th className="px-3 py-3 font-medium">触发</th>
                  <th className="px-3 py-3 font-medium">状态</th>
                  <th className="px-3 py-3 font-medium">观察 / 阈值</th>
                  <th className="px-3 py-3 font-medium">成本</th>
                  <th className="px-3 py-3 font-medium">份额</th>
                </tr>
              </thead>
              <tbody>
                {tradeRows.map((row) => (
                  <tr
                    key={`${row.variant}:${row.eventKey}:${row.side}:${row.orderId || row.placedAt || row.sortMs}`}
                    className="border-t border-[var(--line)] align-top"
                  >
                    <td className="px-3 py-4">{formatDateTime(row.placedAt)}</td>
                    <td className="px-3 py-4">{formatVariantLabel(row.variant)}</td>
                    <td className="px-3 py-4">{formatSide(row.side)}</td>
                    <td className="px-3 py-4">{formatTriggerType(row.triggerType)}</td>
                    <td className="px-3 py-4">{formatStatus(row.status)}</td>
                    <td className="px-3 py-4">
                      {row.triggerCents ?? "--"} / {row.thresholdCents ?? "--"}
                    </td>
                    <td className="px-3 py-4">{formatUsd(row.spentUsd)}</td>
                    <td className="px-3 py-4">{Number(row.sharesBought || 0).toFixed(6)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
