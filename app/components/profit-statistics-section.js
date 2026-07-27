"use client";

import { useMemo, useState } from "react";

function formatMoney(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "--";
  }
  const sign = numeric > 0 ? "+" : "";
  return `${sign}$${numeric.toFixed(digits)}`;
}

function formatBalance(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "--";
  }
  return `$${numeric.toFixed(digits)}`;
}

function formatDate(ymd) {
  const [, month, day] = String(ymd || "").split("-");
  if (!month || !day) {
    return ymd || "--";
  }
  return `${month}/${day}`;
}

function toneClass(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) {
    return "text-[var(--ink-soft)]";
  }
  return numeric > 0 ? "text-[var(--signal-up)]" : "text-[var(--signal-down)]";
}

function monthLabel(month) {
  const [, mm] = String(month || "").split("-");
  if (!mm) return month || "--";
  return `${Number(mm)}月`;
}

export function ProfitStatisticsSection({ profitSnapshots }) {
  const months = profitSnapshots?.months || [];
  const [activeMonth, setActiveMonth] = useState(months[0]?.month || "");

  const currentGroup = useMemo(() => {
    if (!activeMonth) return null;
    return months.find((item) => item.month === activeMonth) || null;
  }, [months, activeMonth]);

  const latestBalance = profitSnapshots?.latestBalance ?? null;
  const latestDate = profitSnapshots?.latestDate ?? null;

  if (!months.length) {
    return (
      <section className="rounded-[1.6rem] border border-[var(--line)] bg-[var(--panel)] p-6 shadow-[var(--shadow)]">
        <h3 className="font-display text-2xl font-semibold text-neutral-950">月/天收益统计</h3>
        <p className="mt-3 text-sm text-[var(--ink-soft)]">暂无余额快照数据</p>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="rounded-[1.6rem] border border-[var(--line)] bg-[rgba(255,255,255,0.74)] p-5 shadow-[var(--shadow)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">最新余额</p>
            <p className="mt-1 font-display text-3xl font-semibold text-neutral-950">
              {formatBalance(latestBalance)}
            </p>
            {latestDate ? (
              <p className="mt-1 text-xs text-[var(--ink-soft)]">截至 {formatDate(latestDate)}</p>
            ) : null}
          </div>
          <div className="text-right">
            <p className="text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">总记录天数</p>
            <p className="mt-1 font-display text-3xl font-semibold text-neutral-950">
              {profitSnapshots?.totalRecords || 0}
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {months.map((item) => {
          const active = item.month === activeMonth;
          return (
            <button
              key={item.month}
              type="button"
              onClick={() => setActiveMonth(item.month)}
              className={`rounded-full px-5 py-2 text-sm font-semibold transition ${
                active
                  ? "bg-[linear-gradient(135deg,var(--accent),var(--accent-strong))] text-[var(--accent-ink)] shadow-[0_12px_30px_rgba(184,87,38,0.18)]"
                  : "border border-[var(--line)] bg-[rgba(255,255,255,0.64)] text-neutral-800 hover:border-[var(--accent-strong)] hover:text-[var(--accent-strong)]"
              }`}
            >
              {monthLabel(item.month)}
            </button>
          );
        })}
      </div>

      {currentGroup ? (
        <div className="rounded-[1.6rem] border border-[var(--line)] bg-[var(--panel)] p-5 shadow-[var(--shadow)]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] pb-4">
            <div>
              <h3 className="font-display text-2xl font-semibold text-neutral-950">
                {monthLabel(currentGroup.month)} 收益明细
              </h3>
              <p className="mt-1 text-xs text-[var(--ink-soft)]">
                共 {currentGroup.days} 天 · 起始 {formatBalance(currentGroup.startBalanceUsd)} · 截止 {formatBalance(currentGroup.endBalanceUsd)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">月度收益</p>
              <p className={`mt-1 font-display text-2xl font-semibold ${toneClass(currentGroup.totalPnlUsd)}`}>
                {formatMoney(currentGroup.totalPnlUsd)}
              </p>
            </div>
          </div>

          <div className="mt-4 max-h-[560px] overflow-y-auto rounded-[1rem] border border-[var(--line)]">
            <table className="min-w-full text-left text-sm">
              <thead className="sticky top-0 bg-[rgba(246,236,216,0.55)] text-xs text-[var(--ink-soft)]">
                <tr>
                  <th className="px-4 py-3 font-medium">日期</th>
                  <th className="px-4 py-3 font-medium">余额</th>
                  <th className="px-4 py-3 font-medium">当日收益</th>
                  <th className="px-4 py-3 font-medium">数据来源</th>
                </tr>
              </thead>
              <tbody>
                {currentGroup.items.map((item) => (
                  <tr key={item.date} className="border-t border-[var(--line)]">
                    <td className="px-4 py-3 font-medium text-neutral-950">{formatDate(item.date)}</td>
                    <td className="px-4 py-3 text-[var(--ink-soft)]">{formatBalance(item.amount)}</td>
                    <td className={`px-4 py-3 font-semibold ${toneClass(item.pnlUsd)}`}>
                      {item.pnlUsd == null ? "--" : formatMoney(item.pnlUsd)}
                    </td>
                    <td className="px-4 py-3 text-xs text-[var(--ink-soft)]">
                      {item.status === "confirmed" ? "已确认" : "待确认"}
                      {item.source ? ` · ${item.source}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
