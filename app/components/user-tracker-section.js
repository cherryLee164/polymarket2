"use client";

import { useState, useEffect, useCallback, useMemo } from "react";

function formatMoney(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  const sign = n > 0 ? "+" : "";
  return `${sign}$${n.toFixed(digits)}`;
}

function formatBalance(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  return `$${n.toFixed(digits)}`;
}

function formatTime(iso) {
  if (!iso) return "--";
  const d = new Date(iso);
  const beijing = new Date(d.getTime() + 8 * 3600 * 1000);
  return beijing.toISOString().slice(5, 16).replace("T", " ");
}

function formatDate(ymd) {
  const [, month, day] = String(ymd || "").split("-");
  if (!month || !day) return ymd || "--";
  return `${month}/${day}`;
}

function toneClass(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "text-[var(--ink-soft)]";
  return n > 0 ? "text-[var(--signal-up)]" : "text-[var(--signal-down)]";
}

function monthLabel(month) {
  const [, mm] = String(month || "").split("-");
  if (!mm) return month || "--";
  return `${Number(mm)}月`;
}

function extractCity(title) {
  if (!title) return "--";
  const match = title.match(/temperature in (.+?) (?:be|on)/i);
  if (match) return match[1];
  return title.slice(0, 30);
}

export function UserTrackerSection() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/user-tracker", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "请求失败");
      setData(json);
      setError("");
    } catch (err) {
      setError(err?.message || "请求失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, 60000);
    return () => clearInterval(timer);
  }, [fetchData]);

  const snapshots = data?.snapshots;
  const months = snapshots?.months || [];
  const tracks = data?.tracks || [];
  const todaySummary = data?.todaySummary;

  const [activeMonth, setActiveMonth] = useState("");

  const currentGroup = useMemo(() => {
    if (!activeMonth || !months.length) return null;
    return months.find((m) => m.month === activeMonth) || months[0] || null;
  }, [months, activeMonth]);

  useEffect(() => {
    if (months.length && !activeMonth) {
      setActiveMonth(months[0].month);
    }
  }, [months, activeMonth]);

  if (loading) {
    return (
      <section className="rounded-[1.6rem] border border-[var(--line)] bg-[var(--panel)] p-6 shadow-[var(--shadow)]">
        <h3 className="font-display text-2xl font-semibold text-neutral-950">用户追踪</h3>
        <p className="mt-3 text-sm text-[var(--ink-soft)]">加载中...</p>
      </section>
    );
  }

  if (error && !data) {
    return (
      <section className="rounded-[1.6rem] border border-[var(--line)] bg-[var(--panel)] p-6 shadow-[var(--shadow)]">
        <h3 className="font-display text-2xl font-semibold text-neutral-950">用户追踪</h3>
        <p className="mt-3 text-sm text-[var(--signal-down)]">{error}</p>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      {/* 概览卡片 */}
      <div className="rounded-[1.6rem] border border-[var(--line)] bg-[rgba(255,255,255,0.74)] p-5 shadow-[var(--shadow)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">追踪用户</p>
            <p className="mt-1 font-display text-2xl font-semibold text-neutral-950">
              @{data?.user?.name || "unknown"}
            </p>
            <p className="mt-1 text-xs text-[var(--ink-soft)]">
              {data?.user?.address?.slice(0, 10)}...{data?.user?.address?.slice(-6)}
            </p>
          </div>
          <div className="flex flex-wrap gap-6">
            <div className="text-right">
              <p className="text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">持仓价值</p>
              <p className="mt-1 font-display text-2xl font-semibold text-neutral-950">
                {formatBalance(snapshots?.latestBalance)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">总投入</p>
              <p className="mt-1 font-display text-2xl font-semibold text-neutral-950">
                {formatBalance(snapshots?.latestInvested)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">持仓数</p>
              <p className="mt-1 font-display text-2xl font-semibold text-neutral-950">
                {snapshots?.latestPositionCount ?? "--"}
              </p>
            </div>
          </div>
        </div>
        {todaySummary ? (
          <div className="mt-4 flex flex-wrap gap-4 border-t border-[var(--line)] pt-3 text-sm text-[var(--ink-soft)]">
            <span>今日交易: {todaySummary.tradeCount} 笔</span>
            <span>今日买入: {formatBalance(todaySummary.invested)}</span>
            <span>今日卖出: {formatBalance(todaySummary.sold)}</span>
            <span className="ml-auto text-xs">每60秒自动刷新 · {data?.fetchedAt ? formatTime(data.fetchedAt) : ""}</span>
          </div>
        ) : null}
      </div>

      {/* 月度收益明细 */}
      {months.length > 0 ? (
        <>
          <div className="flex flex-wrap gap-2">
            {months.map((m) => {
              const active = m.month === (currentGroup?.month || activeMonth);
              return (
                <button
                  key={m.month}
                  type="button"
                  onClick={() => setActiveMonth(m.month)}
                  className={`rounded-full px-5 py-2 text-sm font-semibold transition ${
                    active
                      ? "bg-[linear-gradient(135deg,var(--accent),var(--accent-strong))] text-[var(--accent-ink)] shadow-[0_12px_30px_rgba(184,87,38,0.18)]"
                      : "border border-[var(--line)] bg-[rgba(255,255,255,0.64)] text-neutral-800 hover:border-[var(--accent-strong)] hover:text-[var(--accent-strong)]"
                  }`}
                >
                  {monthLabel(m.month)}
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

              <div className="mt-4 max-h-[400px] overflow-y-auto rounded-[1rem] border border-[var(--line)]">
                <table className="min-w-full text-left text-sm">
                  <thead className="sticky top-0 bg-[rgba(246,236,216,0.55)] text-xs text-[var(--ink-soft)]">
                    <tr>
                      <th className="px-4 py-3 font-medium">日期</th>
                      <th className="px-4 py-3 font-medium">持仓价值</th>
                      <th className="px-4 py-3 font-medium">当日收益</th>
                      <th className="px-4 py-3 font-medium">持仓数</th>
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
                        <td className="px-4 py-3 text-xs text-[var(--ink-soft)]">{item.positionCount ?? "--"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <div className="rounded-[1.6rem] border border-[var(--line)] bg-[var(--panel)] p-5 shadow-[var(--shadow)]">
          <p className="text-sm text-[var(--ink-soft)]">暂无快照数据，等待每日 0:10 自动快照</p>
        </div>
      )}

      {/* 最近交易 */}
      <div className="rounded-[1.6rem] border border-[var(--line)] bg-[var(--panel)] p-5 shadow-[var(--shadow)]">
        <h3 className="font-display text-xl font-semibold text-neutral-950">最近交易</h3>
        <div className="mt-3 max-h-[400px] overflow-y-auto rounded-[1rem] border border-[var(--line)]">
          <table className="min-w-full text-left text-sm">
            <thead className="sticky top-0 bg-[rgba(246,236,216,0.55)] text-xs text-[var(--ink-soft)]">
              <tr>
                <th className="px-3 py-2 font-medium">时间</th>
                <th className="px-3 py-2 font-medium">城市</th>
                <th className="px-3 py-2 font-medium">方向</th>
                <th className="px-3 py-2 font-medium">买/卖</th>
                <th className="px-3 py-2 font-medium">数量</th>
                <th className="px-3 py-2 font-medium">金额</th>
                <th className="px-3 py-2 font-medium">价格</th>
              </tr>
            </thead>
            <tbody>
              {tracks.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-4 text-center text-[var(--ink-soft)]">暂无交易记录</td>
                </tr>
              ) : (
                tracks.map((item, idx) => (
                  <tr key={idx} className="border-t border-[var(--line)]">
                    <td className="px-3 py-2 text-xs text-[var(--ink-soft)]">{formatTime(item.time)}</td>
                    <td className="px-3 py-2 font-medium text-neutral-950">{extractCity(item.title)}</td>
                    <td className="px-3 py-2 text-xs">{item.outcome}</td>
                    <td className={`px-3 py-2 text-xs font-semibold ${item.side === "BUY" ? "text-[var(--signal-up)]" : "text-[var(--signal-down)]"}`}>
                      {item.side === "BUY" ? "买入" : "卖出"}
                    </td>
                    <td className="px-3 py-2 text-[var(--ink-soft)]">{item.size}</td>
                    <td className="px-3 py-2 text-[var(--ink-soft)]">{formatBalance(item.usdcSize)}</td>
                    <td className="px-3 py-2 text-[var(--ink-soft)]">{item.price != null ? `$${item.price}` : "--"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
